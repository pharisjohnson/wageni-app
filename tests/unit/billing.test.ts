import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { errorMessage, isPlanLimit, planLimitInfo } from "../../lib/auth/errors";
import {
  effectiveStatus,
  entitlementsForTier,
  FEATURES,
  minTierFor,
  minTierForLimit,
  monthKey,
  PAST_DUE_GRACE_MS,
  subscriptionGrantsAccess,
  tierForSubscription,
  TIER_FEATURES,
  TIER_LIMITS,
  type SubscriptionLike,
} from "../../lib/billing/entitlements";
import { PLANS } from "../../lib/plans";

const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
const DAY = 86_400_000;

describe("entitlements model", () => {
  test("features and limits per tier", () => {
    expect(entitlementsForTier("free").features).toEqual([]);
    expect(TIER_FEATURES.business).not.toContain("webhooks_integrations");
    expect(TIER_FEATURES.business).not.toContain("custom_retention");
    expect([...TIER_FEATURES.enterprise].sort()).toEqual([...FEATURES].sort());
    expect(TIER_LIMITS.free.sites).toBe(1);
    expect(TIER_LIMITS.enterprise.sites).toBeNull();
    expect(minTierFor("audit_log")).toBe("business");
    expect(minTierFor("custom_retention")).toBe("enterprise");
    expect(minTierForLimit("sites", 1)).toBe("business");
    expect(minTierForLimit("sites", 10)).toBe("enterprise");
  });

  const base: SubscriptionLike = { planKey: "business", status: "active", currentPeriodEnd: NOW + 1000 };

  test("effective status is derived from time, not from the cron", () => {
    expect(effectiveStatus(base, NOW)).toBe("active");
    // period over: grace, then ended
    expect(effectiveStatus({ ...base, currentPeriodEnd: NOW - 1 }, NOW)).toBe("past_due");
    expect(effectiveStatus({ ...base, currentPeriodEnd: NOW - PAST_DUE_GRACE_MS + 1000 }, NOW)).toBe("past_due");
    expect(effectiveStatus({ ...base, currentPeriodEnd: NOW - PAST_DUE_GRACE_MS - 1 }, NOW)).toBe("ended");
    // a stored past_due row that was renewed is active again once its end moves forward
    expect(effectiveStatus({ ...base, status: "past_due", currentPeriodEnd: NOW + DAY }, NOW)).toBe("active");
  });

  test("access by status and time", () => {
    expect(subscriptionGrantsAccess(base, NOW)).toBe(true);
    expect(subscriptionGrantsAccess({ ...base, status: "trialing", trialEndsAt: NOW + 1000 }, NOW)).toBe(true);
    expect(subscriptionGrantsAccess({ ...base, status: "trialing", trialEndsAt: NOW - 1 }, NOW)).toBe(false);
    expect(subscriptionGrantsAccess({ ...base, status: "ended" }, NOW)).toBe(false);
    expect(subscriptionGrantsAccess({ ...base, status: "canceled" }, NOW)).toBe(true);
    expect(subscriptionGrantsAccess({ ...base, status: "canceled", currentPeriodEnd: NOW - 1 }, NOW)).toBe(false);
  });

  test("tier for a subscription row", () => {
    expect(tierForSubscription(null, NOW)).toEqual({ tier: "free", status: null });
    expect(tierForSubscription(base, NOW)).toEqual({ tier: "business", status: "active" });
    expect(tierForSubscription({ ...base, planKey: "enterprise" }, NOW).tier).toBe("enterprise");
    expect(tierForSubscription({ ...base, currentPeriodEnd: NOW - 8 * DAY }, NOW)).toEqual({ tier: "free", status: "ended" });
  });

  test("month key is UTC", () => {
    expect(monthKey(Date.UTC(2026, 0, 31, 23, 59))).toBe("2026-01");
    expect(monthKey(Date.UTC(2026, 11, 1, 0, 0))).toBe("2026-12");
  });
});

describe("marketing catalogue agrees with entitlements", () => {
  test("three plans, ids and tiers", () => {
    expect(PLANS.map((p) => p.tier)).toEqual(["free", "business", "enterprise"]);
    expect(PLANS[0]!.features.join(" ")).toContain(`${TIER_LIMITS.free.sites} site`);
    expect(PLANS[1]!.features).toContain("Audit log");
    expect(PLANS[2]!.features).toContain("Webhooks and integrations");
  });

  test("unset prices are stated honestly, in KES, never invented", () => {
    expect(PLANS[1]!.priceLabel).toContain("KES price to be announced");
    expect(PLANS.map((p) => p.priceLabel).join(" ")).not.toMatch(/USD|\$/);
  });
});

describe("PLAN_LIMIT error mapping", () => {
  const err = new ConvexError({ code: "PLAN_LIMIT", kind: "limit", key: "sites", limit: 1, message: "Upgrade please." });
  test("exposes details and message", () => {
    expect(isPlanLimit(err)).toBe(true);
    expect(planLimitInfo(err)).toMatchObject({ kind: "limit", key: "sites", limit: 1 });
    expect(errorMessage(err)).toBe("Upgrade please.");
  });
  test("other errors are not plan limits", () => {
    expect(isPlanLimit(new ConvexError({ code: "FORBIDDEN", message: "no" }))).toBe(false);
    expect(isPlanLimit(new Error("x"))).toBe(false);
  });
});
