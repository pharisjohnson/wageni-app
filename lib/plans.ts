import { TIER_LABELS, TIER_LIMITS, type Tier } from "@/lib/billing/entitlements";
import { formatKes, priceFor, trialDays } from "@/lib/billing/pricing";

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
 * Customer-facing price text, read from lib/billing/pricing.ts so there is one
 * place to set prices. Unset prices say so honestly; nothing is invented.
 */
function monthlyLabel(tier: "business" | "enterprise", fallback: string): string {
  const m = priceFor(tier, "monthly");
  const a = priceFor(tier, "annual");
  if (m === null && a === null) return fallback;
  return [m !== null ? `${formatKes(m)} per month` : null, a !== null ? `${formatKes(a)} per year` : null]
    .filter(Boolean)
    .join(" or ");
}

export const PLAN_PRICE_LABELS: Record<Tier, string> = {
  free: "Free",
  business: monthlyLabel("business", "KES price to be announced"),
  enterprise: monthlyLabel("enterprise", "Contact us"),
};

/** Trial wording. The trial itself is `BUSINESS_TRIAL_DAYS` in lib/billing/pricing.ts (null = none). */
const days = trialDays();
export const BUSINESS_TRIAL_LABEL = days ? `${days}-day free trial` : "";

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
    priceLabel: BUSINESS_TRIAL_LABEL ? `${BUSINESS_TRIAL_LABEL}, then ${PLAN_PRICE_LABELS.business}` : PLAN_PRICE_LABELS.business,
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
