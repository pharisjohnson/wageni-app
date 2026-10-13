import { TIER_LABELS, TIER_LIMITS, type Tier } from "@/lib/billing/entitlements";

/**
 * Marketing catalogue. Numbers are read from the entitlement tables in
 * lib/billing/entitlements.ts so the pricing page, home page, billing page and
 * server enforcement describe the same plans.
 */
export type PlanDisplay = {
  id: string;
  tier: Tier;
  name: string;
  priceLabel: string;
  description: string;
  features: string[];
  highlighted?: boolean;
};

/**
 * PLACEHOLDERS. No real prices have been decided. Prices live in the Clerk
 * Dashboard (USD only); put the customer-facing text here once they are set.
 */
export const PLAN_PRICE_LABELS: Record<Tier, string> = {
  free: "Free",
  business: "USD price to be announced",
  enterprise: "Contact us",
};

/**
 * Length of the Business free trial in days, for DISPLAY only. The trial
 * itself is configured on the plan in the Clerk Dashboard. Leave null to say
 * just "free trial" without a number.
 */
export const BUSINESS_TRIAL_DAYS: number | null = null;

export const BUSINESS_TRIAL_LABEL = BUSINESS_TRIAL_DAYS ? `${BUSINESS_TRIAL_DAYS}-day free trial` : "Free trial";

const free = TIER_LIMITS.free;

export const PLANS: PlanDisplay[] = [
  {
    id: "starter",
    tier: "free",
    name: TIER_LABELS.free,
    priceLabel: PLAN_PRICE_LABELS.free,
    description: "For a single office replacing a paper visitor book.",
    features: [
      `${free.sites} site`,
      "Visitor kiosk",
      "Host approvals",
      "Staff attendance",
      "CSV exports",
      `Up to ${free.staff} staff and ${free.visitsPerMonth} visits a month`,
    ],
  },
  {
    id: "business",
    tier: "business",
    name: TIER_LABELS.business,
    priceLabel: `${BUSINESS_TRIAL_LABEL}, then ${PLAN_PRICE_LABELS.business.toLowerCase()}`,
    description: "For organizations with several sites, gates and reception teams.",
    features: [
      "Multiple sites and gates",
      "Receptionist booking",
      "Custom registration forms",
      "Email and SMS notifications",
      "Audit log",
    ],
    highlighted: true,
  },
  {
    id: "enterprise",
    tier: "enterprise",
    name: TIER_LABELS.enterprise,
    priceLabel: PLAN_PRICE_LABELS.enterprise,
    description: "For government agencies, hospitals and large campuses.",
    features: [
      "Everything in Business",
      "Webhooks and integrations",
      "Custom retention policies",
      "Unlimited sites, staff and visits",
      "Dedicated deployment (planned)",
    ],
  },
];
