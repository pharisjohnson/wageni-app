import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { deriveSessions, isStaleOpen, type Session } from "../../lib/attendance/sessions";
import { hasSiteAccess } from "./auth";

export const MAX_EVENTS = 1500;
const STATE_WINDOW = 20;
/** Events are fetched this far before a window so sessions that started earlier still pair up. */
export const LOOKBACK_MS = 36 * 60 * 60 * 1000;

/** Ids of events a correction has replaced. They stay in history but are not counted. */
export async function supersededIds(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  userId: Id<"users">,
): Promise<Set<Id<"attendanceEvents">>> {
  const approved = await ctx.db
    .query("attendanceCorrections")
    .withIndex("by_user_status", (q) =>
      q.eq("organizationId", organizationId).eq("userId", userId).eq("status", "approved"),
    )
    .take(500);
  const ids = new Set<Id<"attendanceEvents">>();
  for (const c of approved) if (c.originalEventId) ids.add(c.originalEventId);
  return ids;
}

/** Events for one person in [from, to], oldest first, each flagged if superseded. */
export async function loadEvents(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  userId: Id<"users">,
  from: number,
  to: number,
) {
  const [events, superseded] = await Promise.all([
    ctx.db
      .query("attendanceEvents")
      .withIndex("by_user_at", (q) =>
        q.eq("organizationId", organizationId).eq("userId", userId).gte("at", from).lte("at", to),
      )
      .take(MAX_EVENTS),
    supersededIds(ctx, organizationId, userId),
  ]);
  return events.map((e) => ({ ...e, superseded: superseded.has(e._id) }));
}

export type PersonState = { open: Session | null; lastAt: number | null };

/** Whether the person is clocked in, from their most recent counted events. */
export async function currentState(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  userId: Id<"users">,
): Promise<PersonState> {
  const [recent, superseded] = await Promise.all([
    ctx.db
      .query("attendanceEvents")
      .withIndex("by_user_at", (q) => q.eq("organizationId", organizationId).eq("userId", userId))
      .order("desc")
      .take(STATE_WINDOW),
    supersededIds(ctx, organizationId, userId),
  ]);
  const counted = recent.filter((e) => !superseded.has(e._id)).reverse();
  const { open } = deriveSessions(counted);
  return { open, lastAt: counted[counted.length - 1]?.at ?? null };
}

export type ClockCheck =
  | { result: "ok"; siteId: Id<"sites"> | null }
  | { result: "already_in"; since: number; siteId: string }
  | { result: "not_in" };

/**
 * The one rule for clocking. Clock-in is refused while already in (unless the
 * open session is stale, see STALE_OPEN_MS). Clock-out needs a fresh open
 * session and always happens at the site the person clocked in at.
 */
export async function checkClock(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  userId: Id<"users">,
  type: "clock_in" | "clock_out",
  now: number,
): Promise<ClockCheck> {
  const { open } = await currentState(ctx, organizationId, userId);
  const fresh = open && !isStaleOpen(open.start, now) ? open : null;
  if (type === "clock_in") {
    return fresh ? { result: "already_in", since: fresh.start, siteId: fresh.siteId } : { result: "ok", siteId: null };
  }
  return fresh ? { result: "ok", siteId: fresh.siteId as Id<"sites"> } : { result: "not_in" };
}

export async function insertEvent(
  ctx: MutationCtx,
  event: Omit<Doc<"attendanceEvents">, "_id" | "_creationTime" | "createdAt">,
) {
  return await ctx.db.insert("attendanceEvents", { ...event, createdAt: Date.now() });
}

/** An active member of the organization who may be recorded at `siteId`; otherwise null. */
export async function loadClockableMember(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  userId: Id<"users">,
  siteId: Id<"sites">,
) {
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_org_user", (q) => q.eq("organizationId", organizationId).eq("userId", userId))
    .unique();
  if (!membership || membership.status !== "active" || !hasSiteAccess(membership, siteId)) return null;
  return membership;
}
