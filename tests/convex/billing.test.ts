import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { signSvix } from "../../lib/billing/svix";
import { addMember, createOrgWithOwner, expectCode, newTest, signIn, type T } from "./setup";

const SECRET = `whsec_${btoa("0123456789abcdef0123456789abcdef")}`;
const DAY = 86_400_000;

beforeEach(() => {
  delete process.env.BILLING_ENFORCEMENT;
  delete process.env.CLERK_WEBHOOK_SECRET;
});
afterEach(() => {
  delete process.env.BILLING_ENFORCEMENT;
  delete process.env.CLERK_WEBHOOK_SECRET;
});

const on = () => {
  process.env.BILLING_ENFORCEMENT = "on";
};

type Sub = {
  planSlug?: string;
  status?: "active" | "trialing" | "past_due" | "canceled" | "ended";
  currentPeriodEnd?: number;
  pastDueAt?: number;
  isFreeTrial?: boolean;
  itemId?: string;
};

/** Owner's Clerk user id in tests: `signIn` uses tokenIdentifier `test|<name>`. */
async function subscribe(t: T, clerkUserId: string, s: Sub = {}) {
  await t.run(async (ctx) => {
    await ctx.db.insert("subscriptions", {
      clerkUserId,
      clerkItemId: s.itemId ?? `item_${clerkUserId}`,
      planSlug: s.planSlug ?? "business",
      status: s.status ?? "active",
      isFreeTrial: s.isFreeTrial ?? false,
      currentPeriodEnd: s.currentPeriodEnd ?? Date.now() + 20 * DAY,
      pastDueAt: s.pastDueAt,
      lastEventId: "evt",
      lastEventAt: Date.now(),
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

  test("owner's business subscription unlocks sites, forms, audit and counts limits", async () => {
    on();
    const t = newTest();
    const o = await org(t);
    await subscribe(t, o.clerkId);
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
    await subscribe(t, o.clerkId, { planSlug: "business" });
    const cur = await o.owner.as.query(api.retention.get, o.args);
    const custom = { ...cur.defaults, visitRecordsDays: cur.defaults.visitRecordsDays + 10 };
    await expectCode(o.owner.as.mutation(api.retention.update, { ...o.args, retention: custom }), "PLAN_LIMIT");
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("subscriptions").collect())[0]!;
      await ctx.db.patch(row._id, { planSlug: "enterprise" });
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

describe("owner-based resolution", () => {
  test("the plan is the OWNER's, not the caller's", async () => {
    on();
    const t = newTest();
    const o = await org(t);
    const admin = await addMember(t, o.organizationId, "adminA", "admin");
    // A subscription held by the admin does nothing for the organization.
    await subscribe(t, "adminA");
    await expectCode(admin.as.mutation(api.sites.create, { ...o.args, ...site("Xtra") }), "PLAN_LIMIT");
    // The owner's subscription applies to everyone acting in the organization.
    await subscribe(t, o.clerkId);
    await admin.as.mutation(api.sites.create, { ...o.args, ...site("Xtra") });
  });

  test("another organization's owner subscription does not leak", async () => {
    on();
    const t = newTest();
    const a = await org(t, "alpha");
    const b = await org(t, "beta");
    await subscribe(t, a.clerkId);
    await b.owner.as.mutation(api.sites.create, { ...b.args, ...site("Xtra") }).then(
      () => {
        throw new Error("should be blocked");
      },
      (e: { data: { code: string } }) => expect(e.data.code).toBe("PLAN_LIMIT"),
    );
    await a.owner.as.mutation(api.sites.create, { ...a.args, ...site("Xtra") });
  });
});

describe("status handling and downgrades", () => {
  test("past_due keeps access for 7 days then drops to free", async () => {
    on();
    const t = newTest();
    const o = await org(t);
    await subscribe(t, o.clerkId, { status: "past_due", pastDueAt: Date.now() - 3 * DAY });
    expect((await o.owner.as.query(api.billing.entitlements, o.args)).tier).toBe("business");
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("subscriptions").collect())[0]!;
      await ctx.db.patch(row._id, { pastDueAt: Date.now() - 8 * DAY });
    });
    expect((await o.owner.as.query(api.billing.entitlements, o.args)).tier).toBe("free");
  });

  test("canceled keeps the plan until period end; ended is free immediately", async () => {
    on();
    const t = newTest();
    const o = await org(t);
    await subscribe(t, o.clerkId, { status: "canceled", currentPeriodEnd: Date.now() + 2 * DAY });
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
    await subscribe(t, o.clerkId);
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

    await subscribe(t, o.clerkId);
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

  test("overview needs billing:manage; non-members get NOT_FOUND; holder flag and owner name", async () => {
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
    // An admin granted billing:manage sees that the plan is the owner's.
    await t.run(async (ctx) =>
      ctx.db.patch(admin.membershipId, { permissionOverrides: { grant: ["billing:manage"], revoke: [] } }),
    );
    const view = await admin.as.query(api.billing.overview, o.args);
    expect(view.isSubscriptionHolder).toBe(false);
    expect(view.ownerName).toBe("acme-owner");
    const own = await o.owner.as.query(api.billing.overview, o.args);
    expect(own.isSubscriptionHolder).toBe(true);
    expect(own.ownerName).toBeNull();
    // Any member can read plan facts (no billing identity in it).
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
      ["_id", "enforced", "fileBytes", "files", "gates", "isDemo", "limits", "name", "notifications", "sites", "slug", "staff", "status", "subscriptionStatus", "tier", "visits"].sort(),
    );
  });
});

describe("clerk billing webhook", () => {
  const event = (over: Record<string, unknown> = {}, type = "subscriptionItem.active", timestamp = Date.now()) =>
    JSON.stringify({
      type,
      object: "event",
      timestamp,
      data: {
        id: "csubi_1",
        status: "active",
        period_end: Date.now() + 30 * DAY,
        plan: { slug: "business" },
        payer: { user_id: "acme-owner", email: "x@example.com" },
        ...over,
      },
    });

  async function post(t: T, body: string, opts: { id?: string; ts?: number; sign?: boolean; secret?: string } = {}) {
    const id = opts.id ?? `msg_${Math.random().toString(36).slice(2)}`;
    const ts = String(Math.floor((opts.ts ?? Date.now()) / 1000));
    const signature = opts.sign === false ? "v1,invalid" : await signSvix(opts.secret ?? SECRET, id, ts, body);
    return await t.fetch("/webhooks/clerk-billing", {
      method: "POST",
      body,
      headers: { "svix-id": id, "svix-timestamp": ts, "svix-signature": signature },
    });
  }
  const rows = (t: T) => t.run(async (ctx) => ctx.db.query("subscriptions").collect());

  test("no secret configured: the route does not exist", async () => {
    const t = newTest();
    expect((await post(t, event())).status).toBe(404);
  });

  test("valid delivery creates a subscription row and unlocks the owner's organization", async () => {
    process.env.CLERK_WEBHOOK_SECRET = SECRET;
    on();
    const t = newTest();
    const o = await org(t);
    expect((await post(t, event({ is_free_trial: true }))).status).toBe(200);
    const [row] = await rows(t);
    expect(row).toMatchObject({ clerkUserId: "acme-owner", planSlug: "business", status: "trialing", isFreeTrial: true });
    expect(row!.trialEndsAt).toBeGreaterThan(Date.now());
    expect(JSON.stringify(row)).not.toContain("example.com");
    expect(await o.owner.as.query(api.billing.entitlements, o.args)).toMatchObject({ tier: "business" });
    const ov = await o.owner.as.query(api.billing.overview, o.args);
    expect(ov.subscription).toMatchObject({ status: "trialing", isFreeTrial: true });
  });

  test("bad signature, wrong secret, missing headers and replayed (stale) timestamps are rejected generically", async () => {
    process.env.CLERK_WEBHOOK_SECRET = SECRET;
    const t = newTest();
    const body = event();
    expect((await post(t, body, { sign: false })).status).toBe(401);
    expect((await post(t, body, { secret: `whsec_${btoa("another-secret-another-secret-123")}` })).status).toBe(401);
    expect((await post(t, body, { ts: Date.now() - 10 * 60 * 1000 })).status).toBe(401);
    expect((await t.fetch("/webhooks/clerk-billing", { method: "POST", body })).status).toBe(401);
    expect((await post(t, "not json")).status).toBe(400);
    expect(await rows(t)).toHaveLength(0);
  });

  test("idempotent on svix-id: a redelivery changes nothing", async () => {
    process.env.CLERK_WEBHOOK_SECRET = SECRET;
    const t = newTest();
    await post(t, event(), { id: "msg_same" });
    // Same id, different (e.g. forged-after-the-fact) content: ignored as duplicate.
    await post(t, event({ status: "ended" }, "subscriptionItem.ended"), { id: "msg_same" });
    const all = await rows(t);
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe("active");
    expect(await t.run(async (ctx) => ctx.db.query("processedWebhooks").collect())).toHaveLength(1);
  });

  test("lifecycle: past_due then canceled then ended; older events never overwrite newer ones", async () => {
    process.env.CLERK_WEBHOOK_SECRET = SECRET;
    const t = newTest();
    const t0 = Date.now();
    await post(t, event({}, "subscriptionItem.active", t0));
    await post(t, event({ status: "past_due", past_due_at: t0 + 10 }, "subscriptionItem.pastDue", t0 + 10));
    expect((await rows(t))[0]).toMatchObject({ status: "past_due", pastDueAt: t0 + 10 });
    await post(t, event({ status: "canceled", canceled_at: t0 + 20 }, "subscriptionItem.canceled", t0 + 20));
    expect((await rows(t))[0]!.status).toBe("canceled");
    // late delivery of an older event
    await post(t, event({}, "subscriptionItem.active", t0 + 5));
    expect((await rows(t))[0]!.status).toBe("canceled");
    await post(t, event({ status: "ended" }, "subscriptionItem.ended", t0 + 30));
    expect((await rows(t))[0]!.status).toBe("ended");
    expect(await rows(t)).toHaveLength(1);
  });

  test("other event families are acknowledged without changes; upcoming items create no row", async () => {
    process.env.CLERK_WEBHOOK_SECRET = SECRET;
    const t = newTest();
    expect((await post(t, event({}, "paymentAttempt.created"))).status).toBe(200);
    expect((await post(t, event({}, "subscription.active"))).status).toBe(200);
    expect((await post(t, event({ status: "upcoming" }, "subscriptionItem.upcoming"))).status).toBe(200);
    expect(await rows(t)).toHaveLength(0);
  });

  test("processed ids are swept after their TTL", async () => {
    const t = newTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("processedWebhooks", { eventId: "old", processedAt: Date.now() - 8 * DAY });
      await ctx.db.insert("processedWebhooks", { eventId: "new", processedAt: Date.now() });
    });
    await t.mutation(internal.billingWebhook.sweepProcessed, {});
    const left = await t.run(async (ctx) => ctx.db.query("processedWebhooks").collect());
    expect(left.map((r) => r.eventId)).toEqual(["new"]);
  });
});
