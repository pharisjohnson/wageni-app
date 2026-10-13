import type { Doc, Id } from "../_generated/dataModel";
import { dateKey } from "../../lib/attendance/sessions";
import {
  appointmentOutcome,
  resolveRange,
  type DateRange,
  type VisitRow,
} from "../../lib/reports/math";
import { summariseAttendance } from "../../lib/reports/attendance";
import { hasSiteAccess, requireSite } from "./auth";
import { appError } from "./errors";
import type { OrgCtx } from "./functions";
import { loadEvents, LOOKBACK_MS } from "./attendance";

/**
 * Shared loaders for the reports queries and the CSV export. Every loader is
 * bounded (take caps) and reports `truncated` instead of silently dropping
 * rows, and every loader works from a `ReportScope`, which already applies
 * the caller's site access and any site filter.
 */
export const MAX_VISITS = 3000;
export const MAX_APPOINTMENTS = 3000;
export const MAX_PEOPLE = 200;
export const MAX_ON_SITE = 500;
/** Historical "on site at time T" looks this far back for visits that started earlier. */
export const ON_SITE_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

export type SiteInfo = { name: string; timeZone: string };

export type ReportScope = {
  siteIds: Id<"sites">[];
  sites: Map<string, SiteInfo>;
  /** True when no site restriction applies, so org-wide indexes can be used. */
  orgWide: boolean;
  /** Time zone for turning dates into instants: the filtered site's, else the organization's. */
  timeZone: string;
};

export async function reportScope(ctx: OrgCtx, siteId?: Id<"sites">): Promise<ReportScope> {
  const org = ctx.oc.org;
  const rows = await ctx.db
    .query("sites")
    .withIndex("by_org", (q) => q.eq("organizationId", org._id))
    .take(200);
  if (siteId) {
    const site = await requireSite(ctx, ctx.oc, siteId); // NOT_FOUND for other orgs / no access
    return {
      siteIds: [site._id],
      sites: new Map([[site._id, { name: site.name, timeZone: site.timeZone }]]),
      orgWide: false,
      timeZone: site.timeZone,
    };
  }
  const allowed = rows.filter((s) => hasSiteAccess(ctx.oc.membership, s._id));
  return {
    siteIds: allowed.map((s) => s._id),
    sites: new Map(allowed.map((s) => [s._id as string, { name: s.name, timeZone: s.timeZone }])),
    orgWide: ctx.oc.membership.siteAccess === "all",
    timeZone: org.timeZone,
  };
}

export const siteTz = (scope: ReportScope, id: string) => scope.sites.get(id)?.timeZone ?? scope.timeZone;
export const siteName = (scope: ReportScope, id: string) => scope.sites.get(id)?.name ?? "Unknown site";

export function rangeOrThrow(scope: ReportScope, fromDate: string, toDate: string, maxDays?: number): DateRange {
  const r = resolveRange(fromDate, toDate, scope.timeZone, maxDays);
  if ("error" in r) throw appError("VALIDATION", r.error);
  return r;
}

const displayName = (u: Doc<"users"> | null | undefined) => u?.name ?? u?.email ?? "Unknown";

/** Cached user / visitor lookups for one report run. */
export function lookups(ctx: OrgCtx) {
  const users = new Map<string, Promise<Doc<"users"> | null>>();
  const visitors = new Map<string, Promise<Doc<"visitors"> | null>>();
  return {
    userName: async (id: Id<"users"> | undefined) => {
      if (!id) return undefined;
      if (!users.has(id)) users.set(id, ctx.db.get(id));
      return displayName(await users.get(id));
    },
    visitor: async (id: Id<"visitors">) => {
      if (!visitors.has(id)) visitors.set(id, ctx.db.get(id));
      const v = await visitors.get(id);
      // Defence in depth: never surface another organization's visitor.
      return v && v.organizationId === ctx.oc.org._id ? v : null;
    },
  };
}

type Truncated<T> = { rows: T[]; truncated: boolean };

/** Newest-first rows from the org-wide index or, when restricted, merged from each site. */
export async function byCreated<T extends { createdAt: number }>(
  scope: ReportScope,
  cap: number,
  org: (limit: number) => Promise<T[]>,
  site: (siteId: Id<"sites">, limit: number) => Promise<T[]>,
): Promise<Truncated<T>> {
  let rows: T[];
  if (scope.orgWide) rows = await org(cap + 1);
  else {
    const per = await Promise.all(scope.siteIds.map((id) => site(id, cap + 1)));
    rows = per.flat().sort((a, b) => b.createdAt - a.createdAt);
  }
  return { rows: rows.slice(0, cap), truncated: rows.length > cap };
}

export async function loadVisitRows(
  ctx: OrgCtx,
  scope: ReportScope,
  range: Pick<DateRange, "from" | "to">,
  filter: { hostUserId?: Id<"users"> } = {},
): Promise<Truncated<VisitRow>> {
  const orgId = ctx.oc.org._id;
  const { rows: visits, truncated } = await byCreated(
    scope,
    MAX_VISITS,
    (limit) =>
      ctx.db
        .query("visits")
        .withIndex("by_org", (q) =>
          q.eq("organizationId", orgId).gte("createdAt", range.from).lt("createdAt", range.to),
        )
        .order("desc")
        .take(limit),
    (siteId, limit) =>
      ctx.db
        .query("visits")
        .withIndex("by_site_created", (q) =>
          q.eq("siteId", siteId).gte("createdAt", range.from).lt("createdAt", range.to),
        )
        .order("desc")
        .take(limit),
  );
  const rows = await visitRows(
    ctx,
    scope,
    visits.filter((v) => !filter.hostUserId || v.hostUserId === filter.hostUserId),
  );
  return { rows, truncated };
}

/** Join visits with visitor, host and the host's meeting confirmation. */
export async function visitRows(ctx: OrgCtx, scope: ReportScope, visits: Doc<"visits">[]): Promise<VisitRow[]> {
  const look = lookups(ctx);
  return await Promise.all(
    visits
      .filter((v) => v.organizationId === ctx.oc.org._id && scope.sites.has(v.siteId))
      .map(async (v) => {
        const [visitor, hostName] = await Promise.all([look.visitor(v.visitorId), look.userName(v.hostUserId)]);
        let meetingEndedAt: number | undefined;
        let meetingConfirmedBy: string | undefined;
        if (v.checkedInAt !== undefined) {
          const events = await ctx.db
            .query("visitEvents")
            .withIndex("by_visit", (q) => q.eq("visitId", v._id))
            .take(20);
          const ended = events.find((e) => e.type === "meeting_ended");
          if (ended) {
            meetingEndedAt = ended.at;
            meetingConfirmedBy = ended.actorUserId ? await look.userName(ended.actorUserId) : "Kiosk";
          }
        }
        return {
          id: v._id,
          siteId: v.siteId,
          visitorName: visitor?.name ?? "Unknown",
          company: visitor?.company,
          phone: visitor?.phone,
          email: visitor?.email,
          hostUserId: v.hostUserId,
          hostName,
          purpose: v.purpose,
          status: v.status,
          appointmentId: v.appointmentId,
          createdAt: v.createdAt,
          checkedInAt: v.checkedInAt,
          checkedOutAt: v.checkedOutAt,
          checkedOutMethod: v.checkedOutMethod,
          meetingEndedAt,
          meetingConfirmedBy,
        } satisfies VisitRow;
      }),
  );
}

/** Visits on site now at the caller's sites, or (with `at`) on site at that past instant. */
export async function loadOnSite(ctx: OrgCtx, scope: ReportScope, at?: number): Promise<Truncated<VisitRow>> {
  const orgId = ctx.oc.org._id;
  let visits: Doc<"visits">[] = [];
  let truncated = false;
  if (at === undefined) {
    for (const siteId of scope.siteIds) {
      const part = await ctx.db
        .query("visits")
        .withIndex("by_site_status", (q) => q.eq("siteId", siteId).eq("status", "on_site"))
        .take(MAX_ON_SITE + 1);
      if (part.length > MAX_ON_SITE) truncated = true;
      visits.push(...part.slice(0, MAX_ON_SITE));
    }
  } else {
    const from = at - ON_SITE_LOOKBACK_MS;
    const { rows, truncated: t } = await byCreated(
      scope,
      MAX_VISITS,
      (limit) =>
        ctx.db
          .query("visits")
          .withIndex("by_org", (q) => q.eq("organizationId", orgId).gte("createdAt", from).lte("createdAt", at))
          .order("desc")
          .take(limit),
      (siteId, limit) =>
        ctx.db
          .query("visits")
          .withIndex("by_site_created", (q) => q.eq("siteId", siteId).gte("createdAt", from).lte("createdAt", at))
          .order("desc")
          .take(limit),
    );
    truncated = t;
    visits = rows.filter(
      (v) => v.checkedInAt !== undefined && v.checkedInAt <= at && (v.checkedOutAt === undefined || v.checkedOutAt > at),
    );
  }
  return { rows: await visitRows(ctx, scope, visits), truncated };
}

export type AppointmentRow = {
  id: string;
  siteId: string;
  visitorName: string;
  hostName?: string;
  purpose: string;
  scheduledStart: number;
  scheduledEnd: number;
  status: Doc<"appointments">["status"];
  outcome: ReturnType<typeof appointmentOutcome>;
};

export async function loadAppointmentRows(
  ctx: OrgCtx,
  scope: ReportScope,
  range: Pick<DateRange, "from" | "to">,
  filter: { hostUserId?: Id<"users"> } = {},
  now = Date.now(),
): Promise<Truncated<AppointmentRow>> {
  const orgId = ctx.oc.org._id;
  const look = lookups(ctx);
  let appts: Doc<"appointments">[];
  let truncated = false;
  if (scope.orgWide) {
    appts = await ctx.db
      .query("appointments")
      .withIndex("by_org_start", (q) =>
        q.eq("organizationId", orgId).gte("scheduledStart", range.from).lt("scheduledStart", range.to),
      )
      .order("desc")
      .take(MAX_APPOINTMENTS + 1);
  } else {
    appts = (
      await Promise.all(
        scope.siteIds.map((siteId) =>
          ctx.db
            .query("appointments")
            .withIndex("by_site_start", (q) =>
              q.eq("siteId", siteId).gte("scheduledStart", range.from).lt("scheduledStart", range.to),
            )
            .order("desc")
            .take(MAX_APPOINTMENTS + 1),
        ),
      )
    )
      .flat()
      .sort((a, b) => b.scheduledStart - a.scheduledStart);
  }
  if (appts.length > MAX_APPOINTMENTS) truncated = true;
  appts = appts
    .slice(0, MAX_APPOINTMENTS)
    .filter(
      (a) =>
        a.organizationId === orgId &&
        scope.sites.has(a.siteId) &&
        (!filter.hostUserId || a.hostUserId === filter.hostUserId),
    );
  const rows = await Promise.all(
    appts.map(async (a) => ({
      id: a._id as string,
      siteId: a.siteId as string,
      visitorName: (await look.visitor(a.visitorId))?.name ?? "Unknown",
      hostName: await look.userName(a.hostUserId),
      purpose: a.purpose,
      scheduledStart: a.scheduledStart,
      scheduledEnd: a.scheduledEnd,
      status: a.status,
      outcome: appointmentOutcome(a.status, a.scheduledEnd, now),
    })),
  );
  return { rows, truncated };
}

export type AttendancePerson = {
  userId: Id<"users">;
  name: string;
  email?: string;
  corrections: { approved: number; pending: number; rejected: number };
} & ReturnType<typeof summariseAttendance>;

/** Per-person attendance for a date range, over active members the caller can see. */
export async function loadAttendance(
  ctx: OrgCtx,
  scope: ReportScope,
  range: DateRange,
  opts: { userId?: Id<"users">; lateAfterMinutes?: number; now?: number } = {},
): Promise<{ people: AttendancePerson[]; truncated: boolean }> {
  const now = opts.now ?? Date.now();
  const orgId = ctx.oc.org._id;
  const orgTz = ctx.oc.org.timeZone;
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_org", (q) => q.eq("organizationId", orgId))
    .take(500);
  const allowed = new Set<string>(scope.siteIds);
  const visible = memberships
    .filter((m) => m.status === "active")
    .filter((m) => !opts.userId || m.userId === opts.userId)
    .filter((m) => m.siteAccess === "all" || m.siteAccess.some((id) => allowed.has(id)));
  const truncated = visible.length > MAX_PEOPLE || memberships.length === 500;
  const chosen = visible.slice(0, MAX_PEOPLE);

  // Corrections requested in the range, by person.
  const corrections = new Map<string, { approved: number; pending: number; rejected: number }>();
  for (const status of ["approved", "pending", "rejected"] as const) {
    const rows = await ctx.db
      .query("attendanceCorrections")
      .withIndex("by_org_status", (q) =>
        q.eq("organizationId", orgId).eq("status", status).gte("createdAt", range.from).lt("createdAt", range.to),
      )
      .take(1000);
    for (const c of rows) {
      const cur = corrections.get(c.userId) ?? { approved: 0, pending: 0, rejected: 0 };
      cur[status]++;
      corrections.set(c.userId, cur);
    }
  }

  const today = dateKey(now, orgTz);
  const people = await Promise.all(
    chosen.map(async (m) => {
      const user = await ctx.db.get(m.userId);
      const events = (await loadEvents(ctx, orgId, m.userId, range.from - LOOKBACK_MS, range.to - 1)).filter(
        (e) => !e.superseded,
      );
      const summary = summariseAttendance({
        events,
        siteTz: (id) => siteTz(scope, id),
        siteAllowed: (id) => allowed.has(id as Id<"sites">),
        fromDate: range.fromDate,
        toDate: range.toDate,
        from: range.from,
        to: range.to,
        lateAfterMinutes: opts.lateAfterMinutes,
        today,
        expectedFrom: dateKey(m.createdAt, orgTz),
        now,
      });
      return {
        userId: m.userId,
        name: displayName(user),
        email: user?.email,
        corrections: corrections.get(m.userId) ?? { approved: 0, pending: 0, rejected: 0 },
        ...summary,
      } satisfies AttendancePerson;
    }),
  );
  people.sort((a, b) => a.name.localeCompare(b.name));
  return { people, truncated };
}

/** Counts of who is clocked in right now among the given sites (last 18h of events). */
export async function staffClockedIn(ctx: OrgCtx, scope: ReportScope, now: number) {
  const since = now - 18 * 60 * 60 * 1000;
  const byUser = new Map<string, { type: "clock_in" | "clock_out"; at: number }>();
  for (const siteId of scope.siteIds) {
    const events = await ctx.db
      .query("attendanceEvents")
      .withIndex("by_site_at", (q) => q.eq("siteId", siteId).gte("at", since))
      .take(1000);
    for (const e of events) {
      const cur = byUser.get(e.userId);
      if (!cur || e.at >= cur.at) byUser.set(e.userId, { type: e.type, at: e.at });
    }
  }
  return [...byUser.values()].filter((e) => e.type === "clock_in").length;
}
