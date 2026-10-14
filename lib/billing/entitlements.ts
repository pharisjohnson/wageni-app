/**
 * Plan entitlements: the single, pure definition of what each plan tier
 * includes. Shared by Convex (authoritative enforcement), the billing page and
 * the marketing catalogue (lib/plans.ts), so they cannot drift apart.
 *
 * A subscription (one row per organization, paid through PayHero M-Pesa, a
 * trial, or a manual grant) names a plan key (`business` | `enterprise`); the
 * tier is that key, or `free` when there is no usable subscription.
 */

export const TIERS = ["free", "business", "enterprise"] as const;
export type Tier = (typeof TIERS)[number];

export const TIER_LABELS: Record<Tier, string> = {
  free: "Starter",
  business: "Business",
  enterprise: "Enterprise",
};

/** Feature keys. */
export const FEATURES = [
  "multi_site",
  "custom_forms",
  "notifications",
  "audit_log",
  "webhooks_integrations",
  "custom_retention",
] as const;
export type Feature = (typeof FEATURES)[number];

export const FEATURE_LABELS: Record<Feature, string> = {
  multi_site: "Multiple sites",
  custom_forms: "Custom registration forms",
  notifications: "Email and SMS notifications",
  audit_log: "Audit log",
  webhooks_integrations: "Webhooks and integrations",
  custom_retention: "Custom retention policies",
};

/** Features included in each tier (a tier includes everything below it). */
export const TIER_FEATURES: Record<Tier, readonly Feature[]> = {
  free: [],
  business: ["multi_site", "custom_forms", "notifications", "audit_log"],
  enterprise: [...FEATURES],
};

/** null = unlimited. */
export type Limit = number | null;

export const LIMIT_KEYS = ["sites", "gates", "staff", "forms", "visitsPerMonth", "notificationsPerMonth"] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];

/**
 * Numeric limits per tier. These are PRODUCT DECISIONS, not technical
 * constants: change the numbers here and enforcement, the billing page and the
 * pricing copy all follow. `null` means unlimited.
 *
 * - sites / gates / staff: active records per organization.
 * - forms: non-archived custom forms (Starter has none; its kiosk uses the
 *   built-in registration fields).
 * - visitsPerMonth: shown on the billing page and metered, but NOT used to
 *   block check-ins (a gate must never refuse a visitor because of billing).
 * - notificationsPerMonth: live (non dry-run) messages; over the limit the
 *   message is recorded as skipped.
 */
export const TIER_LIMITS: Record<Tier, Record<LimitKey, Limit>> = {
  free: { sites: 1, gates: 3, staff: 10, forms: 0, visitsPerMonth: 200, notificationsPerMonth: 0 },
  business: { sites: 10, gates: 50, staff: 200, forms: 25, visitsPerMonth: 5000, notificationsPerMonth: 2000 },
  enterprise: {
    sites: null,
    gates: null,
    staff: null,
    forms: null,
    visitsPerMonth: null,
    notificationsPerMonth: null,
  },
};

export const LIMIT_LABELS: Record<LimitKey, string> = {
  sites: "Sites",
  gates: "Gates",
  staff: "Staff members",
  forms: "Custom forms",
  visitsPerMonth: "Visits this month",
  notificationsPerMonth: "Messages sent this month",
};

export const TIER_RANK: Record<Tier, number> = { free: 0, business: 1, enterprise: 2 };

export function isFeature(value: string): value is Feature {
  return (FEATURES as readonly string[]).includes(value);
}

export type Entitlements = {
  tier: Tier;
  features: readonly Feature[];
  limits: Record<LimitKey, Limit>;
};

export function entitlementsForTier(tier: Tier): Entitlements {
  return { tier, features: TIER_FEATURES[tier], limits: TIER_LIMITS[tier] };
}

export function tierHasFeature(tier: Tier, feature: Feature): boolean {
  return TIER_FEATURES[tier].includes(feature);
}

/** Lowest tier that includes a feature (for "Upgrade to ..." copy). */
export function minTierFor(feature: Feature): Tier {
  return TIERS.find((t) => tierHasFeature(t, feature)) ?? "enterprise";
}

/** Lowest tier whose limit for `key` is above `current` (or unlimited). */
export function minTierForLimit(key: LimitKey, current: number): Tier {
  return (
    TIERS.find((t) => {
      const l = TIER_LIMITS[t][key];
      return l === null || l > current;
    }) ?? "enterprise"
  );
}

// ---- Subscription status handling (shared by the resolver, the lifecycle cron and the UI) ----

export const SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due", "canceled", "ended"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** After a period ends unpaid, the plan stays usable (status past_due) this long, then the organization drops to Starter. */
export const PAST_DUE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export type PaidPlanKey = "business" | "enterprise";

export type SubscriptionLike = {
  planKey: PaidPlanKey;
  status: SubscriptionStatus;
  currentPeriodEnd: number;
  trialEndsAt?: number;
};

/**
 * The status that applies RIGHT NOW. Derived from time so that access never
 * depends on the lifecycle cron having run; the cron only tidies the stored
 * status and sends reminders.
 *
 * - trialing: until the trial ends, then ended.
 * - active / past_due: active until the period ends, past_due for
 *   PAST_DUE_GRACE_MS after it, then ended.
 * - canceled: access until the period end, then ended.
 */
export function effectiveStatus(s: SubscriptionLike, now: number): SubscriptionStatus {
  switch (s.status) {
    case "ended":
      return "ended";
    case "canceled":
      return now < s.currentPeriodEnd ? "canceled" : "ended";
    case "trialing":
      return now < (s.trialEndsAt ?? s.currentPeriodEnd) ? "trialing" : "ended";
    case "active":
    case "past_due":
      if (now < s.currentPeriodEnd) return "active";
      return now < s.currentPeriodEnd + PAST_DUE_GRACE_MS ? "past_due" : "ended";
  }
}

/** Does this subscription grant its plan right now? */
export function subscriptionGrantsAccess(s: SubscriptionLike, now: number): boolean {
  return effectiveStatus(s, now) !== "ended";
}

/** Tier (and effective status) for an organization's subscription row; `free` when none or over. */
export function tierForSubscription(
  row: SubscriptionLike | null,
  now: number,
): { tier: Tier; status: SubscriptionStatus | null } {
  if (!row) return { tier: "free", status: null };
  const status = effectiveStatus(row, now);
  return { tier: status === "ended" ? "free" : row.planKey, status };
}

/** Calendar month key in UTC, e.g. "2026-10". */
export function monthKey(now: number): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
