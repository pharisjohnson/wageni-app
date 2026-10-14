import { PAST_DUE_GRACE_MS, TIER_LABELS } from "../lib/billing/entitlements";
import { DAY_MS } from "../lib/billing/subscription";
import { internalMutation } from "./_generated/server";
import { billingLink, formatDate, notifyBillingManagers } from "./lib/billingNotify";

/** Renewal reminders go out this many days before the period ends (the tightest threshold reached wins). */
export const REMINDER_DAYS = [7, 3, 1] as const;
const BATCH = 100;

/**
 * Cron: subscription lifecycle. Access itself never depends on this job (it is
 * derived from time in `effectiveStatus`); this keeps the stored status honest
 * and sends the reminders. Idempotent: notification keys are per period end.
 * Nothing is ever deleted: ending a subscription only drops the plan to Starter.
 *
 * - trialing, trial over            -> ended
 * - active, period over             -> past_due  (+ "plan ended, grace until ..." notice)
 * - past_due, grace over            -> ended
 * - active, ending within 7 days    -> renewal reminder (7, 3 or 1 days before)
 */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    const trials = await ctx.db
      .query("subscriptions")
      .withIndex("by_status_end", (q) => q.eq("status", "trialing").lte("currentPeriodEnd", now))
      .take(BATCH);
    for (const s of trials) await ctx.db.patch(s._id, { status: "ended", updatedAt: now });

    const lapsed = await ctx.db
      .query("subscriptions")
      .withIndex("by_status_end", (q) => q.eq("status", "active").lte("currentPeriodEnd", now))
      .take(BATCH);
    for (const s of lapsed) {
      await ctx.db.patch(s._id, { status: "past_due", updatedAt: now });
      if (s.source === "manual") continue;
      const org = await ctx.db.get(s.organizationId);
      await notifyBillingManagers(
        ctx,
        s.organizationId,
        "billing_plan_expired",
        {
          orgName: org?.name ?? "your organization",
          planName: TIER_LABELS[s.planKey],
          graceEnd: formatDate(s.currentPeriodEnd + PAST_DUE_GRACE_MS, org?.timeZone),
          link: billingLink(),
        },
        `billing_expired:${s.organizationId}:${s.currentPeriodEnd}`,
      );
    }

    const overdue = await ctx.db
      .query("subscriptions")
      .withIndex("by_status_end", (q) => q.eq("status", "past_due").lte("currentPeriodEnd", now - PAST_DUE_GRACE_MS))
      .take(BATCH);
    for (const s of overdue) await ctx.db.patch(s._id, { status: "ended", updatedAt: now });

    const soon = await ctx.db
      .query("subscriptions")
      .withIndex("by_status_end", (q) =>
        q.eq("status", "active").gt("currentPeriodEnd", now).lte("currentPeriodEnd", now + REMINDER_DAYS[0] * DAY_MS),
      )
      .take(BATCH * 2);
    let reminded = 0;
    for (const s of soon) {
      if (s.source === "manual") continue;
      const days = [...REMINDER_DAYS].reverse().find((d) => s.currentPeriodEnd - d * DAY_MS <= now);
      if (days === undefined) continue;
      const org = await ctx.db.get(s.organizationId);
      await notifyBillingManagers(
        ctx,
        s.organizationId,
        "billing_renewal_reminder",
        {
          orgName: org?.name ?? "your organization",
          planName: TIER_LABELS[s.planKey],
          endDate: formatDate(s.currentPeriodEnd, org?.timeZone),
          daysLeft: String(days),
          link: billingLink(),
        },
        `billing_renew:${s.organizationId}:${s.currentPeriodEnd}:${days}`,
      );
      reminded++;
    }
    return { trialsEnded: trials.length, lapsed: lapsed.length, ended: overdue.length, reminded };
  },
});
