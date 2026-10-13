import type { SubscriptionStatus } from "./entitlements";

/**
 * Map a Clerk Billing webhook payload to the fields we store.
 *
 * Handled: every `subscriptionItem.*` event. The item's own `data.status` (not
 * the event name) decides the state, so out-of-order or repeated event types
 * cannot disagree with the payload. Verified payload fields (from
 * @clerk/backend's BillingSubscriptionItemWebhookEventJSON, @clerk/backend
 * 3.x): data.id, data.status, data.period_start, data.period_end,
 * data.canceled_at, data.past_due_at, data.plan.slug, data.plan_id,
 * data.payer.user_id, plus `is_free_trial` (documented by Clerk for
 * `subscriptionItem.active`, absent from the SDK type). Event envelope:
 * type, timestamp, data.
 *
 * NOT handled (acknowledged, no change): subscription.*, paymentAttempt.*.
 * Webhook plan objects carry no feature list, so the plan slug is what we map;
 * if a `features` array is present it is stored as extra signal.
 * Organization-payer items (no payer.user_id) are ignored: Wageni bills users.
 */
export type ParsedItemEvent = {
  clerkUserId: string;
  clerkItemId: string;
  planSlug: string;
  featureSlugs: string[];
  /** null = the item grants nothing yet (upcoming / abandoned / incomplete): do not create a row for it. */
  status: SubscriptionStatus | null;
  isFreeTrial: boolean;
  currentPeriodEnd?: number;
  pastDueAt?: number;
  canceledAt?: number;
  eventAt: number;
};

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown, max = 200) => (typeof x === "string" && x.length > 0 && x.length <= max ? x : undefined);

/** Clerk timestamps are milliseconds; tolerate seconds. */
export function toMs(x: unknown): number | undefined {
  if (typeof x !== "number" || !Number.isFinite(x) || x <= 0) return undefined;
  return x < 100_000_000_000 ? Math.round(x * 1000) : Math.round(x);
}

export const HANDLED_PREFIX = "subscriptionItem.";

export function parseBillingEvent(body: unknown, receivedAt: number): ParsedItemEvent | null {
  if (!isObj(body)) return null;
  const type = str(body.type);
  if (!type || !type.startsWith(HANDLED_PREFIX)) return null;
  const data = body.data;
  if (!isObj(data)) return null;

  const payer = isObj(data.payer) ? data.payer : undefined;
  const clerkUserId = str(payer?.user_id);
  const clerkItemId = str(data.id);
  if (!clerkUserId || !clerkItemId) return null;

  const plan = isObj(data.plan) ? data.plan : undefined;
  const planSlug = str(plan?.slug, 100) ?? "";
  const featureSlugs = Array.isArray(plan?.features)
    ? (plan.features as unknown[])
        .map((f) => (isObj(f) ? str(f.slug, 100) : undefined))
        .filter((s): s is string => Boolean(s))
        .slice(0, 50)
    : [];

  const isFreeTrial = data.is_free_trial === true;
  const periodEnd = toMs(data.period_end);
  const pastDueAt = toMs(data.past_due_at);
  const canceledAt = toMs(data.canceled_at);

  let status: SubscriptionStatus | null;
  switch (data.status) {
    case "active":
      status = isFreeTrial ? "trialing" : "active";
      break;
    case "past_due":
      status = "past_due";
      break;
    case "canceled":
      status = "canceled";
      break;
    case "ended":
    case "expired":
      status = "ended";
      break;
    case "upcoming":
    case "abandoned":
    case "incomplete":
      status = null;
      break;
    default:
      return null;
  }

  return {
    clerkUserId,
    clerkItemId,
    planSlug,
    featureSlugs,
    status,
    isFreeTrial,
    currentPeriodEnd: periodEnd,
    pastDueAt,
    canceledAt,
    eventAt: toMs(body.timestamp) ?? receivedAt,
  };
}
