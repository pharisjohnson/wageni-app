import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

/**
 * Per-IP counters (`ip:<scope>:<hash>`) add one `publicRateLimits` row per
 * client and scope. A row whose window began more than 26 hours ago can never
 * block anyone again (the longest window is the 24 hour walk-in budget), so it
 * is deleted.
 * Bounded per run; a full batch schedules another run.
 */
const STALE_MS = 26 * 60 * 60 * 1000; // longest window is the 24 hour walk-in budget (H1)
const DEFAULT_BATCH = 300;

export const sweepStale = internalMutation({
  args: { now: v.optional(v.number()), batchSize: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ deleted: number; hasMore: boolean }> => {
    const batch = Math.min(500, Math.max(1, Math.floor(args.batchSize ?? DEFAULT_BATCH)));
    const now = args.now ?? Date.now();
    const rows = await ctx.db
      .query("publicRateLimits")
      .withIndex("by_window", (q) => q.lt("windowStart", now - STALE_MS))
      .take(batch);
    for (const row of rows) await ctx.db.delete(row._id);
    const hasMore = rows.length >= batch;
    if (hasMore) await ctx.scheduler.runAfter(0, internal.publicLimits.sweepStale, { batchSize: args.batchSize });
    return { deleted: rows.length, hasMore };
  },
});
