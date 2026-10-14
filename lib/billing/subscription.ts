import {
  effectiveStatus,
  TIER_RANK,
  type PaidPlanKey,
  type SubscriptionStatus,
} from "./entitlements";
import type { BillingPeriod } from "./pricing";

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One period is a fixed number of days (monthly = 30, annual = 365), so the
 * arithmetic is deterministic and easy to explain to customers: M-Pesa is paid
 * once per period and there is no automatic renewal.
 */
export const PERIOD_DAYS: Record<BillingPeriod, number> = { monthly: 30, annual: 365 };

export type SubState = {
  planKey: PaidPlanKey;
  period?: BillingPeriod;
  status: SubscriptionStatus;
  currentPeriodStart: number;
  currentPeriodEnd: number;
  trialEndsAt?: number;
};

export type Extension = { planKey: PaidPlanKey; period: BillingPeriod; currentPeriodStart: number; currentPeriodEnd: number };

/**
 * New period for a successful payment.
 *
 * - No subscription, ended, in grace, or a trial: the paid period starts now
 *   (a trial is replaced; paying early does not stack onto it).
 * - Same plan still running: the new period starts at the CURRENT END, so an
 *   early renewal stacks (no days are lost). Monthly -> annual works the same way.
 * - Upgrade (business -> enterprise) while running: starts NOW at the new
 *   plan; the unused remainder of the old plan is not credited (no proration;
 *   the UI warns before paying).
 * - A payment for a LOWER plan while a higher one is running cannot happen
 *   through checkout (it is refused up front). If it still arrives (a
 *   manual grant landed in between), the higher plan is kept and extended by the
 *   paid length, so the customer never loses what they paid for.
 */
export function extendSubscription(existing: SubState | null, pay: { planKey: PaidPlanKey; period: BillingPeriod }, now: number): Extension {
  const length = PERIOD_DAYS[pay.period] * DAY_MS;
  const live = existing && effectiveStatus(existing, now) === "active" && existing.status !== "trialing";
  if (!existing || !live) {
    return { planKey: pay.planKey, period: pay.period, currentPeriodStart: now, currentPeriodEnd: now + length };
  }
  const start = Math.max(now, existing.currentPeriodEnd);
  if (existing.planKey === pay.planKey) {
    return { planKey: pay.planKey, period: pay.period, currentPeriodStart: start, currentPeriodEnd: start + length };
  }
  if (TIER_RANK[pay.planKey] > TIER_RANK[existing.planKey]) {
    return { planKey: pay.planKey, period: pay.period, currentPeriodStart: now, currentPeriodEnd: now + length };
  }
  return {
    planKey: existing.planKey,
    period: existing.period ?? pay.period,
    currentPeriodStart: existing.currentPeriodStart,
    currentPeriodEnd: start + length,
  };
}

/** Would starting a checkout for `planKey` be a downgrade of a still-running plan? (Downgrades happen only at period end.) */
export function isBlockedDowngrade(existing: SubState | null, planKey: PaidPlanKey, now: number): boolean {
  if (!existing) return false;
  const s = effectiveStatus(existing, now);
  if (s !== "active") return false;
  return TIER_RANK[planKey] < TIER_RANK[existing.planKey];
}
