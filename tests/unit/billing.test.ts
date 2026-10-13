import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { errorMessage, isPlanLimit, planLimitInfo } from "../../lib/auth/errors";
import {
  effectiveTier,
  entitlementsForTier,
  FEATURES,
  minTierFor,
  minTierForLimit,
  monthKey,
  PAST_DUE_GRACE_MS,
  resolveTier,
  subscriptionGrantsAccess,
  TIER_FEATURES,
  TIER_LIMITS,
  type SubscriptionLike,
} from "../../lib/billing/entitlements";
import { parseBillingEvent, toMs } from "../../lib/billing/events";
import { signSvix, verifySvix } from "../../lib/billing/svix";
import { PLANS } from "../../lib/plans";

const SECRET = `whsec_${btoa("0123456789abcdef0123456789abcdef")}`;
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
const ts = (ms: number) => String(Math.floor(ms / 1000));

describe("svix signature", () => {
  const body = JSON.stringify({ type: "subscriptionItem.active" });
  const id = "msg_123";

  test("accepts a valid signature", async () => {
    const sig = await signSvix(SECRET, id, ts(NOW), body);
    expect(await verifySvix({ secret: SECRET, id, timestamp: ts(NOW), signature: sig, body, nowMs: NOW })).toBe(true);
  });

  test("accepts when one of several signatures matches", async () => {
    const sig = await signSvix(SECRET, id, ts(NOW), body);
    expect(
      await verifySvix({ secret: SECRET, id, timestamp: ts(NOW), signature: `v1,AAAA ${sig}`, body, nowMs: NOW }),
    ).toBe(true);
  });

  test("rejects tampered body, id, timestamp, wrong secret and missing parts", async () => {
    const sig = await signSvix(SECRET, id, ts(NOW), body);
    const base = { secret: SECRET, id, timestamp: ts(NOW), signature: sig, body, nowMs: NOW };
    expect(await verifySvix({ ...base, body: body + " " })).toBe(false);
    expect(await verifySvix({ ...base, id: "msg_other" })).toBe(false);
    expect(await verifySvix({ ...base, timestamp: ts(NOW + 1000) })).toBe(false);
    expect(await verifySvix({ ...base, secret: `whsec_${btoa("another-secret-another-secret-123")}` })).toBe(false);
    expect(await verifySvix({ ...base, signature: null })).toBe(false);
    expect(await verifySvix({ ...base, id: null })).toBe(false);
    expect(await verifySvix({ ...base, signature: "v2," + sig.slice(3) })).toBe(false);
    expect(await verifySvix({ ...base, secret: "" })).toBe(false);
  });

  test("rejects outside the 5 minute window (past and future), accepts inside", async () => {
    const old = NOW - 6 * 60 * 1000;
    const sig = await signSvix(SECRET, id, ts(old), body);
    expect(await verifySvix({ secret: SECRET, id, timestamp: ts(old), signature: sig, body, nowMs: NOW })).toBe(false);
    const future = NOW + 6 * 60 * 1000;
    const sig2 = await signSvix(SECRET, id, ts(future), body);
    expect(await verifySvix({ secret: SECRET, id, timestamp: ts(future), signature: sig2, body, nowMs: NOW })).toBe(false);
    const near = NOW - 4 * 60 * 1000;
    const sig3 = await signSvix(SECRET, id, ts(near), body);
    expect(await verifySvix({ secret: SECRET, id, timestamp: ts(near), signature: sig3, body, nowMs: NOW })).toBe(true);
  });
});

function item(over: Record<string, unknown> = {}, type = "subscriptionItem.active") {
  return {
    type,
    object: "event",
    timestamp: NOW,
    data: {
      id: "csubi_1",
      status: "active",
      period_start: NOW - 1000,
      period_end: NOW + 30 * 86400000,
      plan: { slug: "business", name: "Business" },
      payer: { user_id: "user_1", email: "x@example.com" },
      ...over,
    },
  };
}

describe("billing event mapping", () => {
  test("active paid item", () => {
    const e = parseBillingEvent(item(), NOW)!;
    expect(e).toMatchObject({
      clerkUserId: "user_1",
      clerkItemId: "csubi_1",
      planSlug: "business",
      status: "active",
      isFreeTrial: false,
      currentPeriodEnd: NOW + 30 * 86400000,
    });
  });

  test("free trial becomes trialing", () => {
    expect(parseBillingEvent(item({ is_free_trial: true }), NOW)!.status).toBe("trialing");
  });

  test("canceled, past_due, ended, expired", () => {
    expect(parseBillingEvent(item({ status: "canceled", canceled_at: NOW }, "subscriptionItem.canceled"), NOW)!.status).toBe("canceled");
    const pd = parseBillingEvent(item({ status: "past_due", past_due_at: NOW - 5 }, "subscriptionItem.pastDue"), NOW)!;
    expect(pd.status).toBe("past_due");
    expect(pd.pastDueAt).toBe(NOW - 5);
    expect(parseBillingEvent(item({ status: "ended" }, "subscriptionItem.ended"), NOW)!.status).toBe("ended");
    expect(parseBillingEvent(item({ status: "expired" }), NOW)!.status).toBe("ended");
  });

  test("not-yet-entitled statuses map to null status", () => {
    for (const status of ["upcoming", "abandoned", "incomplete"]) {
      expect(parseBillingEvent(item({ status }), NOW)!.status).toBeNull();
    }
  });

  test("ignores other event families, organization payers and malformed payloads", () => {
    expect(parseBillingEvent({ ...item(), type: "subscription.active" }, NOW)).toBeNull();
    expect(parseBillingEvent({ ...item(), type: "paymentAttempt.created" }, NOW)).toBeNull();
    expect(parseBillingEvent(item({ payer: { organization_id: "org_1" } }), NOW)).toBeNull();
    expect(parseBillingEvent(item({ status: "wat" }), NOW)).toBeNull();
    expect(parseBillingEvent(null, NOW)).toBeNull();
    expect(parseBillingEvent({ type: "subscriptionItem.active" }, NOW)).toBeNull();
  });

  test("reads plan features when present and normalises seconds to ms", () => {
    const e = parseBillingEvent(item({ plan: { slug: "x", features: [{ slug: "audit_log" }, { nope: 1 }] }, period_end: 1_900_000_000 }), NOW)!;
    expect(e.featureSlugs).toEqual(["audit_log"]);
    expect(e.currentPeriodEnd).toBe(1_900_000_000_000);
    expect(toMs(-1)).toBeUndefined();
  });
});

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

  test("tier resolution by slug, then by features, else free", () => {
    expect(resolveTier("Business")).toBe("business");
    expect(resolveTier("enterprise")).toBe("enterprise");
    expect(resolveTier("renamed", [...TIER_FEATURES.business])).toBe("business");
    expect(resolveTier("renamed", [...FEATURES])).toBe("enterprise");
    expect(resolveTier("renamed", ["audit_log"])).toBe("free");
    expect(resolveTier(undefined)).toBe("free");
  });

  const base: SubscriptionLike = { planSlug: "business", status: "active", updatedAt: NOW };
  test("access by status and time", () => {
    expect(subscriptionGrantsAccess({ ...base, currentPeriodEnd: NOW + 1000 }, NOW)).toBe(true);
    expect(subscriptionGrantsAccess({ ...base, status: "trialing", currentPeriodEnd: NOW + 1000 }, NOW)).toBe(true);
    expect(subscriptionGrantsAccess({ ...base, status: "ended" }, NOW)).toBe(false);
    expect(subscriptionGrantsAccess({ ...base, status: "canceled", currentPeriodEnd: NOW + 1000 }, NOW)).toBe(true);
    expect(subscriptionGrantsAccess({ ...base, status: "canceled", currentPeriodEnd: NOW - 1 }, NOW)).toBe(false);
    expect(subscriptionGrantsAccess({ ...base, status: "canceled" }, NOW)).toBe(false);
    expect(subscriptionGrantsAccess({ ...base, status: "past_due", pastDueAt: NOW - PAST_DUE_GRACE_MS + 1000 }, NOW)).toBe(true);
    expect(subscriptionGrantsAccess({ ...base, status: "past_due", pastDueAt: NOW - PAST_DUE_GRACE_MS - 1 }, NOW)).toBe(false);
    // a missed "ended" webhook does not grant access forever
    expect(subscriptionGrantsAccess({ ...base, currentPeriodEnd: NOW - 10 * 86400000 }, NOW)).toBe(false);
  });

  test("best tier among several items", () => {
    const rows: SubscriptionLike[] = [
      { ...base, planSlug: "free_user" },
      { ...base, planSlug: "business", currentPeriodEnd: NOW + 1000 },
      { ...base, planSlug: "enterprise", status: "ended" },
    ];
    expect(effectiveTier(rows, NOW).tier).toBe("business");
    expect(effectiveTier([], NOW).tier).toBe("free");
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
