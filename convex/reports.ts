import { v } from "convex/values";
import { dateKey } from "../lib/attendance/sessions";
import { summariseVisits, visitDurationMs } from "../lib/reports/math";
import { hasSiteAccess } from "./lib/auth";
import { appError } from "./lib/errors";
import { dayBoundsInZone } from "./lib/time";
import { orgQuery } from "./lib/functions";
import {
  byCreated,
  loadAppointmentRows,
  loadAttendance,
  loadOnSite,
  loadVisitRows,
  MAX_ON_SITE,
  MAX_VISITS,
  rangeOrThrow,
  reportScope,
  siteName,
  siteTz,
  staffClockedIn,
} from "./lib/reports";

/**
 * Phase 5 reports. Every query is an `orgQuery` that asserts `reports:read`,
 * applies the caller's site access (and optional site filter), bounds the
 * date range, and caps the rows it reads, returning `truncated` when a cap
 * was hit so the UI can say so instead of showing silently partial totals.
 */
const DEFAULT_ROW_LIMIT = 100;
const MAX_ROW_LIMIT = 500;

const rangeArgs = {
  fromDate: v.string(),
  toDate: v.string(),
  siteId: v.optional(v.id("sites")),
  hostUserId: v.optional(v.id("users")),
  rowLimit: v.optional(v.number()),
};

const rowLimitOf = (n?: number) => Math.min(MAX_ROW_LIMIT, Math.max(10, Math.floor(n ?? DEFAULT_ROW_LIMIT)));

/** Sites and people available to the report filters. */
export const filterOptions = orgQuery({
  args: {},
  handler: async (ctx) => {
    ctx.require("reports:read");
    const scope = await reportScope(ctx);
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_org", (q) => q.eq("organizationId", ctx.oc.org._id))
      .take(300);
    const people = await Promise.all(
      memberships
        .filter((m) => m.status === "active")
        .map(async (m) => {
          const u = await ctx.db.get(m.userId);
          return { userId: m.userId, name: u?.name ?? u?.email ?? "Unknown", role: m.role };
        }),
    );
    return {
      timeZone: ctx.oc.org.timeZone,
      sites: [...scope.sites.entries()].map(([id, s]) => ({ siteId: id, name: s.name })),
      people: people.sort((a, b) => a.name.localeCompare(b.name)),
      canExport: ctx.oc.permissions.has("reports:export"),
    };
  },
});

/** Visit volumes, durations and breakdowns for a date range. */
export const visits = orgQuery({
  args: rangeArgs,
  handler: async (ctx, args) => {
    ctx.require("reports:read");
    const scope = await reportScope(ctx, args.siteId);
    const range = rangeOrThrow(scope, args.fromDate, args.toDate);
    const { rows, truncated } = await loadVisitRows(ctx, scope, range, { hostUserId: args.hostUserId });
    const appointments = await loadAppointmentRows(ctx, scope, range, { hostUserId: args.hostUserId });
    const noShows = appointments.rows.filter((a) => a.outcome === "no_show").length;
    const stats = summariseVisits(
      rows,
      (id) => siteTz(scope, id),
      (id) => siteName(scope, id),
    );
    const limit = rowLimitOf(args.rowLimit);
    return {
      range: { fromDate: range.fromDate, toDate: range.toDate, timeZone: scope.timeZone },
      truncated,
      cap: MAX_VISITS,
      noShows,
      ...stats,
      rowsTotal: rows.length,
      // Contact details (phone, email) are never part of the on-screen report.
      rows: rows.slice(0, limit).map((r) => ({
        id: r.id,
        siteName: siteName(scope, r.siteId),
        timeZone: siteTz(scope, r.siteId),
        visitorName: r.visitorName,
        company: r.company ?? null,
        hostName: r.hostName ?? null,
        purpose: r.purpose,
        status: r.status,
        kind: r.appointmentId ? ("appointment" as const) : ("walk_in" as const),
        createdAt: r.createdAt,
        checkedInAt: r.checkedInAt ?? null,
        checkedOutAt: r.checkedOutAt ?? null,
        meetingEndedAt: r.meetingEndedAt ?? null,
        durationMs: visitDurationMs(r),
        method: r.checkedOutMethod ?? null,
      })),
    };
  },
});

/** Visitors on site now, or (with `at`) on site at that past instant. */
export const onSite = orgQuery({
  args: { siteId: v.optional(v.id("sites")), at: v.optional(v.number()) },
  handler: async (ctx, { siteId, at }) => {
    ctx.require("reports:read");
    const scope = await reportScope(ctx, siteId);
    const now = Date.now();
    if (at !== undefined && (!Number.isFinite(at) || at > now + 5 * 60_000)) {
      throw appError("VALIDATION", "Choose a time that is not in the future.");
    }
    const { rows, truncated } = await loadOnSite(ctx, scope, at);
    const reference = at ?? now;
    return {
      asOf: reference,
      historical: at !== undefined,
      truncated,
      cap: at === undefined ? MAX_ON_SITE : MAX_VISITS,
      rows: rows
        .sort((a, b) => (a.checkedInAt ?? 0) - (b.checkedInAt ?? 0))
        .map((r) => ({
          id: r.id,
          siteName: siteName(scope, r.siteId),
          timeZone: siteTz(scope, r.siteId),
          visitorName: r.visitorName,
          company: r.company ?? null,
          hostName: r.hostName ?? null,
          purpose: r.purpose,
          checkedInAt: r.checkedInAt ?? null,
          onSiteMs: r.checkedInAt !== undefined ? Math.max(0, reference - r.checkedInAt) : null,
        })),
    };
  },
});

/** Appointment outcomes: attended, no-shows, declined, cancelled, upcoming. */
export const appointments = orgQuery({
  args: rangeArgs,
  handler: async (ctx, args) => {
    ctx.require("reports:read");
    const scope = await reportScope(ctx, args.siteId);
    const range = rangeOrThrow(scope, args.fromDate, args.toDate);
    const { rows, truncated } = await loadAppointmentRows(ctx, scope, range, { hostUserId: args.hostUserId });
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
    const decided = (counts.attended ?? 0) + (counts.no_show ?? 0);
    const limit = rowLimitOf(args.rowLimit);
    return {
      range: { fromDate: range.fromDate, toDate: range.toDate, timeZone: scope.timeZone },
      truncated,
      total: rows.length,
      counts,
      attendanceRate: decided > 0 ? (counts.attended ?? 0) / decided : null,
      rows: rows.slice(0, limit).map((r) => ({
        id: r.id,
        siteName: siteName(scope, r.siteId),
        timeZone: siteTz(scope, r.siteId),
        visitorName: r.visitorName,
        hostName: r.hostName ?? null,
        purpose: r.purpose,
        scheduledStart: r.scheduledStart,
        status: r.status,
        outcome: r.outcome,
      })),
    };
  },
});

/** Host meeting proof: who met whom, and when the host confirmed the meeting ended. */
export const hostMeetings = orgQuery({
  args: rangeArgs,
  handler: async (ctx, args) => {
    ctx.require("reports:read");
    const scope = await reportScope(ctx, args.siteId);
    const range = rangeOrThrow(scope, args.fromDate, args.toDate);
    const { rows, truncated } = await loadVisitRows(ctx, scope, range, { hostUserId: args.hostUserId });
    const meetings = rows.filter((r) => r.hostUserId && r.checkedInAt !== undefined);
    const limit = rowLimitOf(args.rowLimit);
    return {
      range: { fromDate: range.fromDate, toDate: range.toDate, timeZone: scope.timeZone },
      truncated,
      total: meetings.length,
      confirmed: meetings.filter((r) => r.meetingEndedAt !== undefined).length,
      rows: meetings.slice(0, limit).map((r) => ({
        id: r.id,
        siteName: siteName(scope, r.siteId),
        timeZone: siteTz(scope, r.siteId),
        hostName: r.hostName ?? null,
        visitorName: r.visitorName,
        company: r.company ?? null,
        purpose: r.purpose,
        checkedInAt: r.checkedInAt ?? null,
        confirmedAt: r.meetingEndedAt ?? null,
        confirmedBy: r.meetingConfirmedBy ?? null,
        meetingMs: r.meetingEndedAt !== undefined && r.checkedInAt !== undefined ? r.meetingEndedAt - r.checkedInAt : null,
      })),
    };
  },
});

/** Hours per person per day, late/absent counts, exceptions and corrections. */
export const attendance = orgQuery({
  args: {
    fromDate: v.string(),
    toDate: v.string(),
    siteId: v.optional(v.id("sites")),
    userId: v.optional(v.id("users")),
    lateAfterMinutes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    ctx.require("reports:read");
    ctx.require("staff_attendance:read_site");
    const scope = await reportScope(ctx, args.siteId);
    const range = rangeOrThrow(scope, args.fromDate, args.toDate, 62);
    const late = args.lateAfterMinutes;
    const { people, truncated } = await loadAttendance(ctx, scope, range, {
      userId: args.userId,
      lateAfterMinutes: late !== undefined && late >= 0 && late < 24 * 60 ? Math.floor(late) : undefined,
    });
    return {
      range: { fromDate: range.fromDate, toDate: range.toDate, timeZone: scope.timeZone },
      truncated,
      people: people.map((p) => ({
        userId: p.userId,
        name: p.name,
        totalMs: p.totalMs,
        daysWorked: p.daysWorked,
        lateCount: p.lateCount,
        absentCount: p.absentDates.length,
        absentDates: p.absentDates,
        exceptions: p.exceptions,
        corrections: p.corrections,
        days: p.days,
      })),
      totals: {
        people: people.length,
        totalMs: people.reduce((n, p) => n + p.totalMs, 0),
        late: people.reduce((n, p) => n + p.lateCount, 0),
        absent: people.reduce((n, p) => n + p.absentDates.length, 0),
        exceptions: people.reduce(
          (n, p) => n + p.exceptions.unclosed + p.exceptions.orphanClockOuts + (p.exceptions.staleOpen ? 1 : 0),
          0,
        ),
        corrections: people.reduce((n, p) => n + p.corrections.approved + p.corrections.pending, 0),
      },
    };
  },
});

/**
 * Today's key numbers for the dashboard. Each figure is null when the caller
 * lacks the permission behind it, so no role sees more than their screens do.
 */
export const today = orgQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const perms = ctx.oc.permissions;
    const scope = await reportScope(ctx);
    const { start, end } = dayBoundsInZone(now, ctx.oc.org.timeZone);
    const orgId = ctx.oc.org._id;
    const out: {
      date: string;
      onSite: number | null;
      expected: number | null;
      checkedInToday: number | null;
      staffIn: number | null;
      capped: boolean;
    } = { date: dateKey(now, ctx.oc.org.timeZone), onSite: null, expected: null, checkedInToday: null, staffIn: null, capped: false };

    if (perms.has("visits:read_site")) {
      let onSite = 0;
      let expectedWalkIns = 0;
      for (const siteId of scope.siteIds) {
        if (!hasSiteAccess(ctx.oc.membership, siteId)) continue;
        const on = await ctx.db
          .query("visits")
          .withIndex("by_site_status", (q) => q.eq("siteId", siteId).eq("status", "on_site"))
          .take(1000);
        const exp = await ctx.db
          .query("visits")
          .withIndex("by_site_status", (q) => q.eq("siteId", siteId).eq("status", "expected"))
          .take(1000);
        onSite += on.length;
        expectedWalkIns += exp.length;
        out.capped ||= on.length === 1000 || exp.length === 1000;
      }
      const { rows: todays, truncated } = await byCreated(
        scope,
        1000,
        (limit) =>
          ctx.db
            .query("visits")
            .withIndex("by_org", (q) => q.eq("organizationId", orgId).gte("createdAt", start).lt("createdAt", end))
            .take(limit),
        (siteId, limit) =>
          ctx.db
            .query("visits")
            .withIndex("by_site_created", (q) => q.eq("siteId", siteId).gte("createdAt", start).lt("createdAt", end))
            .take(limit),
      );
      out.onSite = onSite;
      out.checkedInToday = todays.filter((x) => x.checkedInAt !== undefined).length;
      out.capped ||= truncated;
      out.expected = expectedWalkIns;
    }
    if (perms.has("appointments:read_site")) {
      const appts = await ctx.db
        .query("appointments")
        .withIndex("by_org_start", (q) => q.eq("organizationId", orgId).gte("scheduledStart", start).lt("scheduledStart", end))
        .take(1000);
      const waiting = appts.filter((a) => a.status === "approved" && scope.sites.has(a.siteId)).length;
      out.expected = (out.expected ?? 0) + waiting;
      out.capped ||= appts.length === 1000;
    }
    if (perms.has("staff_attendance:read_site")) {
      out.staffIn = await staffClockedIn(ctx, scope, now);
    }
    return out;
  },
});
