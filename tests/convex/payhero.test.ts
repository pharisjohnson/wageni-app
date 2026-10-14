import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { PLAN_PRICES_KES } from "../../lib/billing/pricing";
import { hmacHex, sha256Hex } from "../../lib/billing/provider";
import { addMember, createOrgWithOwner, expectCode, newTest, signIn, type T } from "./setup";

const cfg = vi.hoisted(() => ({ trialDays: null as number | null }));
vi.mock("../../lib/billing/pricing", async (orig) => {
  const m = await orig<typeof import("../../lib/billing/pricing")>();
  return { ...m, trialDays: () => cfg.trialDays };
});

const DAY = 86_400_000;
const MIN = 60_000;
const PHONE = "0712345678";
const E164 = "+254712345678";
const ENV_KEYS = [
  "PAYHERO_MODE",
  "PAYHERO_AUTH_TOKEN",
  "PAYHERO_CHANNEL_ID",
  "PAYHERO_CALLBACK_BASE",
  "BILLING_ENFORCEMENT",
  "ALLOW_BILLING_SIMULATION",
  "BILLING_HASH_PEPPER",
  "ALLOW_DRY_RUN_BILLING",
];
const PEPPER = "pepper_secret_value_0123456789abcdef";

/** A scripted PayHero: records requests, answers STK pushes and status checks. */
function fakePayhero() {
  const state = {
    posts: [] as { url: string; body: Record<string, unknown>; auth: string | null }[],
    gets: [] as string[],
    status: new Map<string, Record<string, unknown>>(),
    initiate: "ok" as "ok" | "down" | "reject",
    fixedRef: null as string | null,
    n: 0,
  };
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (u.endsWith("/api/v2/payments") && init?.method === "POST") {
      state.posts.push({ url: u, body: JSON.parse(init.body as string), auth: headers.Authorization ?? null });
      if (state.initiate === "down") return new Response("{}", { status: 503 });
      if (state.initiate === "reject") return new Response("{}", { status: 400 });
      state.n++;
      return new Response(
        JSON.stringify({ success: true, status: "QUEUED", reference: state.fixedRef ?? `REF${state.n}ABCDEF`, CheckoutRequestID: `ws_CO_${state.n}` }),
        { status: 201 },
      );
    }
    if (u.includes("/api/v2/transaction-status")) {
      const ref = decodeURIComponent(new URL(u).searchParams.get("reference") ?? "");
      state.gets.push(ref);
      const body = state.status.get(ref) ?? { status: "QUEUED", reference: ref };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return {
    state,
    fn,
    /** What PayHero will report for a payment reference. */
    report: (reference: string, body: Record<string, unknown>) => state.status.set(reference, { reference, ...body }),
  };
}

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  cfg.trialDays = null;
  PLAN_PRICES_KES.business.monthly = 1000;
  PLAN_PRICES_KES.business.annual = 10_000;
  PLAN_PRICES_KES.enterprise.monthly = 3000;
  PLAN_PRICES_KES.enterprise.annual = null;
});
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  vi.unstubAllGlobals();
  PLAN_PRICES_KES.business.monthly = null;
  PLAN_PRICES_KES.business.annual = null;
  PLAN_PRICES_KES.enterprise.monthly = null;
  PLAN_PRICES_KES.enterprise.annual = null;
});

const live = () => {
  process.env.PAYHERO_MODE = "live";
  process.env.PAYHERO_AUTH_TOKEN = "tok_secret_abc";
  process.env.PAYHERO_CHANNEL_ID = "133";
  process.env.PAYHERO_CALLBACK_BASE = "https://happy-otter-1.convex.site/";
  process.env.BILLING_ENFORCEMENT = "on";
  process.env.BILLING_HASH_PEPPER = PEPPER;
};

async function setup(slug = "acme") {
  const t = newTest();
  const o = await createOrgWithOwner(t, slug, slug);
  return { t, ...o, args: { organizationId: o.organizationId } };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

const checkout = (o: Ctx, over: Partial<{ planKey: "business" | "enterprise"; period: "monthly" | "annual"; phone: string }> = {}) =>
  o.owner.as.action(api.billing.startCheckout, { ...o.args, planKey: "business", period: "monthly", phone: PHONE, ...over });

const payments = (t: T) => t.run(async (ctx) => ctx.db.query("billingPayments").collect());
const subs = (t: T) => t.run(async (ctx) => ctx.db.query("subscriptions").collect());
const outbox = (t: T, eventType: string) =>
  t.run(async (ctx) => (await ctx.db.query("notificationOutbox").collect()).filter((r) => r.eventType === eventType));
const audits = (t: T, action: string) =>
  t.run(async (ctx) => (await ctx.db.query("auditLogs").collect()).filter((r) => r.action === action));

/** The secret callback token PayHero was given for the nth STK push. */
const tokenOf = (ph: ReturnType<typeof fakePayhero>, n = 0) => String(ph.state.posts[n]!.body.callback_url).split("/").pop()!;

const callbackBody = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    forward_url: "",
    response: {
      Amount: 1000,
      CheckoutRequestID: "ws_CO_1",
      ExternalReference: undefined,
      MpesaReceiptNumber: "RGH1234ABC",
      ResultCode: 0,
      ResultDesc: "ok",
      Status: "Success",
      ...over,
    },
    status: true,
  });

const post = (t: T, token: string, body: string) => t.fetch(`/webhooks/payhero/${token}`, { method: "POST", body });

/** Let the next verification through the 3-second flood guard. */
const unthrottle = (t: T) =>
  t.run(async (ctx) => {
    for (const p of await ctx.db.query("billingPayments").collect()) await ctx.db.patch(p._id, { lastCheckedAt: undefined });
  });

const age = (t: T, ms: number) =>
  t.run(async (ctx) => {
    for (const p of await ctx.db.query("billingPayments").collect()) await ctx.db.patch(p._id, { createdAt: p.createdAt - ms });
  });

describe("starting a payment", () => {
  test("sends the documented request; amount and plan come from our config; no phone or token is stored", async () => {
    live();
    const ph = fakePayhero();
    const o = await setup();
    const res = await checkout(o);
    expect(res.status).toBe("pending");

    const [req] = ph.state.posts;
    expect(req!.url).toBe("https://backend.payhero.co.ke/api/v2/payments");
    expect(req!.auth).toBe("Basic tok_secret_abc");
    expect(req!.body).toMatchObject({ amount: 1000, phone_number: PHONE, channel_id: 133, provider: "m-pesa" });
    const token = tokenOf(ph);
    expect(String(req!.body.callback_url)).toBe(`https://happy-otter-1.convex.site/webhooks/payhero/${token}`);

    const [row] = await payments(o.t);
    expect(row).toMatchObject({ status: "pending", amountKes: 1000, planKey: "business", period: "monthly", phoneLast4: "5678", provider: "payhero" });
    expect(row!.payheroReference).toBe("REF1ABCDEF");
    expect(row!.callbackTokenHash).toBe(await sha256Hex(token));
    const dump = JSON.stringify(await o.t.run(async (ctx) => ({ p: await ctx.db.query("billingPayments").collect(), a: await ctx.db.query("auditLogs").collect() })));
    expect(dump).not.toContain("712345678");
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(E164);
  });

  test("a client cannot choose the amount: the action accepts no amount argument", async () => {
    live();
    fakePayhero();
    const o = await setup();
    await expect(
      o.owner.as.action(api.billing.startCheckout, { ...o.args, planKey: "business", period: "monthly", phone: PHONE, amountKes: 1 } as never),
    ).rejects.toThrow();
  });

  test("unset price: checkout is refused with a clear message and nothing is sent", async () => {
    live();
    const ph = fakePayhero();
    const o = await setup();
    await expectCode(checkout(o, { planKey: "enterprise", period: "annual" }), "VALIDATION");
    expect(ph.fn).not.toHaveBeenCalled();
    expect(await payments(o.t)).toHaveLength(0);
  });

  test("live mode without its configuration refuses checkout", async () => {
    live();
    delete process.env.PAYHERO_CHANNEL_ID;
    const ph = fakePayhero();
    const o = await setup();
    await expectCode(checkout(o), "VALIDATION");
    expect(ph.fn).not.toHaveBeenCalled();
    process.env.PAYHERO_CHANNEL_ID = "133";
    process.env.PAYHERO_CALLBACK_BASE = "http://insecure.example";
    await expectCode(checkout(o), "VALIDATION");
  });

  test("invalid phone numbers are rejected before anything is recorded", async () => {
    live();
    fakePayhero();
    const o = await setup();
    await expectCode(checkout(o, { phone: "12345" }), "VALIDATION");
    await expectCode(checkout(o, { phone: "+255712345678" }), "VALIDATION");
    expect(await payments(o.t)).toHaveLength(0);
  });

  test("local number formats are normalised for PayHero", async () => {
    live();
    const ph = fakePayhero();
    const o = await setup();
    await checkout(o, { phone: "+254 712-345-678" });
    expect(ph.state.posts[0]!.body.phone_number).toBe(PHONE);
  });

  test("PayHero outage: the payment is recorded as failed, with a friendly reason", async () => {
    live();
    const ph = fakePayhero();
    ph.state.initiate = "down";
    const o = await setup();
    expect((await checkout(o)).status).toBe("failed");
    expect((await payments(o.t))[0]).toMatchObject({ status: "failed", failureReason: "provider_unavailable" });
  });

  test("permissions: billing:manage only; outsiders and anonymous callers are refused", async () => {
    live();
    const ph = fakePayhero();
    const o = await setup();
    const admin = await addMember(o.t, o.organizationId, "adminA", "admin");
    const outsider = await signIn(o.t, "outsider");
    const args = { ...o.args, planKey: "business", period: "monthly", phone: PHONE } as const;
    await expectCode(admin.as.action(api.billing.startCheckout, args), "FORBIDDEN");
    await expectCode(outsider.as.action(api.billing.startCheckout, args), "NOT_FOUND");
    await expectCode(o.t.action(api.billing.startCheckout, args), "UNAUTHENTICATED");
    expect(ph.fn).not.toHaveBeenCalled();
    // An admin granted billing:manage can pay.
    await o.t.run(async (ctx) => ctx.db.patch(admin.membershipId, { permissionOverrides: { grant: ["billing:manage"], revoke: [] } }));
    expect((await admin.as.action(api.billing.startCheckout, args)).status).toBe("pending");
  });

  test("a running higher plan cannot be downgraded by paying for a lower one", async () => {
    live();
    const ph = fakePayhero();
    const o = await setup();
    await o.t.run(async (ctx) =>
      ctx.db.insert("subscriptions", {
        organizationId: o.organizationId,
        planKey: "enterprise",
        period: "monthly",
        status: "active",
        currentPeriodStart: Date.now() - DAY,
        currentPeriodEnd: Date.now() + 20 * DAY,
        source: "payment",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await expectCode(checkout(o, { planKey: "business" }), "CONFLICT");
    expect(ph.fn).not.toHaveBeenCalled();
  });
});

describe("retry and abuse limits", () => {
  test("one pending payment per organization", async () => {
    live();
    fakePayhero();
    const o = await setup();
    await checkout(o);
    await expectCode(checkout(o), "CONFLICT");
  });

  test("cooldown between attempts, then the retry works", async () => {
    live();
    const ph = fakePayhero();
    const o = await setup();
    await checkout(o);
    const [p] = await payments(o.t);
    await o.owner.as.mutation(api.billing.cancelPayment, { ...o.args, paymentId: p!._id });
    await expectCode(checkout(o), "RATE_LIMITED");
    await age(o.t, 31_000);
    expect((await checkout(o)).status).toBe("pending");
    expect(ph.state.posts).toHaveLength(2);
  });

  test("at most 3 attempts per phone number per hour, across organizations", async () => {
    live();
    const ph = fakePayhero();
    const a = await setup("alpha");
    const b = await createOrgWithOwner(a.t, "beta", "beta");
    const settle = async () => {
      await a.t.run(async (ctx) => {
        for (const p of await ctx.db.query("billingPayments").collect()) {
          if (p.status === "pending") await ctx.db.patch(p._id, { status: "failed" });
        }
      });
      await age(a.t, 31_000);
    };
    await checkout(a);
    await settle();
    await b.owner.as.action(api.billing.startCheckout, { organizationId: b.organizationId, planKey: "business", period: "monthly", phone: PHONE });
    await settle();
    await checkout(a);
    await settle();
    await expectCode(checkout(a), "RATE_LIMITED");
    expect(ph.state.posts).toHaveLength(3);
    // A different number is unaffected.
    expect((await checkout(a, { phone: "0722000111" })).status).toBe("pending");
  });

  test("a number with several unfinished payments in a row is blocked on our side long before PayHero would", async () => {
    live();
    const ph = fakePayhero();
    const o = await setup();
    const phoneHash = await hmacHex(PEPPER, E164);
    await o.t.run(async (ctx) => {
      for (let i = 0; i < 5; i++) {
        await ctx.db.insert("billingPayments", {
          organizationId: o.organizationId,
          planKey: "business",
          period: "monthly",
          amountKes: 1000,
          provider: "payhero",
          phoneLast4: "5678",
          phoneHash,
          externalReference: `old${i}`,
          callbackTokenHash: `h${i}`,
          status: i % 2 ? "timed_out" : "failed",
          createdBy: o.owner.userId,
          createdAt: Date.now() - (2 + i) * 60 * MIN,
        });
      }
    });
    await expectCode(checkout(o), "RATE_LIMITED");
    expect(ph.fn).not.toHaveBeenCalled();
    // A success in between resets the streak.
    await o.t.run(async (ctx) => {
      const rows = await ctx.db.query("billingPayments").collect();
      await ctx.db.patch(rows[0]!._id, { status: "success" });
    });
    expect((await checkout(o)).status).toBe("pending");
  });

  const failedRow = (orgId: Id<"organizations">, userId: Id<"users">, i: number, tag: string) => ({
    organizationId: orgId,
    planKey: "business" as const,
    period: "monthly" as const,
    amountKes: 1000,
    provider: "payhero" as const,
    phoneLast4: "0000",
    phoneHash: `${tag}p${i}`,
    externalReference: `${tag}g${i}`,
    callbackTokenHash: `${tag}gh${i}`,
    status: "failed" as const,
    createdBy: userId,
    createdAt: Date.now() - 2 * 60 * MIN,
  });

  test("an account-wide failure surge across many organizations pauses new checkouts", async () => {
    live();
    const ph = fakePayhero();
    const o = await setup();
    const others: Awaited<ReturnType<typeof createOrgWithOwner>>[] = [];
    for (let k = 0; k < 14; k++) others.push(await createOrgWithOwner(o.t, `org${k}`, `org-${k}`));
    await o.t.run(async (ctx) => {
      for (const [k, x] of others.entries()) {
        for (let i = 0; i < 3; i++) await ctx.db.insert("billingPayments", failedRow(x.organizationId, x.owner.userId, i, `o${k}`));
      }
    });
    await expectCode(checkout(o), "RATE_LIMITED");
    expect(ph.fn).not.toHaveBeenCalled();
  });

  test("one tenant's failures cannot pause payments for everyone (each organization counts for at most 3)", async () => {
    live();
    const ph = fakePayhero();
    const o = await setup();
    const bad = await createOrgWithOwner(o.t, "bad", "bad");
    await o.t.run(async (ctx) => {
      for (let i = 0; i < 100; i++) await ctx.db.insert("billingPayments", failedRow(bad.organizationId, bad.owner.userId, i, "b"));
    });
    expect((await checkout(o)).status).toBe("pending");
    expect(ph.state.posts).toHaveLength(1);
  });

  test("a paying customer can still renew during an account-wide pause", async () => {
    live();
    fakePayhero();
    const o = await setup();
    const others: Awaited<ReturnType<typeof createOrgWithOwner>>[] = [];
    for (let k = 0; k < 14; k++) others.push(await createOrgWithOwner(o.t, `org${k}`, `org-${k}`));
    await o.t.run(async (ctx) => {
      for (const [k, x] of others.entries()) {
        for (let i = 0; i < 3; i++) await ctx.db.insert("billingPayments", failedRow(x.organizationId, x.owner.userId, i, `o${k}`));
      }
      await ctx.db.insert("subscriptions", {
        organizationId: o.organizationId,
        planKey: "business",
        period: "monthly",
        status: "active",
        currentPeriodStart: Date.now() - DAY,
        currentPeriodEnd: Date.now() + 5 * DAY,
        source: "payment",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    expect((await checkout(o)).status).toBe("pending");
  });

  test("at most 6 attempts per organization per hour", async () => {
    live();
    fakePayhero();
    const o = await setup();
    await o.t.run(async (ctx) => {
      for (let i = 0; i < 6; i++) {
        await ctx.db.insert("billingPayments", {
          organizationId: o.organizationId,
          planKey: "business",
          period: "monthly",
          amountKes: 1000,
          provider: "payhero",
          phoneLast4: "0000",
          phoneHash: `q${i}`,
          externalReference: `r${i}`,
          callbackTokenHash: `rh${i}`,
          status: "success",
          createdBy: o.owner.userId,
          createdAt: Date.now() - 10 * MIN - i,
        });
      }
    });
    await expectCode(checkout(o), "RATE_LIMITED");
  });
});

describe("callback security: the body is only a hint", () => {
  async function pending() {
    live();
    const ph = fakePayhero();
    const o = await setup();
    await checkout(o);
    const [p] = await payments(o.t);
    return { ph, o, p: p!, token: tokenOf(ph) };
  }

  test("a forged SUCCESS callback does not credit while PayHero says the payment is still queued", async () => {
    const { ph, o, p, token } = await pending();
    const res = await post(o.t, token, callbackBody({ ExternalReference: p.externalReference }));
    expect(res.status).toBe(200);
    expect(ph.state.gets).toEqual(["REF1ABCDEF"]); // we asked PayHero ourselves
    expect(await subs(o.t)).toHaveLength(0);
    expect((await payments(o.t))[0]!.status).toBe("pending");
  });

  test("a forged FAILED callback does not fail a payment PayHero says succeeded, and vice versa", async () => {
    const { ph, o, p, token } = await pending();
    ph.report("REF1ABCDEF", { status: "SUCCESS", CheckoutRequestID: "ws_CO_1", provider_reference: "RGH1234ABC" });
    await post(o.t, token, callbackBody({ ExternalReference: p.externalReference, ResultCode: 1032, Status: "Failed" }));
    expect((await payments(o.t))[0]).toMatchObject({ status: "success", mpesaReceipt: "RGH1234ABC" });
  });

  test("credits once PayHero's status API says SUCCESS for our reference: plan and amount are ours, not the callback's", async () => {
    const { ph, o, p, token } = await pending();
    ph.report("REF1ABCDEF", { status: "SUCCESS", CheckoutRequestID: "ws_CO_1", provider_reference: "RGH1234ABC" });
    const before = Date.now();
    // The forged body claims a different amount; it is irrelevant.
    await post(o.t, token, callbackBody({ ExternalReference: p.externalReference, Amount: 1 }));
    const [sub] = await subs(o.t);
    expect(sub).toMatchObject({ organizationId: o.organizationId, planKey: "business", period: "monthly", status: "active", source: "payment" });
    expect(sub!.currentPeriodEnd).toBeGreaterThanOrEqual(before + 30 * DAY);
    expect(sub!.currentPeriodEnd).toBeLessThan(Date.now() + 30 * DAY + 5000);
    expect((await payments(o.t))[0]).toMatchObject({ status: "success", amountKes: 1000, mpesaReceipt: "RGH1234ABC" });
    expect(await o.owner.as.query(api.billing.entitlements, o.args)).toMatchObject({ tier: "business" });
    expect(await audits(o.t, "billing.payment_applied")).toHaveLength(1);
    const receipts = await outbox(o.t, "billing_payment_received");
    expect(receipts).toHaveLength(1);
    expect(JSON.stringify(receipts[0]!.payload)).toContain("RGH1234ABC");
  });

  test("a success whose reference or amount does not match our record is not credited and is audited", async () => {
    const { ph, o, p, token } = await pending();
    ph.report("REF1ABCDEF", { status: "SUCCESS", reference: "SOMEONEELSE", provider_reference: "RGH1234ABC" });
    await post(o.t, token, callbackBody({ ExternalReference: p.externalReference }));
    expect(await subs(o.t)).toHaveLength(0);
    expect((await payments(o.t))[0]).toMatchObject({ status: "failed", failureReason: "verification_mismatch" });
    expect(await audits(o.t, "billing.payment_mismatch")).toHaveLength(1);
  });

  test("a status response carrying a different amount is not credited", async () => {
    const { ph, o, p, token } = await pending();
    ph.report("REF1ABCDEF", { status: "SUCCESS", amount: 10, CheckoutRequestID: "ws_CO_1" });
    await post(o.t, token, callbackBody({ ExternalReference: p.externalReference }));
    expect(await subs(o.t)).toHaveLength(0);
  });

  test("a callback naming another external reference is ignored without asking PayHero", async () => {
    const { ph, o, token } = await pending();
    ph.report("REF1ABCDEF", { status: "SUCCESS", CheckoutRequestID: "ws_CO_1" });
    await post(o.t, token, callbackBody({ ExternalReference: "someone-elses" }));
    expect(ph.state.gets).toHaveLength(0);
    expect(await subs(o.t)).toHaveLength(0);
  });

  test("unknown tokens get the same generic 200 and change nothing; malformed ones 404", async () => {
    const { ph, o } = await pending();
    const other = "A".repeat(43);
    const res = await post(o.t, other, callbackBody());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(ph.state.gets).toHaveLength(0);
    expect((await post(o.t, "short", callbackBody())).status).toBe(404);
    expect((await post(o.t, "../../etc/passwd", callbackBody())).status).toBe(404);
    expect(await subs(o.t)).toHaveLength(0);
  });

  test("oversized and non-JSON bodies are rejected", async () => {
    const { ph, o, token } = await pending();
    expect((await post(o.t, token, "x".repeat(9000))).status).toBe(400);
    expect((await post(o.t, token, "not json")).status).toBe(400);
    expect(ph.state.gets).toHaveLength(0);
  });

  test("a callback for the same token cannot be used for another organization's payment", async () => {
    live();
    const ph = fakePayhero();
    const a = await setup("alpha");
    const b = await createOrgWithOwner(a.t, "beta", "beta");
    await checkout(a);
    await b.owner.as.action(api.billing.startCheckout, { organizationId: b.organizationId, planKey: "business", period: "monthly", phone: "0722000111" });
    ph.report("REF1ABCDEF", { status: "SUCCESS", CheckoutRequestID: "ws_CO_1" });
    // Org B's token only ever resolves B's payment (whose reference is still queued).
    await post(a.t, tokenOf(ph, 1), callbackBody());
    expect(await subs(a.t)).toHaveLength(0);
  });

  test("replays and duplicate callbacks apply once", async () => {
    const { ph, o, p, token } = await pending();
    ph.report("REF1ABCDEF", { status: "SUCCESS", CheckoutRequestID: "ws_CO_1", provider_reference: "RGH1234ABC" });
    await post(o.t, token, callbackBody({ ExternalReference: p.externalReference }));
    const [first] = await subs(o.t);
    await unthrottle(o.t);
    await post(o.t, token, callbackBody({ ExternalReference: p.externalReference }));
    await post(o.t, token, callbackBody({ ExternalReference: p.externalReference }));
    const all = await subs(o.t);
    expect(all).toHaveLength(1);
    expect(all[0]!.currentPeriodEnd).toBe(first!.currentPeriodEnd);
    expect(await audits(o.t, "billing.payment_applied")).toHaveLength(1);
    expect(await outbox(o.t, "billing_payment_received")).toHaveLength(1);
  });

  test("applying the same verification twice is idempotent", async () => {
    const { o, p } = await pending();
    const result = { state: "success" as const, reference: p.payheroReference, checkoutRequestId: p.checkoutRequestId };
    expect(await o.t.mutation(internal.billingPayhero.recordVerification, { paymentId: p._id, result })).toBe("applied");
    expect(await o.t.mutation(internal.billingPayhero.recordVerification, { paymentId: p._id, result })).toBe("duplicate");
    expect(await subs(o.t)).toHaveLength(1);
  });

  test("callback flood guard: repeated callbacks do not hammer PayHero", async () => {
    const { ph, o, token } = await pending();
    for (let i = 0; i < 5; i++) await post(o.t, token, callbackBody());
    expect(ph.state.gets).toHaveLength(1);
  });

  test("a failed payment: PayHero FAILED marks it failed and a later success callback does not resurrect it", async () => {
    const { ph, o, p, token } = await pending();
    ph.report("REF1ABCDEF", { status: "FAILED" });
    await post(o.t, token, callbackBody({ ExternalReference: p.externalReference, ResultCode: 1 }));
    expect((await payments(o.t))[0]).toMatchObject({ status: "failed", failureReason: "not_completed" });
    await unthrottle(o.t);
    ph.report("REF1ABCDEF", { status: "SUCCESS", CheckoutRequestID: "ws_CO_1" });
    await post(o.t, token, callbackBody({ ExternalReference: p.externalReference }));
    expect(await subs(o.t)).toHaveLength(0);
  });
});

describe("reconciliation", () => {
  test("a lost callback is resolved by the cron once the payment is older than 30 seconds", async () => {
    live();
    const ph = fakePayhero();
    const o = await setup();
    await checkout(o);
    ph.report("REF1ABCDEF", { status: "SUCCESS", CheckoutRequestID: "ws_CO_1", provider_reference: "RGH1234ABC" });
    // Too young: left alone.
    await o.t.action(internal.billingPayhero.reconcile, {});
    expect(await subs(o.t)).toHaveLength(0);
    expect(ph.state.gets).toHaveLength(0);
    await age(o.t, 40_000);
    expect(await o.t.action(internal.billingPayhero.reconcile, {})).toMatchObject({ checked: 1, timedOut: 0 });
    expect((await subs(o.t))[0]).toMatchObject({ status: "active", planKey: "business" });
    expect((await payments(o.t))[0]!.status).toBe("success");
  });

  test("still queued after 10 minutes: timed out; a late success within 24 hours is still honoured", async () => {
    live();
    const ph = fakePayhero();
    const o = await setup();
    await checkout(o);
    await age(o.t, 11 * MIN);
    expect(await o.t.action(internal.billingPayhero.reconcile, {})).toMatchObject({ timedOut: 1 });
    expect((await payments(o.t))[0]).toMatchObject({ status: "timed_out", failureReason: "timed_out" });
    expect(await subs(o.t)).toHaveLength(0);

    // The customer did pay after all.
    ph.report("REF1ABCDEF", { status: "SUCCESS", CheckoutRequestID: "ws_CO_1", provider_reference: "RGH1234ABC" });
    await o.t.run(async (ctx) => {
      for (const p of await ctx.db.query("billingPayments").collect()) await ctx.db.patch(p._id, { lastCheckedAt: Date.now() - 11 * MIN });
    });
    await o.t.action(internal.billingPayhero.reconcile, {});
    expect((await payments(o.t))[0]).toMatchObject({ status: "success", mpesaReceipt: "RGH1234ABC" });
    expect(await subs(o.t)).toHaveLength(1);
  });

  test("reconciliation marks PayHero-reported failures as failed", async () => {
    live();
    const ph = fakePayhero();
    const o = await setup();
    await checkout(o);
    ph.report("REF1ABCDEF", { status: "FAILED" });
    await age(o.t, 40_000);
    await o.t.action(internal.billingPayhero.reconcile, {});
    expect((await payments(o.t))[0]!.status).toBe("failed");
  });

  test("a payment stuck before PayHero ever answered (no reference) times out without any API call", async () => {
    live();
    const ph = fakePayhero();
    const o = await setup();
    await o.t.run(async (ctx) =>
      ctx.db.insert("billingPayments", {
        organizationId: o.organizationId,
        planKey: "business",
        period: "monthly",
        amountKes: 1000,
        provider: "payhero",
        phoneLast4: "5678",
        phoneHash: "h",
        externalReference: "WGlost",
        callbackTokenHash: "th",
        status: "pending",
        createdBy: o.owner.userId,
        createdAt: Date.now() - 12 * MIN,
      }),
    );
    await o.t.action(internal.billingPayhero.reconcile, {});
    expect((await payments(o.t))[0]!.status).toBe("timed_out");
    expect(ph.fn).not.toHaveBeenCalled();
  });

  test("cancelling stops the wait; a payment that completes anyway is still credited by reconciliation", async () => {
    live();
    const ph = fakePayhero();
    const o = await setup();
    const { paymentId } = await checkout(o);
    await o.owner.as.mutation(api.billing.cancelPayment, { ...o.args, paymentId });
    expect((await o.owner.as.query(api.billing.paymentStatus, { ...o.args, paymentId })).status).toBe("cancelled");
    ph.report("REF1ABCDEF", { status: "SUCCESS", CheckoutRequestID: "ws_CO_1" });
    await o.t.action(internal.billingPayhero.reconcile, {});
    expect((await payments(o.t))[0]!.status).toBe("success");
  });
});

describe("queries and tenant isolation", () => {
  test("paymentStatus is live, same-organization only and billing:manage only", async () => {
    live();
    fakePayhero();
    const a = await setup("alpha");
    const b = await createOrgWithOwner(a.t, "beta", "beta");
    const { paymentId } = await checkout(a);
    expect(await a.owner.as.query(api.billing.paymentStatus, { ...a.args, paymentId })).toMatchObject({ status: "pending", amountKes: 1000, phoneLast4: "5678" });
    // Org B naming org A's payment id through its own organization: not found.
    await expectCode(b.owner.as.query(api.billing.paymentStatus, { organizationId: b.organizationId, paymentId }), "NOT_FOUND");
    // And through org A: not a member.
    await expectCode(b.owner.as.query(api.billing.paymentStatus, { ...a.args, paymentId }), "NOT_FOUND");
    await expectCode(b.owner.as.mutation(api.billing.cancelPayment, { organizationId: b.organizationId, paymentId }), "NOT_FOUND");
    const admin = await addMember(a.t, a.organizationId, "adminA", "admin");
    await expectCode(admin.as.query(api.billing.paymentStatus, { ...a.args, paymentId }), "FORBIDDEN");
  });

  test("overview lists payments with receipts and never the phone number", async () => {
    live();
    const ph = fakePayhero();
    const o = await setup();
    await checkout(o);
    ph.report("REF1ABCDEF", { status: "SUCCESS", CheckoutRequestID: "ws_CO_1", provider_reference: "RGH1234ABC" });
    await post(o.t, tokenOf(ph), callbackBody());
    const ov = await o.owner.as.query(api.billing.overview, o.args);
    expect(ov.recentPayments).toHaveLength(1);
    expect(ov.recentPayments[0]).toMatchObject({ status: "success", mpesaReceipt: "RGH1234ABC", amountKes: 1000 });
    expect(JSON.stringify(ov)).not.toContain("712345678");
    expect(ov.subscription).toMatchObject({ planKey: "business", status: "active", source: "payment" });
    expect(ov.payments.mode).toBe("live");
  });
});

describe("dry-run provider (the default)", () => {
  test("records the payment without any network call; only the dev simulator can settle it", async () => {
    process.env.BILLING_ENFORCEMENT = "on";
    process.env.ALLOW_DRY_RUN_BILLING = "true";
    const ph = fakePayhero();
    const o = await setup();
    const { paymentId, status } = await checkout(o);
    expect(status).toBe("pending");
    expect(ph.fn).not.toHaveBeenCalled();
    const [p] = await payments(o.t);
    expect(p).toMatchObject({ provider: "dry-run", status: "pending" });

    // Nothing the outside world sends can settle it.
    await age(o.t, 40_000);
    await o.t.action(internal.billingPayhero.reconcile, {});
    expect((await payments(o.t))[0]!.status).toBe("pending");
    expect(await subs(o.t)).toHaveLength(0);

    await o.t.mutation(internal.billingPayhero.simulate, { paymentId, outcome: "success" });
    expect((await payments(o.t))[0]).toMatchObject({ status: "success" });
    expect((await subs(o.t))[0]).toMatchObject({ planKey: "business", status: "active" });
    await expectCode(o.t.mutation(internal.billingPayhero.simulate, { paymentId, outcome: "success" }), "CONFLICT");
  });

  test("simulated failure", async () => {
    fakePayhero();
    const o = await setup();
    const { paymentId } = await checkout(o);
    await o.t.mutation(internal.billingPayhero.simulate, { paymentId, outcome: "failure" });
    expect((await payments(o.t))[0]!.status).toBe("failed");
    expect(await subs(o.t)).toHaveLength(0);
  });

  test("the public simulator is off unless ALLOW_BILLING_SIMULATION=true, and never works in live mode or on live payments", async () => {
    fakePayhero();
    const o = await setup();
    const { paymentId } = await checkout(o);
    await expectCode(o.owner.as.mutation(api.billing.simulatePayment, { ...o.args, paymentId, outcome: "success" }), "FORBIDDEN");
    process.env.ALLOW_BILLING_SIMULATION = "true";
    const admin = await addMember(o.t, o.organizationId, "adminA", "admin");
    await expectCode(admin.as.mutation(api.billing.simulatePayment, { ...o.args, paymentId, outcome: "success" }), "FORBIDDEN");
    await o.owner.as.mutation(api.billing.simulatePayment, { ...o.args, paymentId, outcome: "success" });
    expect(await subs(o.t)).toHaveLength(1);

    // A real (live) payment cannot be simulated, and live mode switches simulation off altogether.
    live();
    const ph = fakePayhero();
    await age(o.t, 40_000);
    const live1 = await checkout(o);
    expect(ph.state.posts).toHaveLength(1);
    await expectCode(o.owner.as.mutation(api.billing.simulatePayment, { ...o.args, paymentId: live1.paymentId, outcome: "success" }), "FORBIDDEN");
    await expectCode(o.t.mutation(internal.billingPayhero.simulate, { paymentId: live1.paymentId, outcome: "success" }), "FORBIDDEN");
  });
});

describe("subscription extension through payments", () => {
  async function pay(o: Ctx, ph: ReturnType<typeof fakePayhero>, n: number, over: Parameters<typeof checkout>[1] = {}) {
    await age(o.t, 31_000);
    await checkout(o, { phone: `0722000${100 + n}`, ...over });
    const ref = `REF${n}ABCDEF`;
    ph.report(ref, { status: "SUCCESS", CheckoutRequestID: `ws_CO_${n}`, provider_reference: `RGH000000${n}` });
    await post(o.t, tokenOf(ph, n - 1), callbackBody());
  }

  test("an early renewal stacks onto the current end; an annual payment adds 365 days; an expired one restarts from now", async () => {
    live();
    const ph = fakePayhero();
    const o = await setup();
    await pay(o, ph, 1);
    const end1 = (await subs(o.t))[0]!.currentPeriodEnd;
    await pay(o, ph, 2);
    expect((await subs(o.t))[0]!.currentPeriodEnd).toBe(end1 + 30 * DAY);
    await pay(o, ph, 3, { period: "annual" });
    expect((await subs(o.t))[0]).toMatchObject({ period: "annual", currentPeriodEnd: end1 + 30 * DAY + 365 * DAY });
    expect(await subs(o.t)).toHaveLength(1);

    // Expired long ago: the new period starts now.
    await o.t.run(async (ctx) => {
      const [s] = await ctx.db.query("subscriptions").collect();
      await ctx.db.patch(s!._id, { status: "ended", currentPeriodEnd: Date.now() - 60 * DAY });
    });
    await pay(o, ph, 4);
    const s = (await subs(o.t))[0]!;
    expect(s.status).toBe("active");
    expect(s.currentPeriodEnd).toBeGreaterThan(Date.now() + 29 * DAY);
    expect(s.currentPeriodEnd).toBeLessThan(Date.now() + 31 * DAY);
  });

  test("upgrading business to enterprise takes effect immediately", async () => {
    live();
    const ph = fakePayhero();
    const o = await setup();
    await pay(o, ph, 1);
    await pay(o, ph, 2, { planKey: "enterprise" });
    expect((await subs(o.t))[0]).toMatchObject({ planKey: "enterprise" });
    expect(await o.owner.as.query(api.billing.entitlements, o.args)).toMatchObject({ tier: "enterprise" });
  });
});

describe("free trial", () => {
  test("disabled when no trial length is configured", async () => {
    process.env.BILLING_ENFORCEMENT = "on";
    const o = await setup();
    expect((await o.owner.as.query(api.billing.overview, o.args)).trial).toEqual({ available: false, days: null });
    await expectCode(o.owner.as.mutation(api.billing.startTrial, o.args), "VALIDATION");
  });

  test("owner starts it without payment, once per organization; it unlocks Business and ends by itself", async () => {
    process.env.BILLING_ENFORCEMENT = "on";
    cfg.trialDays = 14;
    const o = await setup();
    const admin = await addMember(o.t, o.organizationId, "adminA", "admin");
    await expectCode(admin.as.mutation(api.billing.startTrial, o.args), "FORBIDDEN");
    expect((await o.owner.as.query(api.billing.overview, o.args)).trial).toEqual({ available: true, days: 14 });

    await o.owner.as.mutation(api.billing.startTrial, o.args);
    const [row] = await subs(o.t);
    expect(row).toMatchObject({ planKey: "business", status: "trialing", source: "trial" });
    expect(row!.trialEndsAt).toBe(row!.currentPeriodEnd);
    expect(row!.currentPeriodEnd - row!.currentPeriodStart).toBe(14 * DAY);
    expect(await o.owner.as.query(api.billing.entitlements, o.args)).toMatchObject({ tier: "business" });
    expect(await audits(o.t, "billing.trial_started")).toHaveLength(1);

    await expectCode(o.owner.as.mutation(api.billing.startTrial, o.args), "CONFLICT");
    expect((await o.owner.as.query(api.billing.overview, o.args)).trial.available).toBe(false);

    // Time passes: free immediately (derived from time), and the cron tidies the status.
    await o.t.run(async (ctx) => ctx.db.patch(row!._id, { currentPeriodEnd: Date.now() - 1000, trialEndsAt: Date.now() - 1000 }));
    expect(await o.owner.as.query(api.billing.entitlements, o.args)).toMatchObject({ tier: "free" });
    await o.t.mutation(internal.billingLifecycle.sweep, {});
    expect((await subs(o.t))[0]!.status).toBe("ended");
    // Used trials cannot be restarted.
    await expectCode(o.owner.as.mutation(api.billing.startTrial, o.args), "CONFLICT");
  });

  test("one organization's trial does not give another one a trial or a plan", async () => {
    process.env.BILLING_ENFORCEMENT = "on";
    cfg.trialDays = 14;
    const a = await setup("alpha");
    const b = await createOrgWithOwner(a.t, "beta", "beta");
    await a.owner.as.mutation(api.billing.startTrial, a.args);
    expect(await b.owner.as.query(api.billing.entitlements, { organizationId: b.organizationId })).toMatchObject({ tier: "free" });
    await b.owner.as.mutation(api.billing.startTrial, { organizationId: b.organizationId });
    expect(await subs(a.t)).toHaveLength(2);
  });
});

describe("lifecycle: reminders, expiry, grace, downgrade", () => {
  const active = async (o: Ctx, endsIn: number, extra: Record<string, unknown> = {}) =>
    o.t.run(async (ctx) =>
      ctx.db.insert("subscriptions", {
        organizationId: o.organizationId,
        planKey: "business",
        period: "monthly",
        status: "active",
        currentPeriodStart: Date.now() - 30 * DAY + endsIn,
        currentPeriodEnd: Date.now() + endsIn,
        source: "payment",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...extra,
      }),
    );

  test("reminders at 7, 3 and 1 days before the end, each once, with the no-auto-renew note and a billing link", async () => {
    process.env.BILLING_ENFORCEMENT = "on";
    process.env.APP_BASE_URL = "https://app.example.com";
    const o = await setup();
    const id = await active(o, 6.5 * DAY);
    await o.t.mutation(internal.billingLifecycle.sweep, {});
    await o.t.mutation(internal.billingLifecycle.sweep, {}); // idempotent
    expect(await outbox(o.t, "billing_renewal_reminder")).toHaveLength(1);

    await o.t.run(async (ctx) => ctx.db.patch(id, { currentPeriodEnd: Date.now() + 2.5 * DAY }));
    await o.t.mutation(internal.billingLifecycle.sweep, {});
    expect(await outbox(o.t, "billing_renewal_reminder")).toHaveLength(2);

    await o.t.run(async (ctx) => ctx.db.patch(id, { currentPeriodEnd: Date.now() + 0.5 * DAY }));
    await o.t.mutation(internal.billingLifecycle.sweep, {});
    const reminders = await outbox(o.t, "billing_renewal_reminder");
    expect(reminders).toHaveLength(3);
    expect(JSON.stringify(reminders[0]!.payload)).toContain("https://app.example.com/app/billing");

    const { renderTemplate } = await import("../../lib/notifications/templates");
    const text = renderTemplate("billing_renewal_reminder", { orgName: "Acme", planName: "Business", endDate: "1 Nov 2026", daysLeft: "3", link: "/app/billing" });
    expect(text.body).toMatch(/does not renew automatically/);
    expect(text.body).toContain("/app/billing");
    delete process.env.APP_BASE_URL;
  });

  test("no reminders for periods further than 7 days out, for trials, or for manual grants", async () => {
    process.env.BILLING_ENFORCEMENT = "on";
    const o = await setup();
    await active(o, 20 * DAY);
    await o.t.mutation(internal.billingLifecycle.sweep, {});
    expect(await outbox(o.t, "billing_renewal_reminder")).toHaveLength(0);
    await o.t.run(async (ctx) => {
      const [s] = await ctx.db.query("subscriptions").collect();
      await ctx.db.patch(s!._id, { currentPeriodEnd: Date.now() + 2 * DAY, source: "manual" });
    });
    await o.t.mutation(internal.billingLifecycle.sweep, {});
    expect(await outbox(o.t, "billing_renewal_reminder")).toHaveLength(0);
  });

  test("expiry: past_due with a notice and 7 days of grace, then Starter; nothing is ever deleted", async () => {
    process.env.BILLING_ENFORCEMENT = "on";
    const o = await setup();
    await active(o, -1000);
    await o.owner.as.mutation(api.sites.create, { ...o.args, name: "Second", timeZone: "Africa/Nairobi" }).catch(() => undefined);
    await o.t.mutation(internal.billingLifecycle.sweep, {});
    expect((await subs(o.t))[0]!.status).toBe("past_due");
    expect(await outbox(o.t, "billing_plan_expired")).toHaveLength(1);
    await o.t.mutation(internal.billingLifecycle.sweep, {});
    expect(await outbox(o.t, "billing_plan_expired")).toHaveLength(1);
    // Still Business during the grace period.
    expect(await o.owner.as.query(api.billing.entitlements, o.args)).toMatchObject({ tier: "business" });
    expect((await o.owner.as.query(api.billing.overview, o.args)).subscription.status).toBe("past_due");

    await o.t.run(async (ctx) => {
      const [s] = await ctx.db.query("subscriptions").collect();
      await ctx.db.patch(s!._id, { currentPeriodEnd: Date.now() - 8 * DAY });
    });
    expect(await o.owner.as.query(api.billing.entitlements, o.args)).toMatchObject({ tier: "free" });
    await o.t.mutation(internal.billingLifecycle.sweep, {});
    expect((await subs(o.t))[0]!.status).toBe("ended");
    // Data is untouched; only creating more is blocked.
    const sites = await o.owner.as.query(api.sites.list, o.args);
    expect(sites.length).toBeGreaterThanOrEqual(1);
    await expectCode(o.owner.as.mutation(api.sites.create, { ...o.args, name: "Third", timeZone: "Africa/Nairobi" }), "PLAN_LIMIT");
  });

  test("paying during the grace period restores the plan from now", async () => {
    live();
    const ph = fakePayhero();
    const o = await setup();
    await active(o, -2 * DAY, { status: "past_due" });
    await checkout(o);
    ph.report("REF1ABCDEF", { status: "SUCCESS", CheckoutRequestID: "ws_CO_1", provider_reference: "RGH1234ABC" });
    await post(o.t, tokenOf(ph), callbackBody());
    const [s] = await subs(o.t);
    expect(s!.status).toBe("active");
    expect(s!.currentPeriodEnd).toBeGreaterThan(Date.now() + 29 * DAY);
  });

  test("the receipt notification reaches billing managers only", async () => {
    live();
    const ph = fakePayhero();
    const o = await setup();
    await addMember(o.t, o.organizationId, "rita", "receptionist");
    await checkout(o);
    ph.report("REF1ABCDEF", { status: "SUCCESS", CheckoutRequestID: "ws_CO_1", provider_reference: "RGH1234ABC" });
    await post(o.t, tokenOf(ph), callbackBody());
    const rows = await outbox(o.t, "billing_payment_received");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.organizationId).toBe(o.organizationId);
  });
});

describe("platform grantPlan", () => {
  async function withAdmin() {
    process.env.BILLING_ENFORCEMENT = "on";
    const a = await setup("alpha");
    const b = await createOrgWithOwner(a.t, "beta", "beta");
    const root = await signIn(a.t, "root");
    await a.t.mutation(internal.platform.grantSuperAdmin, { email: "root@example.com" });
    return { a, b, root };
  }
  const until = () => Date.now() + 90 * DAY;

  test("platform administrators only", async () => {
    const { a, root } = await withAdmin();
    const args = { organizationId: a.organizationId, planKey: "enterprise", until: until(), reason: "Invoiced customer" } as const;
    await expectCode(a.owner.as.mutation(api.platform.grantPlan, args), "FORBIDDEN");
    await expectCode(a.t.mutation(api.platform.grantPlan, args), "UNAUTHENTICATED");
    await root.as.mutation(api.platform.grantPlan, args);
    expect(await subs(a.t)).toHaveLength(1);
  });

  test("grants the plan, is audit-logged with the reason, and affects only that organization", async () => {
    const { a, b, root } = await withAdmin();
    const end = until();
    await root.as.mutation(api.platform.grantPlan, { organizationId: a.organizationId, planKey: "enterprise", until: end, reason: "Sales-assisted deal #42" });
    expect(await a.owner.as.query(api.billing.entitlements, a.args)).toMatchObject({ tier: "enterprise" });
    expect(await b.owner.as.query(api.billing.entitlements, { organizationId: b.organizationId })).toMatchObject({ tier: "free" });
    const [row] = await subs(a.t);
    expect(row).toMatchObject({ planKey: "enterprise", status: "active", source: "manual", currentPeriodEnd: end });
    const [log] = await audits(a.t, "platform.plan_granted");
    expect(log).toMatchObject({ organizationId: a.organizationId, actorUserId: root.userId });
    expect(log!.metadata).toMatchObject({ planKey: "enterprise", until: end, reason: "Sales-assisted deal #42" });
    expect(await audits(a.t, "platform.plan_granted")).toHaveLength(1); // only org A's entry exists (shared table)
    const ov = await a.owner.as.query(api.billing.overview, a.args);
    expect(ov.subscription).toMatchObject({ planKey: "enterprise", source: "manual" });
    const usage = await root.as.query(api.billing.platformUsage, { paginationOpts: { numItems: 10, cursor: null } });
    expect(usage.page.find((r) => r._id === a.organizationId)).toMatchObject({ subscriptionSource: "manual", subscriptionEnd: end, tier: "enterprise" });
  });

  test("replaces an existing paid subscription and validates input", async () => {
    const { a, root } = await withAdmin();
    await root.as.mutation(api.platform.grantPlan, { organizationId: a.organizationId, planKey: "business", until: until(), reason: "first grant" });
    await root.as.mutation(api.platform.grantPlan, { organizationId: a.organizationId, planKey: "enterprise", until: until(), reason: "upgrade grant" });
    expect(await subs(a.t)).toHaveLength(1);
    const base = { organizationId: a.organizationId, planKey: "business", reason: "valid reason" } as const;
    await expectCode(root.as.mutation(api.platform.grantPlan, { ...base, until: Date.now() - 1000 }), "VALIDATION");
    await expectCode(root.as.mutation(api.platform.grantPlan, { ...base, until: Date.now() + 10 * 366 * DAY }), "VALIDATION");
    await expectCode(root.as.mutation(api.platform.grantPlan, { ...base, until: until(), reason: "no" }), "VALIDATION");
  });

  test("a manual grant lapses into the usual grace and then Starter, with no reminders", async () => {
    const { a, root } = await withAdmin();
    await root.as.mutation(api.platform.grantPlan, { organizationId: a.organizationId, planKey: "business", until: until(), reason: "short grant" });
    await a.t.run(async (ctx) => {
      const [s] = await ctx.db.query("subscriptions").collect();
      await ctx.db.patch(s!._id, { currentPeriodEnd: Date.now() - 8 * DAY });
    });
    expect(await a.owner.as.query(api.billing.entitlements, a.args)).toMatchObject({ tier: "free" });
    await a.t.mutation(internal.billingLifecycle.sweep, {});
    expect(await outbox(a.t, "billing_plan_expired")).toHaveLength(0);
  });
});

describe("Clerk Billing is gone", () => {
  test("the old webhook route no longer exists", async () => {
    const t = newTest();
    const res = await t.fetch("/webhooks/clerk-billing", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });
});

describe("H2 adversarial review", () => {
  test("production guard: with enforcement on, dry-run checkout is refused unless ALLOW_DRY_RUN_BILLING=true", async () => {
    process.env.BILLING_ENFORCEMENT = "on";
    const ph = fakePayhero();
    const o = await setup();
    await expectCode(checkout(o), "VALIDATION"); // PAYHERO_MODE unset in a "production" config
    expect(await payments(o.t)).toHaveLength(0);
    expect(ph.fn).not.toHaveBeenCalled();
    process.env.ALLOW_DRY_RUN_BILLING = "true";
    expect((await checkout(o)).status).toBe("pending");
  });

  test("dry-run still works while enforcement is off (development)", async () => {
    fakePayhero();
    const o = await setup();
    expect((await checkout(o)).status).toBe("pending");
  });

  test("the platform page is warned about an unsafe billing configuration", async () => {
    process.env.BILLING_ENFORCEMENT = "on";
    process.env.ALLOW_DRY_RUN_BILLING = "true";
    process.env.ALLOW_BILLING_SIMULATION = "true";
    const o = await setup();
    const admin = await signIn(o.t, "root");
    await o.t.run(async (ctx) => ctx.db.patch(admin.userId, { platformRole: "super_admin" }));
    const res = await admin.as.query(api.billing.platformBillingHealth, {});
    expect(res.mode).toBe("dry-run");
    expect(res.warnings.length).toBeGreaterThanOrEqual(2);
    live();
    const ok = await admin.as.query(api.billing.platformBillingHealth, {});
    expect(ok.warnings.some((w: string) => /dry-run/i.test(w))).toBe(false);
  });

  test("live mode refuses to run without a strong BILLING_HASH_PEPPER (phone hashes must not be guessable)", async () => {
    live();
    delete process.env.BILLING_HASH_PEPPER;
    const ph = fakePayhero();
    const o = await setup();
    await expectCode(checkout(o), "VALIDATION");
    process.env.BILLING_HASH_PEPPER = "short";
    await expectCode(checkout(o), "VALIDATION");
    expect(ph.fn).not.toHaveBeenCalled();
  });

  test("one PayHero reference can only ever belong to one payment (reference reuse)", async () => {
    live();
    const ph = fakePayhero();
    ph.state.fixedRef = "REUSEDREF1";
    const a = await setup("alpha");
    const b = await createOrgWithOwner(a.t, "beta", "beta");
    await checkout(a);
    await b.owner.as.action(api.billing.startCheckout, { organizationId: b.organizationId, planKey: "business", period: "monthly", phone: "0722000111" });
    const rows = await payments(a.t);
    expect(rows.filter((r) => r.payheroReference === "REUSEDREF1")).toHaveLength(1);
    expect(rows.find((r) => r.organizationId === b.organizationId)).toMatchObject({ status: "failed", failureReason: "reference_reused" });
  });

  test("one M-Pesa receipt can credit only one payment, even across organizations", async () => {
    live();
    const ph = fakePayhero();
    const a = await setup("alpha");
    const b = await createOrgWithOwner(a.t, "beta", "beta");
    await checkout(a);
    await b.owner.as.action(api.billing.startCheckout, { organizationId: b.organizationId, planKey: "business", period: "monthly", phone: "0722000111" });
    ph.report("REF1ABCDEF", { status: "SUCCESS", CheckoutRequestID: "ws_CO_1", provider_reference: "RGH1234ABC" });
    ph.report("REF2ABCDEF", { status: "SUCCESS", CheckoutRequestID: "ws_CO_2", provider_reference: "RGH1234ABC" });
    await post(a.t, tokenOf(ph, 0), callbackBody());
    await post(a.t, tokenOf(ph, 1), callbackBody());
    const subsNow = await subs(a.t);
    expect(subsNow).toHaveLength(1);
    expect(subsNow[0]!.organizationId).toBe(a.organizationId);
    const second = (await payments(a.t)).find((p) => p.organizationId === b.organizationId)!;
    expect(second).toMatchObject({ status: "failed", failureReason: "verification_mismatch" });
    expect(await audits(a.t, "billing.payment_mismatch")).toHaveLength(1);
  });

  test("a receipt hint taken from the callback body is dropped if another payment already owns that receipt", async () => {
    live();
    const ph = fakePayhero();
    const a = await setup("alpha");
    const b = await createOrgWithOwner(a.t, "beta", "beta");
    await checkout(a);
    await b.owner.as.action(api.billing.startCheckout, { organizationId: b.organizationId, planKey: "business", period: "monthly", phone: "0722000111" });
    ph.report("REF1ABCDEF", { status: "SUCCESS", CheckoutRequestID: "ws_CO_1", provider_reference: "RGH1234ABC" });
    await post(a.t, tokenOf(ph, 0), callbackBody());
    ph.report("REF2ABCDEF", { status: "SUCCESS", CheckoutRequestID: "ws_CO_2" }); // no receipt from PayHero
    await post(a.t, tokenOf(ph, 1), callbackBody({ MpesaReceiptNumber: "RGH1234ABC" })); // attacker-supplied
    const second = (await payments(a.t)).find((p) => p.organizationId === b.organizationId)!;
    expect(second.status).toBe("success");
    expect(second.mpesaReceipt).toBeUndefined();
  });

  test("when PayHero answers with the M-Pesa code as `reference`, the matching CheckoutRequestID still binds it to our payment", async () => {
    live();
    const ph = fakePayhero();
    const o = await setup();
    await checkout(o);
    ph.report("REF1ABCDEF", { status: "SUCCESS", reference: "RGH1234ABC", CheckoutRequestID: "ws_CO_1" });
    await post(o.t, tokenOf(ph), callbackBody());
    expect((await payments(o.t))[0]).toMatchObject({ status: "success", mpesaReceipt: "RGH1234ABC" });
    expect(await subs(o.t)).toHaveLength(1);
  });

  test("an M-Pesa-code `reference` without a matching CheckoutRequestID is never credited", async () => {
    live();
    const ph = fakePayhero();
    const o = await setup();
    await checkout(o);
    ph.report("REF1ABCDEF", { status: "SUCCESS", reference: "RGH1234ABC", CheckoutRequestID: "ws_CO_999" });
    await post(o.t, tokenOf(ph), callbackBody());
    expect(await subs(o.t)).toHaveLength(0);
    ph.report("REF1ABCDEF", { status: "SUCCESS", reference: "RGH1234ABC" });
    await unthrottle(o.t);
    await o.t.run(async (ctx) => {
      const [p] = await ctx.db.query("billingPayments").collect();
      await ctx.db.patch(p!._id, { status: "pending", failureReason: undefined });
    });
    await post(o.t, tokenOf(ph), callbackBody());
    expect(await subs(o.t)).toHaveLength(0);
  });

  test("a FAILED answer about some other reference does not fail our payment", async () => {
    live();
    const ph = fakePayhero();
    const o = await setup();
    await checkout(o);
    ph.report("REF1ABCDEF", { status: "FAILED", reference: "SOMEONEELSE" });
    await post(o.t, tokenOf(ph), callbackBody());
    expect((await payments(o.t))[0]!.status).toBe("pending");
  });

  test("a payment cancelled in the instant before PayHero answered still records its reference, so a late success is honoured", async () => {
    live();
    const ph = fakePayhero();
    const o = await setup();
    await checkout(o);
    const [p] = await payments(o.t);
    await o.t.run(async (ctx) => ctx.db.patch(p!._id, { status: "cancelled", payheroReference: undefined, checkoutRequestId: undefined }));
    await o.t.mutation(internal.billingPayhero.markInitiated, { paymentId: p!._id, reference: "REF1ABCDEF", checkoutRequestId: "ws_CO_1" });
    expect((await payments(o.t))[0]!.payheroReference).toBe("REF1ABCDEF");
    ph.report("REF1ABCDEF", { status: "SUCCESS", CheckoutRequestID: "ws_CO_1", provider_reference: "RGH1234ABC" });
    await post(o.t, tokenOf(ph), callbackBody());
    expect((await payments(o.t))[0]!.status).toBe("success");
  });

  test("concurrent duplicate callbacks and a reconcile run credit exactly once", async () => {
    live();
    const ph = fakePayhero();
    const o = await setup();
    await checkout(o);
    ph.report("REF1ABCDEF", { status: "SUCCESS", CheckoutRequestID: "ws_CO_1", provider_reference: "RGH1234ABC" });
    await age(o.t, 40_000);
    const token = tokenOf(ph);
    const paymentId = (await payments(o.t))[0]!._id;
    await Promise.all([
      ...Array.from({ length: 6 }, () => post(o.t, token, callbackBody())),
      o.t.action(internal.billingPayhero.reconcile, {}),
      o.t.action(internal.billingPayhero.verify, { paymentId }),
    ]);
    const [sub] = await subs(o.t);
    expect(await subs(o.t)).toHaveLength(1);
    expect(sub!.currentPeriodEnd - sub!.currentPeriodStart).toBe(30 * DAY);
    expect(await audits(o.t, "billing.payment_applied")).toHaveLength(1);
    expect(await outbox(o.t, "billing_payment_received")).toHaveLength(1);
  });

  test("an oversized body is rejected before any provider call, and a replay after success asks PayHero nothing", async () => {
    live();
    const ph = fakePayhero();
    const o = await setup();
    await checkout(o);
    const token = tokenOf(ph);
    expect((await post(o.t, token, JSON.stringify({ pad: "x".repeat(9000) }))).status).toBe(400);
    expect((await post(o.t, token, "not json")).status).toBe(400);
    expect(ph.state.gets).toHaveLength(0);
    ph.report("REF1ABCDEF", { status: "SUCCESS", CheckoutRequestID: "ws_CO_1", provider_reference: "RGH1234ABC" });
    await post(o.t, token, callbackBody());
    const asked = ph.state.gets.length;
    for (let i = 0; i < 3; i++) await post(o.t, token, callbackBody());
    expect(ph.state.gets).toHaveLength(asked);
  });

  test("another organization's payment id reads as not found for status, cancel and simulate", async () => {
    live();
    fakePayhero();
    const a = await setup("alpha");
    const b = await createOrgWithOwner(a.t, "beta", "beta");
    const { paymentId } = await checkout(a);
    await expectCode(b.owner.as.query(api.billing.paymentStatus, { organizationId: b.organizationId, paymentId }), "NOT_FOUND");
    await expectCode(b.owner.as.mutation(api.billing.cancelPayment, { organizationId: b.organizationId, paymentId }), "NOT_FOUND");
    process.env.ALLOW_BILLING_SIMULATION = "true";
    await expectCode(
      b.owner.as.mutation(api.billing.simulatePayment, { organizationId: b.organizationId, paymentId, outcome: "success" }),
      "NOT_FOUND",
    );
  });

  test("grantPlan rejects bad dates, empty or oversized reasons, and non-admins", async () => {
    const o = await setup();
    const admin = await signIn(o.t, "root");
    await o.t.run(async (ctx) => ctx.db.patch(admin.userId, { platformRole: "super_admin" }));
    const base = { organizationId: o.organizationId, planKey: "business" as const };
    await expectCode(o.owner.as.mutation(api.platform.grantPlan, { ...base, until: Date.now() + DAY, reason: "friendly" }), "FORBIDDEN");
    await expectCode(admin.as.mutation(api.platform.grantPlan, { ...base, until: Date.now() + DAY, reason: "x" }), "VALIDATION");
    await expectCode(admin.as.mutation(api.platform.grantPlan, { ...base, until: Date.now() + DAY, reason: "y".repeat(501) }), "VALIDATION");
    await expectCode(admin.as.mutation(api.platform.grantPlan, { ...base, until: Date.now() - DAY, reason: "friendly" }), "VALIDATION");
    await expectCode(admin.as.mutation(api.platform.grantPlan, { ...base, until: Date.now() + 6 * 366 * DAY, reason: "friendly" }), "VALIDATION");
    await expectCode(admin.as.mutation(api.platform.grantPlan, { ...base, until: Number.NaN, reason: "friendly" }), "VALIDATION");
  });
});

// Keep an Id import referenced for readers: payments are addressed by Id<"billingPayments">.
export type PaymentId = Id<"billingPayments">;
