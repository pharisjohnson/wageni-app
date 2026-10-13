/**
 * Plan entitlements: the single, pure definition of what each plan tier
 * includes. Shared by Convex (authoritative enforcement), the billing page and
 * the marketing catalogue (lib/plans.ts), so they cannot drift apart.
 *
 * Tiers map to Clerk Billing plans by SLUG (PLAN_SLUG_TIER) and/or by the
 * Clerk FEATURE slugs a plan carries (FEATURES below are also the exact Clerk
 * feature slugs). A known plan slug wins; for unknown slugs the features the
 * plan carries decide, so renaming a plan in the Clerk Dashboard does not
 * break entitlements as long as its features keep their slugs.
 */

export const TIERS = ["free", "business", "enterprise"] as const;
export type Tier = (typeof TIERS)[number];

export const TIER_LABELS: Record<Tier, string> = {
  free: "Starter",
  business: "Business",
  enterprise: "Enterprise",
};

/** Feature keys. These are ALSO the Clerk Dashboard feature slugs: create them with exactly these names. */
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

/**
 * Clerk plan slug (lower case) -> tier. Edit if the plans are named
 * differently in the Clerk Dashboard. Unknown slugs fall back to the features
 * the plan carries (see resolveTier), then to `free`.
 */
export const PLAN_SLUG_TIER: Record<string, Tier> = {
  free: "free",
  free_user: "free",
  starter: "free",
  business: "business",
  enterprise: "enterprise",
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

const TIER_RANK: Record<Tier, number> = { free: 0, business: 1, enterprise: 2 };

export function isFeature(value: string): value is Feature {
  return (FEATURES as readonly string[]).includes(value);
}

/**
 * Tier for a Clerk plan. A known plan slug wins; otherwise the highest tier
 * whose features are ALL present in `featureSlugs`; otherwise `free`.
 */
export function resolveTier(planSlug: string | undefined | null, featureSlugs: readonly string[] = []): Tier {
  const bySlug = planSlug ? PLAN_SLUG_TIER[planSlug.toLowerCase()] : undefined;
  if (bySlug) return bySlug;
  const have = new Set(featureSlugs);
  let tier: Tier = "free";
  for (const t of ["business", "enterprise"] as const) {
    const needed = TIER_FEATURES[t];
    if (needed.length > 0 && needed.every((f) => have.has(f))) tier = t;
  }
  return tier;
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

// ---- Subscription status handling (shared by the webhook mapping and the resolver) ----

export const SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due", "canceled", "ended"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Past-due payments keep access this long, then the organization drops to Starter. */
export const PAST_DUE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Safety net if an "ended" webhook is ever missed: an active row whose period
 * ended longer ago than this no longer grants access.
 */
export const STALE_PERIOD_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

export type SubscriptionLike = {
  planSlug: string;
  featureSlugs?: string[];
  status: SubscriptionStatus;
  currentPeriodEnd?: number;
  pastDueAt?: number;
  updatedAt: number;
};

/**
 * Does this subscription grant its plan right now? Downgrades are by time
 * only: canceled plans last until the period they paid for ends; past-due
 * plans get PAST_DUE_GRACE_MS; ended ones are over.
 */
export function subscriptionGrantsAccess(s: SubscriptionLike, now: number): boolean {
  switch (s.status) {
    case "ended":
      return false;
    case "canceled":
      return s.currentPeriodEnd !== undefined && now < s.currentPeriodEnd;
    case "past_due":
      return now < (s.pastDueAt ?? s.updatedAt) + PAST_DUE_GRACE_MS;
    case "active":
    case "trialing":
      return s.currentPeriodEnd === undefined || now < s.currentPeriodEnd + STALE_PERIOD_GRACE_MS;
  }
}

/** The best tier granted by a set of subscription rows (one per Clerk subscription item). */
export function effectiveTier<T extends SubscriptionLike>(
  rows: readonly T[],
  now: number,
): { tier: Tier; row: T | null } {
  let tier: Tier = "free";
  let best: T | null = null;
  for (const row of rows) {
    if (!subscriptionGrantsAccess(row, now)) continue;
    const t = resolveTier(row.planSlug, row.featureSlugs);
    if (best === null || TIER_RANK[t] > TIER_RANK[tier]) {
      tier = t;
      best = row;
    }
  }
  return { tier, row: best };
}

/** Calendar month key in UTC, e.g. "2026-10". */
export function monthKey(now: number): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
