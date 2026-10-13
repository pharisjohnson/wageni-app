import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  addDays,
  dateKey,
  deriveSessions,
  hoursByDay,
  isDateKey,
  isStaleOpen,
  startOfLocalDay,
} from "../lib/attendance/sessions";
import { effectivePermissions } from "../lib/permissions";
import { hasSiteAccess, requireSite } from "./lib/auth";
import { writeAudit } from "./lib/audit";
import {
  checkClock,
  currentState,
  insertEvent,
  loadClockableMember,
  loadEvents,
  LOOKBACK_MS,
  MAX_EVENTS,
} from "./lib/attendance";
import { appError } from "./lib/errors";
import { orgMutation, orgQuery, type OrgCtx } from "./lib/functions";
import { checkAnswers, resolveActiveForm, servedFields, storeResponse } from "./lib/formResponses";
import { vAttendanceType, vRawAnswers } from "./validators";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_MS = 62 * DAY_MS;
const MAX_CORRECTION_AGE_MS = 90 * DAY_MS;
const MAX_PENDING_PER_PERSON = 10;
const MAX_MEMBERS = 500;

const displayName = (u: Doc<"users"> | null) => u?.name ?? u?.email ?? "Unknown";

type SiteInfo = { name: string; timeZone: string };

async function siteLookup(ctx: OrgCtx) {
  const sites = await ctx.db
    .query("sites")
    .withIndex("by_org", (q) => q.eq("organizationId", ctx.oc.org._id))
    .take(200);
  const map = new Map<string, SiteInfo>();
  for (const s of sites) map.set(s._id, { name: s.name, timeZone: s.timeZone });
  return { sites, map };
}

const tzOf = (map: Map<string, SiteInfo>, siteId: string, fallback: string) =>
  map.get(siteId)?.timeZone ?? fallback;

type EventRow = Doc<"attendanceEvents"> & { superseded: boolean };

/** Sessions, per-day totals and flags for one person's events. */
function summarize(
  events: EventRow[],
  sites: Map<string, SiteInfo>,
  fallbackTz: string,
  from: number,
  to: number,
) {
  const counted = events.filter((e) => !e.superseded);
  const { sessions, open, orphanOutIds } = deriveSessions(counted);
  const all = open ? [...sessions, open] : sessions;
  type SessionOut = {
    start: number;
    end: number | null;
    siteId: string;
    siteName: string;
    timeZone: string;
    unclosed: boolean;
    ongoing: boolean;
    ms: number | null;
  };
  const byDay = new Map<string, { date: string; totalMs: number; sessions: SessionOut[] }>();
  const dayOf = (date: string) => {
    let d = byDay.get(date);
    if (!d) {
      d = { date, totalMs: 0, sessions: [] };
      byDay.set(date, d);
    }
    return d;
  };
  for (const s of all) {
    if (s.start > to || (s.end !== null && s.end < from)) continue;
    const tz = tzOf(sites, s.siteId, fallbackTz);
    const startDay = dateKey(s.start, tz);
    dayOf(startDay).sessions.push({
      start: s.start,
      end: s.end,
      siteId: s.siteId,
      siteName: sites.get(s.siteId)?.name ?? "Unknown site",
      timeZone: tz,
      unclosed: s.unclosed,
      ongoing: s === open,
      ms: s.end !== null && !s.unclosed ? s.end - s.start : null,
    });
    for (const [date, ms] of hoursByDay([s], tz)) dayOf(date).totalMs += ms;
  }
  const days = [...byDay.values()]
    .map((d) => ({
      ...d,
      sessions: d.sessions.sort((a, b) => a.start - b.start),
    }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  return { days, open, orphanOutIds, hasUnclosed: all.some((s) => s.unclosed) };
}

async function eventRows(ctx: OrgCtx, events: EventRow[], sites: Map<string, SiteInfo>) {
  const names = new Map<string, string>();
  const nameOf = async (id: Id<"users"> | undefined) => {
    if (!id) return null;
    if (!names.has(id)) names.set(id, displayName(await ctx.db.get(id)));
    return names.get(id)!;
  };
  return await Promise.all(
    events.map(async (e) => ({
      _id: e._id,
      type: e.type,
      at: e.at,
      source: e.source,
      siteId: e.siteId,
      siteName: sites.get(e.siteId)?.name ?? "Unknown site",
      timeZone: sites.get(e.siteId)?.timeZone ?? ctx.oc.org.timeZone,
      superseded: e.superseded,
      isCorrection: e.correctionId !== undefined,
      correctsEventId: e.correctsEventId ?? null,
      recordedByName: await nameOf(e.recordedBy),
    })),
  );
}

async function correctionRows(ctx: OrgCtx, rows: Doc<"attendanceCorrections">[], sites: Map<string, SiteInfo>) {
  return await Promise.all(
    rows.map(async (c) => {
      const [subject, requester, decider, original] = await Promise.all([
        ctx.db.get(c.userId),
        ctx.db.get(c.requestedBy),
        c.decidedBy ? ctx.db.get(c.decidedBy) : null,
        c.originalEventId ? ctx.db.get(c.originalEventId) : null,
      ]);
      return {
        _id: c._id,
        siteId: c.siteId,
        siteName: sites.get(c.siteId)?.name ?? "Unknown site",
        timeZone: sites.get(c.siteId)?.timeZone ?? ctx.oc.org.timeZone,
        userId: c.userId,
        userName: displayName(subject),
        requestedByName: displayName(requester),
        requestedBySelf: c.requestedBy === c.userId,
        proposedType: c.proposedType,
        proposedAt: c.proposedAt,
        reason: c.reason,
        status: c.status,
        decidedByName: decider ? displayName(decider) : null,
        decidedAt: c.decidedAt ?? null,
        decisionNote: c.decisionNote ?? null,
        original: original ? { type: original.type, at: original.at } : null,
        createdAt: c.createdAt,
      };
    }),
  );
}

function checkRange(from: number, to: number) {
  if (!(to > from) || to - from > MAX_RANGE_MS) {
    throw appError("VALIDATION", "Choose a date range of up to 62 days.");
  }
}

// --- Own attendance ---------------------------------------------------------

/** Am I in or out, where, and where can I clock in. */
export const myStatus = orgQuery({
  args: {},
  handler: async (ctx) => {
    ctx.require("staff_attendance:read_own");
    const { open } = await currentState(ctx, ctx.oc.org._id, ctx.oc.user._id);
    const { sites, map } = await siteLookup(ctx);
    const clockable = sites
      .filter((s) => s.status === "active" && hasSiteAccess(ctx.oc.membership, s._id))
      .map((s) => ({ _id: s._id, name: s.name, timeZone: s.timeZone }));
    const pending = await ctx.db
      .query("attendanceCorrections")
      .withIndex("by_user_status", (q) =>
        q.eq("organizationId", ctx.oc.org._id).eq("userId", ctx.oc.user._id).eq("status", "pending"),
      )
      .take(MAX_PENDING_PER_PERSON + 1);
    return {
      canClock: ctx.oc.permissions.has("staff_attendance:create"),
      status: open ? ("in" as const) : ("out" as const),
      since: open?.start ?? null,
      siteId: open?.siteId ?? null,
      siteName: open ? (map.get(open.siteId)?.name ?? null) : null,
      sites: clockable,
      pendingCorrections: pending.length,
    };
  },
});

/** My events, derived sessions and daily hours (in each site's time zone), and my correction requests. */
export const myHistory = orgQuery({
  args: { from: v.number(), to: v.number() },
  handler: async (ctx, { from, to }) => {
    ctx.require("staff_attendance:read_own");
    checkRange(from, to);
    const { map } = await siteLookup(ctx);
    const events = await loadEvents(ctx, ctx.oc.org._id, ctx.oc.user._id, from - LOOKBACK_MS, to);
    const summary = summarize(events, map, ctx.oc.org.timeZone, from, to);
    const corrections = await ctx.db
      .query("attendanceCorrections")
      .withIndex("by_user_status", (q) =>
        q.eq("organizationId", ctx.oc.org._id).eq("userId", ctx.oc.user._id),
      )
      .order("desc")
      .take(30);
    return {
      days: summary.days,
      hasUnclosed: summary.hasUnclosed,
      events: await eventRows(
        ctx,
        events.filter((e) => e.at >= from).reverse(),
        map,
      ),
      corrections: await correctionRows(ctx, corrections, map),
    };
  },
});

// --- Site view for managers --------------------------------------------------

/** Who is in right now / on a given day at a site, with hours (local date in the site's time zone). */
export const siteRoster = orgQuery({
  args: { siteId: v.id("sites"), date: v.optional(v.string()) },
  handler: async (ctx, { siteId, date }) => {
    ctx.require("staff_attendance:read_site");
    const site = await requireSite(ctx, ctx.oc, siteId);
    const tz = site.timeZone;
    const now = Date.now();
    const today = dateKey(now, tz);
    const day = date ?? today;
    if (!isDateKey(day) || day > today) throw appError("VALIDATION", "Choose today or an earlier date.");
    const dayStart = startOfLocalDay(day, tz);
    const dayEnd = startOfLocalDay(addDays(day, 1), tz) - 1;
    // Events after the day are needed so a shift that runs past midnight is closed.
    const upTo = Math.min(dayEnd + LOOKBACK_MS, now);
    const isToday = day === today;

    const [events, approved, memberships] = await Promise.all([
      ctx.db
        .query("attendanceEvents")
        .withIndex("by_site_at", (q) =>
          q.eq("siteId", siteId).gte("at", dayStart - LOOKBACK_MS).lte("at", upTo),
        )
        .take(MAX_EVENTS),
      ctx.db
        .query("attendanceCorrections")
        .withIndex("by_org_status", (q) =>
          q
            .eq("organizationId", ctx.oc.org._id)
            .eq("status", "approved")
            .gte("createdAt", dayStart - LOOKBACK_MS),
        )
        .take(1000),
      ctx.db
        .query("memberships")
        .withIndex("by_org", (q) => q.eq("organizationId", ctx.oc.org._id))
        .take(MAX_MEMBERS),
    ]);
    const superseded = new Set<string>(approved.flatMap((c) => (c.originalEventId ? [c.originalEventId] : [])));
    const byUser = new Map<string, EventRow[]>();
    for (const e of events) {
      if (e.organizationId !== ctx.oc.org._id) continue;
      const list = byUser.get(e.userId) ?? [];
      list.push({ ...e, superseded: superseded.has(e._id) });
      byUser.set(e.userId, list);
    }

    const canSeePins = ctx.oc.permissions.has("staff_attendance:manage_pins");
    const rows = [];
    for (const m of memberships) {
      if (m.status !== "active" || !hasSiteAccess(m, siteId)) continue;
      if (!effectivePermissions(m.role, m.permissionOverrides).has("staff_attendance:create")) continue;
      const userEvents = byUser.get(m.userId) ?? [];
      const { sessions, open } = deriveSessions(userEvents.filter((e) => !e.superseded));
      const overlapping = [...sessions, ...(open ? [open] : [])].filter(
        (s) => s.start <= dayEnd && (s.end === null || s.end >= dayStart),
      );
      const totals = hoursByDay(sessions, tz);
      const firstIn = overlapping.length ? Math.min(...overlapping.map((s) => Math.max(s.start, dayStart))) : null;
      const outs = overlapping.flatMap((s) =>
        s.end !== null && !s.unclosed && s.end <= dayEnd ? [s.end] : [],
      );
      const stale = open !== null && isStaleOpen(open.start, now);
      const [user, pin] = await Promise.all([
        ctx.db.get(m.userId),
        canSeePins
          ? ctx.db
              .query("staffPins")
              .withIndex("by_org_user", (q) => q.eq("organizationId", ctx.oc.org._id).eq("userId", m.userId))
              .unique()
          : null,
      ]);
      rows.push({
        userId: m.userId,
        membershipId: m._id,
        name: displayName(user),
        email: user?.email ?? null,
        role: m.role,
        staffNumber: m.staffNumber ?? null,
        // Only "today" can be "in"; a past day shows who worked and who never clocked out.
        status:
          isToday && open
            ? ("in" as const)
            : overlapping.length
              ? ("out" as const)
              : ("absent" as const),
        inSince: isToday && open ? open.start : null,
        firstIn,
        lastOut: outs.length ? Math.max(...outs) : null,
        totalMs: totals.get(day) ?? 0,
        needsAttention:
          overlapping.some((s) => s.unclosed) || (open !== null && (!isToday || stale) && overlapping.includes(open)),
        pinSet: canSeePins ? pin !== null : null,
        pinLocked: canSeePins ? (pin?.lockedUntil ?? 0) > now : null,
      });
    }
    const order = { in: 0, out: 1, absent: 2 } as const;
    rows.sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
    return {
      siteName: site.name,
      timeZone: tz,
      date: day,
      isToday,
      inNowCount: rows.filter((r) => r.status === "in").length,
      rows,
    };
  },
});

/** One person's attendance across the sites the caller can see. */
export const personHistory = orgQuery({
  args: { userId: v.id("users"), from: v.number(), to: v.number() },
  handler: async (ctx, { userId, from, to }) => {
    ctx.require("staff_attendance:read_site");
    checkRange(from, to);
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_org_user", (q) => q.eq("organizationId", ctx.oc.org._id).eq("userId", userId))
      .unique();
    if (!membership) throw appError("NOT_FOUND");
    const { map } = await siteLookup(ctx);
    const all = await loadEvents(ctx, ctx.oc.org._id, userId, from - LOOKBACK_MS, to);
    const events = all.filter((e) => hasSiteAccess(ctx.oc.membership, e.siteId));
    const summary = summarize(events, map, ctx.oc.org.timeZone, from, to);
    const corrections = (
      await ctx.db
        .query("attendanceCorrections")
        .withIndex("by_user_status", (q) => q.eq("organizationId", ctx.oc.org._id).eq("userId", userId))
        .order("desc")
        .take(30)
    ).filter((c) => hasSiteAccess(ctx.oc.membership, c.siteId));
    const user = await ctx.db.get(userId);
    const canSeePins = ctx.oc.permissions.has("staff_attendance:manage_pins");
    const pin = canSeePins
      ? await ctx.db
          .query("staffPins")
          .withIndex("by_org_user", (q) => q.eq("organizationId", ctx.oc.org._id).eq("userId", userId))
          .unique()
      : null;
    return {
      person: {
        userId,
        membershipId: membership._id,
        isSelf: userId === ctx.oc.user._id,
        pinSet: canSeePins ? pin !== null : null,
        pinLocked: canSeePins ? (pin?.lockedUntil ?? 0) > Date.now() : null,
        name: displayName(user),
        email: user?.email ?? null,
        role: membership.role,
        staffNumber: membership.staffNumber ?? null,
      },
      days: summary.days,
      hasUnclosed: summary.hasUnclosed,
      events: await eventRows(ctx, events.filter((e) => e.at >= from).reverse(), map),
      corrections: await correctionRows(ctx, corrections, map),
    };
  },
});

/** Correction requests waiting for a decision at the caller's sites. */
export const pendingCorrections = orgQuery({
  args: { siteId: v.optional(v.id("sites")) },
  handler: async (ctx, { siteId }) => {
    ctx.require("staff_attendance:correct");
    if (siteId) await requireSite(ctx, ctx.oc, siteId);
    const rows = await ctx.db
      .query("attendanceCorrections")
      .withIndex("by_org_status", (q) => q.eq("organizationId", ctx.oc.org._id).eq("status", "pending"))
      .take(200);
    const visible = rows.filter(
      (c) => hasSiteAccess(ctx.oc.membership, c.siteId) && (!siteId || c.siteId === siteId),
    );
    const { map } = await siteLookup(ctx);
    const out = await correctionRows(ctx, visible, map);
    return out.map((c) => ({ ...c, isOwn: c.userId === ctx.oc.user._id }));
  },
});

// --- Clocking -----------------------------------------------------------------

/**
 * The staff form (daily declaration, shift note...) the caller must answer to
 * clock in at `siteId`, or null when none is published for that site.
 */
export const activeStaffForm = orgQuery({
  args: { siteId: v.id("sites") },
  handler: async (ctx, { siteId }) => {
    ctx.require("staff_attendance:create");
    const site = await requireSite(ctx, ctx.oc, siteId);
    if (site.status !== "active") throw appError("NOT_FOUND");
    const active = await resolveActiveForm(ctx, ctx.oc.org._id, siteId, "staff");
    if (!active) return null;
    return {
      versionId: active.version._id,
      version: active.version.version,
      name: active.version.name,
      fields: servedFields(ctx.oc.org, active.version),
    };
  },
});

export const clockIn = orgMutation({
  args: {
    siteId: v.id("sites"),
    /** Answers to the site's staff form: required when one is published for the site. */
    form: v.optional(v.object({ versionId: v.id("formVersions"), answers: vRawAnswers })),
  },
  handler: async (ctx, { siteId, form }) => {
    ctx.require("staff_attendance:create");
    const site = await requireSite(ctx, ctx.oc, siteId);
    if (site.status !== "active") throw appError("NOT_FOUND");
    const now = Date.now();
    const check = await checkClock(ctx, ctx.oc.org._id, ctx.oc.user._id, "clock_in", now);
    if (check.result !== "ok") throw appError("CONFLICT", "You are already clocked in.");
    const active = await resolveActiveForm(ctx, ctx.oc.org._id, siteId, "staff");
    let checked: Awaited<ReturnType<typeof checkAnswers>> | null = null;
    if (active) {
      if (!form) throw appError("VALIDATION", "Please complete the form before you clock in.");
      if (form.versionId !== active.version._id) throw appError("CONFLICT", "This form was updated. Please reload and try again.");
      // Staff forms have no file fields, so there is no uploader.
      checked = await checkAnswers(ctx, ctx.oc.org, active.version, form.answers, null);
    } else if (form) {
      throw appError("CONFLICT", "There is no form to answer at this site any more.");
    }
    const eventId = await insertEvent(ctx, {
      organizationId: ctx.oc.org._id,
      siteId,
      userId: ctx.oc.user._id,
      type: "clock_in",
      at: now,
      source: "app",
    });
    if (active && checked) {
      await storeResponse(ctx, {
        org: ctx.oc.org,
        siteId,
        form: active.form,
        version: active.version,
        answers: checked.answers,
        fileIds: checked.fileIds,
        userId: ctx.oc.user._id,
        attendanceEventId: eventId,
        actor: { actorUserId: ctx.oc.user._id },
      });
    }
    return eventId;
  },
});

/** Clocks out of the site the person is currently clocked in at. */
export const clockOut = orgMutation({
  args: {},
  handler: async (ctx) => {
    ctx.require("staff_attendance:create");
    const now = Date.now();
    const check = await checkClock(ctx, ctx.oc.org._id, ctx.oc.user._id, "clock_out", now);
    if (check.result !== "ok" || !check.siteId) {
      throw appError("CONFLICT", "You are not clocked in. If you forgot to clock in, request a correction.");
    }
    return await insertEvent(ctx, {
      organizationId: ctx.oc.org._id,
      siteId: check.siteId,
      userId: ctx.oc.user._id,
      type: "clock_out",
      at: now,
      source: "app",
    });
  },
});

/** Reception or a manager records a clock-in/out for someone else, now. Audited. */
export const recordOnBehalf = orgMutation({
  args: {
    siteId: v.id("sites"),
    userId: v.id("users"),
    type: vAttendanceType,
    note: v.optional(v.string()),
  },
  handler: async (ctx, { siteId, userId, type, note }) => {
    ctx.require("staff_attendance:record_on_behalf");
    const site = await requireSite(ctx, ctx.oc, siteId);
    if (site.status !== "active") throw appError("NOT_FOUND");
    if (userId === ctx.oc.user._id) {
      throw appError("FORBIDDEN", "Use Clock in / Clock out for your own attendance.");
    }
    const target = await loadClockableMember(ctx, ctx.oc.org._id, userId, siteId);
    if (!target) throw appError("NOT_FOUND");
    if (!effectivePermissions(target.role, target.permissionOverrides).has("staff_attendance:create")) {
      throw appError("VALIDATION", "This person does not record attendance.");
    }
    const now = Date.now();
    const check = await checkClock(ctx, ctx.oc.org._id, userId, type, now);
    if (check.result === "already_in") throw appError("CONFLICT", "This person is already clocked in.");
    if (check.result === "not_in") throw appError("CONFLICT", "This person is not clocked in.");
    if (type === "clock_out" && check.siteId !== siteId) {
      throw appError("CONFLICT", "This person is clocked in at a different site.");
    }
    const id = await insertEvent(ctx, {
      organizationId: ctx.oc.org._id,
      siteId,
      userId,
      type,
      at: now,
      source: "reception",
      recordedBy: ctx.oc.user._id,
    });
    await writeAudit(ctx, {
      organizationId: ctx.oc.org._id,
      actorUserId: ctx.oc.user._id,
      action: "attendance.recorded_on_behalf",
      resourceType: "attendanceEvent",
      resourceId: id,
      metadata: {
        subjectUserId: userId,
        type,
        siteId,
        note: note?.trim().slice(0, 200) || null,
      },
    });
    return id;
  },
});

// --- Corrections ----------------------------------------------------------------

/**
 * Ask for a missing or wrong clock event to be fixed. Staff ask for
 * themselves; a manager (`staff_attendance:correct`) may ask for others.
 * Nothing changes until it is approved, and approving only ADDS an event.
 */
export const requestCorrection = orgMutation({
  args: {
    siteId: v.id("sites"),
    userId: v.optional(v.id("users")),
    originalEventId: v.optional(v.id("attendanceEvents")),
    proposedType: vAttendanceType,
    proposedAt: v.number(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const me = ctx.oc.user._id;
    const subjectId = args.userId ?? me;
    if (subjectId === me) ctx.require("staff_attendance:create");
    else ctx.require("staff_attendance:correct");
    await requireSite(ctx, ctx.oc, args.siteId);
    if (subjectId !== me && !(await loadClockableMember(ctx, ctx.oc.org._id, subjectId, args.siteId))) {
      throw appError("NOT_FOUND");
    }
    const reason = args.reason.trim();
    if (reason.length < 3 || reason.length > 500) {
      throw appError("VALIDATION", "Give a reason of 3 to 500 characters.");
    }
    const now = Date.now();
    if (!Number.isFinite(args.proposedAt) || args.proposedAt > now + 60_000) {
      throw appError("VALIDATION", "The corrected time cannot be in the future.");
    }
    if (args.proposedAt < now - MAX_CORRECTION_AGE_MS) {
      throw appError("VALIDATION", "Corrections can only go back 90 days.");
    }
    if (args.originalEventId) {
      const original = await ctx.db.get(args.originalEventId);
      if (
        !original ||
        original.organizationId !== ctx.oc.org._id ||
        original.userId !== subjectId ||
        original.siteId !== args.siteId
      ) {
        throw appError("NOT_FOUND");
      }
      const existing = await ctx.db
        .query("attendanceCorrections")
        .withIndex("by_original", (q) => q.eq("originalEventId", original._id))
        .take(20);
      if (existing.some((c) => c.status !== "rejected")) {
        throw appError("CONFLICT", "This entry already has a correction.");
      }
    }
    const open = await ctx.db
      .query("attendanceCorrections")
      .withIndex("by_user_status", (q) =>
        q.eq("organizationId", ctx.oc.org._id).eq("userId", subjectId).eq("status", "pending"),
      )
      .take(MAX_PENDING_PER_PERSON);
    if (open.length >= MAX_PENDING_PER_PERSON) {
      throw appError("CONFLICT", "Too many pending corrections. Wait for a decision first.");
    }
    const id = await ctx.db.insert("attendanceCorrections", {
      organizationId: ctx.oc.org._id,
      siteId: args.siteId,
      userId: subjectId,
      requestedBy: me,
      originalEventId: args.originalEventId,
      proposedType: args.proposedType,
      proposedAt: args.proposedAt,
      reason,
      status: "pending",
      createdAt: now,
    });
    if (subjectId !== me) {
      await writeAudit(ctx, {
        organizationId: ctx.oc.org._id,
        actorUserId: me,
        action: "attendance.correction_requested_for",
        resourceType: "attendanceCorrection",
        resourceId: id,
        metadata: { subjectUserId: subjectId },
      });
    }
    return id;
  },
});

/** Approve (adds a NEW correction event, original kept) or reject. Cannot decide your own. */
export const decideCorrection = orgMutation({
  args: {
    correctionId: v.id("attendanceCorrections"),
    decision: v.union(v.literal("approved"), v.literal("rejected")),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { correctionId, decision, note }) => {
    ctx.require("staff_attendance:correct");
    const c = await ctx.db.get(correctionId);
    if (!c || c.organizationId !== ctx.oc.org._id || !hasSiteAccess(ctx.oc.membership, c.siteId)) {
      throw appError("NOT_FOUND");
    }
    if (c.userId === ctx.oc.user._id) {
      throw appError("FORBIDDEN", "You cannot decide a correction to your own attendance.");
    }
    if (c.status !== "pending") throw appError("CONFLICT", "This correction was already decided.");
    const trimmed = note?.trim();
    if (trimmed && trimmed.length > 500) throw appError("VALIDATION", "Keep the note under 500 characters.");
    if (decision === "rejected" && !trimmed) {
      throw appError("VALIDATION", "Say why the correction is rejected.");
    }
    const now = Date.now();
    let resultEventId: Id<"attendanceEvents"> | undefined;
    if (decision === "approved") {
      if (c.originalEventId) {
        const other = await ctx.db
          .query("attendanceCorrections")
          .withIndex("by_original", (q) => q.eq("originalEventId", c.originalEventId))
          .take(20);
        if (other.some((o) => o._id !== c._id && o.status === "approved")) {
          throw appError("CONFLICT", "This entry was already corrected.");
        }
      }
      resultEventId = await insertEvent(ctx, {
        organizationId: c.organizationId,
        siteId: c.siteId,
        userId: c.userId,
        type: c.proposedType,
        at: c.proposedAt,
        source: "correction",
        recordedBy: ctx.oc.user._id,
        correctionId: c._id,
        correctsEventId: c.originalEventId,
      });
    }
    await ctx.db.patch(c._id, {
      status: decision,
      decidedBy: ctx.oc.user._id,
      decidedAt: now,
      decisionNote: trimmed || undefined,
      resultEventId,
    });
    await writeAudit(ctx, {
      organizationId: ctx.oc.org._id,
      actorUserId: ctx.oc.user._id,
      action: `attendance.correction_${decision}`,
      resourceType: "attendanceCorrection",
      resourceId: c._id,
      metadata: { subjectUserId: c.userId, proposedType: c.proposedType, proposedAt: c.proposedAt },
    });
  },
});
