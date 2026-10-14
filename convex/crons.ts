import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
import { registerRetentionCron } from "./lib/retentionCron";

/**
 * Scheduled jobs. Each is idempotent, so an overlapping or repeated run is safe.
 */
const crons = cronJobs();

// --- N1: notifications
crons.interval("notification reminders", { minutes: 15 }, internal.notificationsCron.scanReminders, {});
crons.interval("staff attendance reminders", { minutes: 30 }, internal.notificationsCron.scanStaff, {});
crons.interval("notification outbox retry", { minutes: 10 }, internal.notificationsCron.retryStale, {});
crons.daily("notification outbox purge", { hourUTC: 2, minuteUTC: 30 }, internal.notificationsCron.purgeOld, {});
// --- end N1

// --- P1: retention (fans out internal.retention.purgeExpired per organization)
registerRetentionCron(crons);
// --- end P1

// --- F2: upload leftovers and per-IP counters
// Per-field answer redaction (internal.formRetention.redactExpired) is fanned out per
// organization by the P1 sweep above (internal.retention.sweepAll).
crons.interval("abandoned upload sweep", { minutes: 30 }, internal.files.sweepOrphans, {});
crons.daily("stale rate limit sweep", { hourUTC: 3, minuteUTC: 0 }, internal.publicLimits.sweepStale, {});
// --- end F2

// --- B2: PayHero billing
// Resolve payments whose callback was lost, then tidy subscription statuses and send renewal reminders.
crons.interval("billing payment reconcile", { minutes: 1 }, internal.billingPayhero.reconcile, {});
crons.interval("billing subscription lifecycle", { minutes: 30 }, internal.billingLifecycle.sweep, {});
// --- end B2

// --- Wiring notes (see docs/architecture.md, "Scheduled jobs").
// P1 and F1 own these functions. They are NOT registered yet because the
// functions are not on this branch (a cron naming a missing function fails
// typecheck and deploy). When each lands, uncomment its line:
//
// crons.daily("retention purge", { hourUTC: 1, minuteUTC: 0 }, internal.retention.purgeExpired, {});   // P1
crons.daily("expired file cleanup", { hourUTC: 1, minuteUTC: 30 }, internal.files.purgeExpired, {}); // F1
// --- end wiring notes

export default crons;
