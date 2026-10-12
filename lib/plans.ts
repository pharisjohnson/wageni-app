/**
 * Display-only plan catalogue for the marketing site. Commercial terms are
 * not final and nothing here is enforced: entitlement enforcement arrives in
 * Phase 7, driven by plan records in the database rather than this file.
 */
export type PlanDisplay = {
  id: string;
  name: string;
  priceLabel: string;
  description: string;
  features: string[];
  highlighted?: boolean;
};

export const PLANS: PlanDisplay[] = [
  {
    id: "starter",
    name: "Starter",
    priceLabel: "Free trial",
    description: "For a single office replacing a paper visitor book.",
    features: ["1 site", "Visitor kiosk", "Host approvals", "Staff attendance", "CSV exports"],
  },
  {
    id: "business",
    name: "Business",
    priceLabel: "Contact us",
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
    name: "Enterprise",
    priceLabel: "Contact us",
    description: "For government agencies, hospitals and large campuses.",
    features: [
      "Everything in Business",
      "Webhooks and integrations",
      "Custom retention policies",
      "Dedicated deployment (planned)",
    ],
  },
];
