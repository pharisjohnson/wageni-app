import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type QueryCtx } from "./_generated/server";
import {
  DAY_MS,
  DEFAULT_RETENTION,
  MAX_RETENTION_DAYS,
  MIN_RETENTION,
  resolveRetention,
  retentionSchema,
} from "../lib/retention";
import { writeAudit } from "./lib/audit";
import { orgMutation, orgQuery } from "./lib/functions";
import { parseOrThrow } from "./lib/validate";
import { vRetention } from "./validators";

/**
 * Phase 5 retention.
 *
 * What is purged, per organization, once older than its retention period
 * (periods are clamped to the minimums in `lib/retention.ts` every time):
 *
 *  - Visit records (`visitRecordsDays`): ANONYMISED, not deleted, so report
 *    counts, durations and busiest hours stay intact. The visit's badge code
 *    is cleared; the visitor's name, phone, email and company are replaced
 *    once none of their visits or appointments remain inside the period.
 *    `visitEvents` hold only ids and timestamps (no personal data) and stay.
 *    On-site visits are never touched.
 *  - Audit log (`auditLogDays`, minimum 1 year): deleted. This is the one
 *    sanctioned deletion from an otherwise append-only table.
 *  - Attendance (`attendanceDays`, minimum 1 year): events and decided
 *    correction requests are deleted (also an append-only exception, taken
 *    only past the retention period). Pending corrections are kept.
 *
 * Work is done in bounded batches. `dryRun` reports exactly what an
 * execution would do without changing anything.
 */
const DEFAULT_BATCH = 200;
const MAX_BATCH = 500;
const ORG_PAGE = 25;
export const ANONYMISED_NAME = "Anonymised visitor";

export type ExpiredCounts = {
  visits: number;
  visitors: number;
  auditLogs: number;
  attendanceEvents: number;
  attendanceCorrections: number;
};

async function collectExpired(ctx: QueryCtx, org: Doc<"organizations">, now: number, batch: number) {
  const retention = resolveRetention(org.retention);
  const orgId = org._id;
  const visitCutoff = now - retention.visitRecordsDays * DAY_MS;
  const auditCutoff = now - retention.auditLogDays * DAY_MS;
  const attendanceCutoff = now - retention.attendanceDays * DAY_MS;

  const visits = await ctx.db
    .query("visits")
    .withIndex("by_org_anon", (q) =>
      q.eq("organizationId", orgId).eq("anonymisedAt", undefined).lt("createdAt", visitCutoff),
    )
    .filter((q) => q.neq(q.field("status"), "on_site"))
    .take(batch);

  // A visitor is anonymised only when nothing else still needs them.
  const inBatch = new Set<string>(visits.map((x) => x._id));
  const visitorIds: Id<"visitors">[] = [];
  for (const visitorId of new Set(visits.map((x) => x.visitorId))) {
    const visitor = await ctx.db.get(visitorId);
    if (!visitor || visitor.organizationId !== orgId || visitor.anonymisedAt !== undefined) continue;
    const others = await ctx.db
      .query("visits")
      .withIndex("by_visitor", (q) => q.eq("visitorId", visitorId))
      .take(100);
    if (others.some((o) => o.anonymisedAt === undefined && !inBatch.has(o._id))) continue;
    const appointments = await ctx.db
      .query("appointments")
      .withIndex("by_visitor", (q) => q.eq("visitorId", visitorId))
      .take(100);
    if (appointments.some((a) => a.scheduledStart >= visitCutoff)) continue;
    visitorIds.push(visitorId);
  }

  const auditLogs = await ctx.db
    .query("auditLogs")
    .withIndex("by_org_at", (q) => q.eq("organizationId", orgId).lt("at", auditCutoff))
    .take(batch);

  const attendanceEvents: Id<"attendanceEvents">[] = [];
  const sites = await ctx.db
    .query("sites")
    .withIndex("by_org", (q) => q.eq("organizationId", orgId))
    .take(200);
  for (const site of sites) {
    if (attendanceEvents.length >= batch) break;
    const rows = await ctx.db
      .query("attendanceEvents")
      .withIndex("by_site_at", (q) => q.eq("siteId", site._id).lt("at", attendanceCutoff))
      .take(batch - attendanceEvents.length);
    attendanceEvents.push(...rows.map((r) => r._id));
  }

  const corrections: Id<"attendanceCorrections">[] = [];
  for (const status of ["approved", "rejected"] as const) {
    if (corrections.length >= batch) break;
    const rows = await ctx.db
      .query("attendanceCorrections")
      .withIndex("by_org_status", (q) =>
        q.eq("organizationId", orgId).eq("status", status).lt("createdAt", attendanceCutoff),
      )
      .take(batch - corrections.length);
    corrections.push(...rows.map((r) => r._id));
  }

  const counts: ExpiredCounts = {
    visits: visits.length,
    visitors: visitorIds.length,
    auditLogs: auditLogs.length,
    attendanceEvents: attendanceEvents.length,
    attendanceCorrections: corrections.length,
  };
  const hasMore =
    visits.length >= batch ||
    auditLogs.length >= batch ||
    attendanceEvents.length >= batch ||
    corrections.length >= batch;
  return {
    retention,
    counts,
    hasMore,
    visitIds: visits.map((x) => x._id),
    visitorIds,
    auditIds: auditLogs.map((x) => x._id),
    attendanceEventIds: attendanceEvents,
    correctionIds: corrections,
  };
}

const batchOf = (n?: number) => Math.min(MAX_BATCH, Math.max(1, Math.floor(n ?? DEFAULT_BATCH)));

/** Current retention settings (resolved), with defaults and floors for the UI. */
export const get = orgQuery({
  args: {},
  handler: async (ctx) => {
    ctx.require("settings:manage");
    return {
      retention: resolveRetention(ctx.oc.org.retention),
      defaults: DEFAULT_RETENTION,
      minimums: MIN_RETENTION,
      maxDays: MAX_RETENTION_DAYS,
    };
  },
});

/** Read-only preview of what the next purge would affect (one batch). */
export const preview = orgQuery({
  args: {},
  handler: async (ctx) => {
    ctx.require("settings:manage");
    const { counts, hasMore } = await collectExpired(ctx, ctx.oc.org, Date.now(), MAX_BATCH);
    return { counts, hasMore };
  },
});

export const update = orgMutation({
  args: { retention: vRetention },
  handler: async (ctx, { retention }) => {
    ctx.require("settings:manage");
    const parsed = parseOrThrow(retentionSchema, retention);
    await ctx.db.patch(ctx.oc.org._id, { retention: parsed, updatedAt: Date.now() });
    await writeAudit(ctx, {
      organizationId: ctx.oc.org._id,
      actorUserId: ctx.oc.user._id,
      action: "organization.retention_updated",
      resourceType: "organization",
      resourceId: ctx.oc.org._id,
      metadata: { ...parsed },
    });
    return parsed;
  },
});

/**
 * Purge (or, with `dryRun`, only count) one batch of expired data for one
 * organization. Internal: reachable only from the scheduler, other server
 * functions, and tests. When an executing run fills its batch it schedules
 * itself again until nothing is left.
 */
export const purgeExpired = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    dryRun: v.boolean(),
    now: v.optional(v.number()),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ dryRun: boolean; counts: ExpiredCounts; hasMore: boolean }> => {
    const org = await ctx.db.get(args.organizationId);
    const empty: ExpiredCounts = { visits: 0, visitors: 0, auditLogs: 0, attendanceEvents: 0, attendanceCorrections: 0 };
    if (!org) return { dryRun: args.dryRun, counts: empty, hasMore: false };
    const now = args.now ?? Date.now();
    const batch = batchOf(args.batchSize);
    const found = await collectExpired(ctx, org, now, batch);
    if (args.dryRun) return { dryRun: true, counts: found.counts, hasMore: found.hasMore };

    for (const id of found.visitIds) {
      await ctx.db.patch(id, { badgeCode: undefined, anonymisedAt: now });
    }
    for (const id of found.visitorIds) {
      await ctx.db.patch(id, {
        name: ANONYMISED_NAME,
        phone: undefined,
        email: undefined,
        company: undefined,
        anonymisedAt: now,
        updatedAt: now,
      });
    }
    for (const id of found.auditIds) await ctx.db.delete(id);
    for (const id of found.attendanceEventIds) await ctx.db.delete(id);
    for (const id of found.correctionIds) await ctx.db.delete(id);

    const total = Object.values(found.counts).reduce((a, b) => a + b, 0);
    if (total > 0) {
      await writeAudit(ctx, {
        organizationId: org._id,
        action: "retention.purged",
        resourceType: "retention",
        resourceId: org._id,
        metadata: { ...found.counts, system: true },
      });
    }
    if (found.hasMore) {
      await ctx.scheduler.runAfter(0, internal.retention.purgeExpired, {
        organizationId: org._id,
        dryRun: false,
        batchSize: args.batchSize,
      });
    }
    return { dryRun: false, counts: found.counts, hasMore: found.hasMore };
  },
});

/**
 * Entry point for the daily cron: fans out `purgeExpired` to every
 * organization, a page at a time. Register it with `registerRetentionCron`
 * from `convex/lib/retentionCron.ts` in `convex/crons.ts` (owned by N1).
 */
export const sweepAll = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }): Promise<{ scheduled: number }> => {
    const page = await ctx.db
      .query("organizations")
      .withIndex("by_created")
      .paginate({ numItems: ORG_PAGE, cursor: cursor ?? null });
    for (const org of page.page) {
      await ctx.scheduler.runAfter(0, internal.retention.purgeExpired, {
        organizationId: org._id,
        dryRun: false,
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.retention.sweepAll, { cursor: page.continueCursor });
    }
    return { scheduled: page.page.length };
  },
});
