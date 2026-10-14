import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { addMember, createOrgWithOwner, expectCode, newTest, signIn, type T } from "./setup";

const DAY = 86_400_000;

beforeEach(() => {
  delete process.env.BILLING_ENFORCEMENT;
});
afterEach(() => {
  delete process.env.BILLING_ENFORCEMENT;
});

const on = () => {
  process.env.BILLING_ENFORCEMENT = "on";
};

type Sub = {
  planKey?: "business" | "enterprise";
  status?: "active" | "trialing" | "past_due" | "canceled" | "ended";
  currentPeriodEnd?: number;
  source?: "payment" | "trial" | "manual";
};

/** Give an organization a subscription row (what a verified payment, trial or grant produces). */
async function subscribe(t: T, organizationId: Id<"organizations">, s: Sub = {}) {
  await t.run(async (ctx) => {
    const end = s.currentPeriodEnd ?? Date.now() + 20 * DAY;
    await ctx.db.insert("subscriptions", {
      organizationId,
      planKey: s.planKey ?? "business",
      period: "monthly",
      status: s.status ?? "active",
      currentPeriodStart: end - 30 * DAY,
      currentPeriodEnd: end,
      source: s.source ?? "payment",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

async function org(t: T, slug = "acme") {
  const o = await createOrgWithOwner(t, slug, slug);
  return { ...o, clerkId: `${slug}-owner`, args: { organizationId: o.organizationId } };
}

const site = (n: string) => ({ name: n, timeZone: "Africa/Nairobi" });

describe("enforcement switch", () => {
  test("off (default): everything is unlocked, whatever the plan", async () => {
    const t = newTest();
    const o = await org(t);
    await o.owner.as.mutation(api.sites.create, { ...o.args, ...site("Second") });
    await o.owner.as.mutation(api.forms.create, { ...o.args, name: "Custom", audience: "visitor" });
    const ent = await o.owner.as.query(api.billing.entitlements, o.args);
    expect(ent).toMatchObject({ enforced: false, tier: "enterprise" });
  });

  test("any value other than 'on' does not enforce", async () => {
    process.env.BILLING_ENFORCEMENT = "true";
    const t = newTest();
    const o = await org(t);
    await o.owner.as.mutation(api.sites.create, { ...o.args, ...site("Second") });
  });

  test("demo organizations bypass enforcement", async () => {
    on();
    const t = newTest();
    const o = await org(t);
    await t.run(async (ctx) => ctx.db.patch(o.organizationId, { isDemo: true }));
    await o.owner.as.mutation(api.sites.create, { ...o.args, ...site("Second") });
    expect((await o.owner.as.query(api.billing.entitlements, o.args)).enforced).toBe(false);
  });
});

describe("limits with enforcement on", () => {
  test("free tier: second site is blocked with PLAN_LIMIT, first plan facts exposed", async () => {
    on();
    const t = newTest();
    const o = await org(t);
    const err = await o.owner.as
      .mutation(api.sites.create, { ...o.args, ...site("Second") })
      .catch((e: { data: Record<string, unknown> }) => e);
    expect(err).toMatchObject({ data: { code: "PLAN_LIMIT", kind: "limit", key: "sites", limit: 1, requiredTier: "business" } });
    expect(await o.owner.as.query(api.billing.entitlements, o.args)).toMatchObject({ enforced: true, tier: "free" });
  });

  test("organization's business subscription unlocks sites, forms, audit and counts limits", async () => {
    on();
    const t = newTest();
    const o = await org(t);
    await subscribe(t, o.organizationId);
    for (let i = 0; i < 9; i++) await o.owner.as.mutation(api.sites.create, { ...o.args, ...site(`S${i}`) });
    // 1 default + 9 = 10 = business limit
    await expectCode(o.owner.as.mutation(api.sites.create, { ...o.args, ...site("Over") }), "PLAN_LIMIT");
    await o.owner.as.mutation(api.forms.create, { ...o.args, name: "Custom", audience: "visitor" });
    const log = await o.owner.as.query(api.audit.list, { ...o.args, paginationOpts: { numItems: 5, cursor: null } });
    expect(log.page.length).toBeGreaterThan(0);
  });

  test("gates: free allows 3, the 4th is blocked", async () => {
    on();
    const t = newTest();
    const o = await org(t);
    for (let i = 0; i < 3; i++) {
      await o.owner.as.mutation(api.gates.create, { ...o.args, siteId: o.siteId, name: `G${i}`, type: "pedestrian" });
    }
    await expectCode(
      o.owner.as.mutation(api.gates.create, { ...o.args, siteId: o.siteId, name: "G4", type: "pedestrian" }),
      "PLAN_LIMIT",
    );
  });

  test("free tier: custom forms and audit log are blocked, retention defaults still save", async () => {
    on();
    const t = newTest();
    const o = await org(t);
    await expectCode(o.owner.as.mutation(api.forms.create, { ...o.args, name: "F", audience: "visitor" }), "PLAN_LIMIT");
    await expectCode(o.owner.as.query(api.audit.list, { ...o.args, paginationOpts: { numItems: 5, cursor: null } }), "PLAN_LIMIT");
    await expectCode(o.owner.as.query(api.audit.actors, o.args), "PLAN_LIMIT");
    const cur = await o.owner.as.query(api.retention.get, o.args);
    expect(cur.canCustomize).toBe(false);
    await o.owner.as.mutation(api.retention.update, { ...o.args, retention: cur.defaults });
    await expectCode(
      o.owner.as.mutation(api.retention.update, {
        ...o.args,
        retention: { ...cur.defaults, visitRecordsDays: cur.defaults.visitRecordsDays + 10 },
      }),
      "PLAN_LIMIT",
    );
  });

  test("business: custom retention still needs enterprise; enterprise allows it", async () => {
    on();
    const t = newTest();
    const o = await org(t);
    await subscribe(t, o.organizationId, { planKey: "business" });
    const cur = await o.owner.as.query(api.retention.get, o.args);
    const custom = { ...cur.defaults, visitRecordsDays: cur.defaults.visitRecordsDays + 10 };
    await expectCode(o.owner.as.mutation(api.retention.update, { ...o.args, retention: custom }), "PLAN_LIMIT");
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("subscriptions").collect())[0]!;
      await ctx.db.patch(row._id, { planKey: "enterprise" });
    });
    await o.owner.as.mutation(api.retention.update, { ...o.args, retention: custom });
  });

  test("staff limit: re-activating members beyond the plan is blocked", async () => {
    on();
    const t = newTest();
    const o = await org(t);
    const members = [];
    for (let i = 0; i < 9; i++) members.push(await addMember(t, o.organizationId, `m${i}`, "staff")); // owner + 9 = 10
    await o.owner.as.mutation(api.memberships.setStatus, {
      ...o.args,
      membershipId: members[0]!.membershipId,
      status: "disabled",
    });
    const extra = await addMember(t, o.organizationId, "extra", "staff"); // back to 10
    await expectCode(
      o.owner.as.mutation(api.memberships.setStatus, { ...o.args, membershipId: members[0]!.membershipId, status: "active" }),
      "PLAN_LIMIT",
    );
    expect(extra.membershipId).toBeTruthy();
  });
});

describe("organization-owned subscriptions", () => {
  test("the plan belongs to the organization: any member acts under it, a member's own other org does not matter", async () => {
    on();
    const t = newTest();
    const o = await org(t);
    const admin = await addMember(t, o.organizationId, "adminA", "admin");
    await expectCode(admin.as.mutation(api.sites.create, { ...o.args, ...site("Xtra") }), "PLAN_LIMIT");
    await subscribe(t, o.organizationId);
    await admin.as.mutation(api.sites.create, { ...o.args, ...site("Xtra") });
  });

  test("another organization's subscription does not leak", async () => {
    on();
    const t = newTest();
    const a = await org(t, "alpha");
    const b = await org(t, "beta");
    await subscribe(t, a.organizationId);
    await expectCode(b.owner.as.mutation(api.sites.create, { ...b.args, ...site("Xtra") }), "PLAN_LIMIT");
    await a.owner.as.mutation(api.sites.create, { ...a.args, ...site("Xtra") });
    expect(await b.owner.as.query(api.billing.entitlements, b.args)).toMatchObject({ tier: "free" });
  });
});

describe("status handling and downgrades", () => {
  test("an active period that ended keeps access for the 7-day grace (even before the cron runs), then drops to free", async () => {
    on();
    const t = newTest();
    const o = await org(t);
    await subscribe(t, o.organizationId, { status: "past_due", currentPeriodEnd: Date.now() - 3 * DAY });
    expect((await o.owner.as.query(api.billing.entitlements, o.args)).tier).toBe("business");
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("subscriptions").collect())[0]!;
      await ctx.db.patch(row._id, { currentPeriodEnd: Date.now() - 8 * DAY });
    });
    expect((await o.owner.as.query(api.billing.entitlements, o.args)).tier).toBe("free");
  });

  test("canceled keeps the plan until period end; ended is free immediately", async () => {
    on();
    const t = newTest();
    const o = await org(t);
    await subscribe(t, o.organizationId, { status: "canceled", currentPeriodEnd: Date.now() + 2 * DAY });
    expect((await o.owner.as.query(api.billing.entitlements, o.args)).tier).toBe("business");
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("subscriptions").collect())[0]!;
      await ctx.db.patch(row._id, { currentPeriodEnd: Date.now() - 1000 });
    });
    expect((await o.owner.as.query(api.billing.entitlements, o.args)).tier).toBe("free");
  });

  test("downgrade never deletes: extra sites stay readable but read-only, no new ones", async () => {
    on();
    const t = newTest();
    const o = await org(t);
    await subscribe(t, o.organizationId);
    const second = await o.owner.as.mutation(api.sites.create, { ...o.args, ...site("Second") });
    await o.owner.as.mutation(api.forms.create, { ...o.args, name: "Custom", audience: "visitor" });
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("subscriptions").collect())[0]!;
      await ctx.db.patch(row._id, { status: "ended" });
    });
    // Nothing was deleted and everything is still listed.
    const sites = await o.owner.as.query(api.sites.list, o.args);
    expect(sites.map((s) => s.name).sort()).toEqual(["Head Office", "Second"]);
    expect((await o.owner.as.query(api.sites.get, { ...o.args, siteId: second })).name).toBe("Second");
    const forms = await t.run(async (ctx) => ctx.db.query("forms").collect());
    expect(forms).toHaveLength(1);
    // Cannot create more, cannot edit the extra site; the first site is still editable.
    await expectCode(o.owner.as.mutation(api.sites.create, { ...o.args, ...site("Third") }), "PLAN_LIMIT");
    await expectCode(
      o.owner.as.mutation(api.sites.update, { ...o.args, siteId: second, ...site("Renamed"), status: "active" }),
      "PLAN_LIMIT",
    );
    await o.owner.as.mutation(api.sites.update, { ...o.args, siteId: o.siteId, ...site("Head Office 2"), status: "active" });
    // Deactivating the extra site is allowed.
    await o.owner.as.mutation(api.sites.update, { ...o.args, siteId: second, ...site("Second"), status: "inactive" });
  });
});

describe("notifications gating", () => {
  async function queued(t: T, organizationId: Id<"organizations">) {
    return await t.run(async (ctx) =>
      ctx.db.insert("notificationOutbox", {
        organizationId,
        channel: "email",
        eventType: "test_message",
        templateKey: "test_message",
        recipientKind: "visitor",
        to: "a@example.com",
        payload: { orgName: "Acme" },
        status: "queued",
        attempts: 0,
        idempotencyKey: `k${Math.random()}`,
        createdAt: Date.now(),
      }),
    );
  }

  test("free tier is dry-run only; business sends live and counts usage; limit skips", async () => {
    on();
    const t = newTest();
    const o = await org(t);
    const free = await t.mutation(internal.notificationsDelivery.claim, { outboxId: await queued(t, o.organizationId) });
    expect(free?.dryRunOnly).toBe(true);

    await subscribe(t, o.organizationId);
    const paid = await t.mutation(internal.notificationsDelivery.claim, { outboxId: await queued(t, o.organizationId) });
    expect(paid?.dryRunOnly).toBe(false);

    const id = await queued(t, o.organizationId);
    await t.mutation(internal.notificationsDelivery.claim, { outboxId: id });
    await t.mutation(internal.notificationsDelivery.complete, { outboxId: id, ok: true, mode: "live" });
    const usage = await t.run(async (ctx) => ctx.db.query("usageCounters").collect());
    expect(usage.find((u) => u.key === "notifications")?.value).toBe(1);

    // Exhaust the monthly allowance: the next message is skipped, not sent.
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("usageCounters").collect()).find((u) => u.key === "notifications")!;
      await ctx.db.patch(row._id, { value: 2000 });
    });
    const over = await queued(t, o.organizationId);
    expect(await t.mutation(internal.notificationsDelivery.claim, { outboxId: over })).toBeNull();
    expect((await t.run(async (ctx) => ctx.db.get(over)))?.lastError).toBe("plan_limit");
  });

  test("with enforcement off, delivery uses the configured providers", async () => {
    const t = newTest();
    const o = await org(t);
    const job = await t.mutation(internal.notificationsDelivery.claim, { outboxId: await queued(t, o.organizationId) });
    expect(job?.dryRunOnly).toBe(false);
  });
});

describe("usage counters and billing queries", () => {
  test("visits are counted per organization and month, files via bumpUsage", async () => {
    const t = newTest();
    const a = await org(t, "alpha");
    const b = await org(t, "beta");
    for (let i = 0; i < 2; i++) {
      await a.owner.as.mutation(api.visits.registerWalkIn, {
        ...a.args,
        siteId: a.siteId,
        visitor: { name: `V${i}`, phone: `+25470000000${i}` },
        purpose: "Delivery",
      });
    }
    const ov = await a.owner.as.query(api.billing.overview, a.args);
    expect(ov.usage.visitsPerMonth).toBe(2);
    expect((await b.owner.as.query(api.billing.overview, b.args)).usage.visitsPerMonth).toBe(0);
    expect(ov.month).toMatch(/^\d{4}-\d{2}$/);
  });

  test("overview needs billing:manage; non-members get NOT_FOUND", async () => {
    on();
    const t = newTest();
    const o = await org(t);
    const admin = await addMember(t, o.organizationId, "adminA", "admin");
    const reception = await addMember(t, o.organizationId, "rita", "receptionist");
    const outsider = await signIn(t, "outsider");
    await expectCode(admin.as.query(api.billing.overview, o.args), "FORBIDDEN");
    await expectCode(reception.as.query(api.billing.overview, o.args), "FORBIDDEN");
    await expectCode(outsider.as.query(api.billing.overview, o.args), "NOT_FOUND");
    await expectCode(outsider.as.query(api.billing.entitlements, o.args), "NOT_FOUND");
    const own = await o.owner.as.query(api.billing.overview, o.args);
    expect(own.subscription.status).toBeNull();
    expect(own.recentPayments).toEqual([]);
    // Any member can read plan facts (no payment details in it).
    expect(await reception.as.query(api.billing.entitlements, o.args)).toMatchObject({ tier: "free" });
  });

  test("platform usage is platform-admin only and metadata only", async () => {
    const t = newTest();
    const o = await org(t);
    const root = await signIn(t, "root");
    await expectCode(
      o.owner.as.query(api.billing.platformUsage, { paginationOpts: { numItems: 10, cursor: null } }),
      "FORBIDDEN",
    );
    await t.mutation(internal.platform.grantSuperAdmin, { email: "root@example.com" });
    const res = await root.as.query(api.billing.platformUsage, { paginationOpts: { numItems: 10, cursor: null } });
    expect(res.page).toHaveLength(1);
    expect(Object.keys(res.page[0]!).sort()).toEqual(
      ["_id", "enforced", "fileBytes", "files", "gates", "isDemo", "limits", "name", "notifications", "sites", "slug", "staff", "status", "subscriptionEnd", "subscriptionSource", "subscriptionStatus", "tier", "visits"].sort(),
    );
  });
});
