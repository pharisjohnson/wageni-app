import type { PaidPlanKey } from "./entitlements";

/**
 * Plan prices in Kenyan shillings (whole KES; M-Pesa STK push takes integers).
 *
 * `null` means "not set": checkout is DISABLED for that plan and period, and
 * every page says "KES price to be announced". No prices have been decided, so
 * nothing here is invented. To go live, put integers in here (for example
 * `monthly: 4500`) and redeploy; amounts are read from this file on the server
 * when a payment is created, never from the browser or a callback.
 */
export type BillingPeriod = "monthly" | "annual";
export const BILLING_PERIODS: readonly BillingPeriod[] = ["monthly", "annual"];
export const PAID_PLAN_KEYS: readonly PaidPlanKey[] = ["business", "enterprise"];

export const PLAN_PRICES_KES: Record<PaidPlanKey, Record<BillingPeriod, number | null>> = {
  business: { monthly: null, annual: null },
  enterprise: { monthly: null, annual: null },
};

/**
 * Length of the Business free trial in days (a subscription row with status
 * `trialing`, started by the organization owner without payment, once per
 * organization). `null` = no trial offered.
 */
export const BUSINESS_TRIAL_DAYS: number | null = null;

/** The configured price, or null when unset (or not a positive whole number). */
export function priceFor(
  planKey: PaidPlanKey,
  period: BillingPeriod,
  table: Record<PaidPlanKey, Record<BillingPeriod, number | null>> = PLAN_PRICES_KES,
): number | null {
  const p = table[planKey][period];
  return typeof p === "number" && Number.isInteger(p) && p > 0 ? p : null;
}

export function formatKes(amount: number): string {
  return `KES ${amount.toLocaleString("en-KE")}`;
}

/** Customer-facing price text. */
export function priceLabel(planKey: PaidPlanKey, period: BillingPeriod): string {
  const p = priceFor(planKey, period);
  return p === null ? "KES price to be announced" : `${formatKes(p)} ${period === "monthly" ? "per month" : "per year"}`;
}

export function trialDays(): number | null {
  return typeof BUSINESS_TRIAL_DAYS === "number" && BUSINESS_TRIAL_DAYS > 0 ? Math.floor(BUSINESS_TRIAL_DAYS) : null;
}
