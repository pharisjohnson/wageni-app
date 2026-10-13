import type { cronJobs } from "convex/server";
import { internal } from "../_generated/api";

/**
 * Register the daily retention sweep. P1 does not own `convex/crons.ts`;
 * N1 (or whoever creates it) calls this once:
 *
 *   import { cronJobs } from "convex/server";
 *   import { registerRetentionCron } from "./lib/retentionCron";
 *   const crons = cronJobs();
 *   registerRetentionCron(crons);
 *   export default crons;
 *
 * Runs at 02:30 UTC. Each run fans out one `retention.purgeExpired` per
 * organization; each of those works in bounded batches and reschedules
 * itself until the backlog is clear.
 */
export function registerRetentionCron(crons: ReturnType<typeof cronJobs>) {
  crons.daily("retention purge", { hourUTC: 2, minuteUTC: 30 }, internal.retention.sweepAll, {});
}
