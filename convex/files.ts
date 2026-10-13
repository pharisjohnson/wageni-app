import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { deleteExpiredFiles, sweepOrphanUploads, type OrphanSweepResult } from "./lib/files";

/**
 * Retention for stored files, scheduled in convex/crons.ts. The function
 * deletes bytes whose `deleteAfter` has passed (including pending uploads that
 * no response claimed within an hour), keeps the `files` row as "deleted", and
 * audits each deletion. It handles up to 200 files per run and is safe to run
 * repeatedly.
 */
export const purgeExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    return await deleteExpiredFiles(ctx, Date.now());
  },
});

const DEFAULT_BATCH = 100;
const MAX_BATCH = 500;

/**
 * Sweep abandoned uploads (see `sweepOrphanUploads`): expired upload intents,
 * unclaimed pending files and never-registered blobs. Bounded per run; when a
 * batch fills up it schedules itself again. Registered in convex/crons.ts.
 */
export const sweepOrphans = internalMutation({
  args: { now: v.optional(v.number()), batchSize: v.optional(v.number()) },
  handler: async (ctx, args): Promise<OrphanSweepResult> => {
    const batch = Math.min(MAX_BATCH, Math.max(1, Math.floor(args.batchSize ?? DEFAULT_BATCH)));
    const result = await sweepOrphanUploads(ctx, args.now ?? Date.now(), batch);
    if (result.hasMore) {
      await ctx.scheduler.runAfter(0, internal.files.sweepOrphans, { batchSize: args.batchSize });
    }
    return result;
  },
});
