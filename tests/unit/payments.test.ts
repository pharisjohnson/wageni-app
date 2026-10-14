import { describe, expect, test, vi } from "vitest";
import { basicAuthHeader, createDryRunProvider, createPayheroProvider, parseCallbackHint } from "../../lib/billing/payhero";
import { normalizeKenyanMobile } from "../../lib/billing/phone";
import { priceFor, PLAN_PRICES_KES } from "../../lib/billing/pricing";
import { evaluateVerification, hmacHex, isCallbackTokenShape, randomToken, sha256Hex } from "../../lib/billing/provider";
import { DAY_MS, extendSubscription, isBlockedDowngrade, PERIOD_DAYS, type SubState } from "../../lib/billing/subscription";

const NOW = Date.UTC(2026, 9, 14, 9, 0, 0);

describe("kenyan phone normalization", () => {
  test.each([
    ["0712345678", "+254712345678", "0712345678"],
    ["0712 345 678", "+254712345678", "0712345678"],
    ["712345678", "+254712345678", "0712345678"],
    ["+254712345678", "+254712345678", "0712345678"],
    ["254712345678", "+254712345678", "0712345678"],
    ["00254712345678", "+254712345678", "0712345678"],
    ["0112345678", "+254112345678", "0112345678"],
    ["0712-345-678", "+254712345678", "0712345678"],
  ])("%s", (input, e164, local) => {
    expect(normalizeKenyanMobile(input)).toEqual({ e164, local });
  });

  test.each(["", "abc", "0212345678", "+255712345678", "071234567", "07123456789", "+1 202 555 0100", "0712345678; drop"])(
    "rejects %j",
    (input) => {
      expect(normalizeKenyanMobile(input)).toBeNull();
    },
  );
  test("null and undefined", () => {
    expect(normalizeKenyanMobile(undefined)).toBeNull();
    expect(normalizeKenyanMobile(null)).toBeNull();
  });
});

describe("pricing config", () => {
  test("no prices are invented: every price is null by default and checkout has no amount", () => {
    for (const plan of ["business", "enterprise"] as const) {
      for (const period of ["monthly", "annual"] as const) {
        expect(PLAN_PRICES_KES[plan][period]).toBeNull();
        expect(priceFor(plan, period)).toBeNull();
      }
    }
  });
  test("only positive whole numbers count as prices", () => {
    const table = { business: { monthly: 100, annual: 0 }, enterprise: { monthly: 1.5, annual: null } };
    expect(priceFor("business", "monthly", table)).toBe(100);
    expect(priceFor("business", "annual", table)).toBeNull();
    expect(priceFor("enterprise", "monthly", table)).toBeNull();
  });
});

describe("subscription extension math", () => {
  const live = (over: Partial<SubState> = {}): SubState => ({
    planKey: "business",
    period: "monthly",
    status: "active",
    currentPeriodStart: NOW - 10 * DAY_MS,
    currentPeriodEnd: NOW + 20 * DAY_MS,
    ...over,
  });
  const biz = { planKey: "business", period: "monthly" } as const;

  test("first payment starts now", () => {
    expect(extendSubscription(null, biz, NOW)).toEqual({
      planKey: "business",
      period: "monthly",
      currentPeriodStart: NOW,
      currentPeriodEnd: NOW + PERIOD_DAYS.monthly * DAY_MS,
    });
  });

  test("early renewal stacks onto the current end (no days lost)", () => {
    const r = extendSubscription(live(), biz, NOW);
    expect(r.currentPeriodStart).toBe(NOW + 20 * DAY_MS);
    expect(r.currentPeriodEnd).toBe(NOW + 50 * DAY_MS);
  });

  test("renewal after expiry (also within grace) starts now", () => {
    const expired = live({ currentPeriodEnd: NOW - 2 * DAY_MS });
    expect(extendSubscription(expired, biz, NOW)).toMatchObject({ currentPeriodStart: NOW, currentPeriodEnd: NOW + 30 * DAY_MS });
    const ended = live({ status: "ended", currentPeriodEnd: NOW - 40 * DAY_MS });
    expect(extendSubscription(ended, biz, NOW).currentPeriodStart).toBe(NOW);
  });

  test("annual is 365 days and stacks too", () => {
    const annual = { planKey: "business", period: "annual" } as const;
    expect(extendSubscription(null, annual, NOW).currentPeriodEnd).toBe(NOW + 365 * DAY_MS);
    expect(extendSubscription(live(), annual, NOW)).toMatchObject({ period: "annual", currentPeriodEnd: NOW + 20 * DAY_MS + 365 * DAY_MS });
  });

  test("paying during a trial replaces it from now", () => {
    const trial = live({ status: "trialing", trialEndsAt: NOW + 5 * DAY_MS, currentPeriodEnd: NOW + 5 * DAY_MS });
    expect(extendSubscription(trial, biz, NOW)).toMatchObject({ currentPeriodStart: NOW, currentPeriodEnd: NOW + 30 * DAY_MS });
  });

  test("upgrade business -> enterprise starts now; unused time is not credited", () => {
    const r = extendSubscription(live(), { planKey: "enterprise", period: "monthly" }, NOW);
    expect(r).toMatchObject({ planKey: "enterprise", currentPeriodStart: NOW, currentPeriodEnd: NOW + 30 * DAY_MS });
  });

  test("a lower-plan payment arriving while a higher plan runs keeps the higher plan and extends it", () => {
    const ent = live({ planKey: "enterprise" });
    const r = extendSubscription(ent, biz, NOW);
    expect(r.planKey).toBe("enterprise");
    expect(r.currentPeriodEnd).toBe(NOW + 50 * DAY_MS);
  });

  test("downgrades are blocked only while the higher plan is paid", () => {
    expect(isBlockedDowngrade(live({ planKey: "enterprise" }), "business", NOW)).toBe(true);
    expect(isBlockedDowngrade(live({ planKey: "enterprise", currentPeriodEnd: NOW - DAY_MS }), "business", NOW)).toBe(false);
    expect(isBlockedDowngrade(live(), "enterprise", NOW)).toBe(false);
    expect(isBlockedDowngrade(null, "business", NOW)).toBe(false);
  });
});

describe("verification decision", () => {
  const expected = { amountKes: 500, payheroReference: "E8UWT7CLUW", checkoutRequestId: "ws_CO_1" };
  test("credits only on success with matching identifiers", () => {
    expect(evaluateVerification(expected, { state: "success", reference: "E8UWT7CLUW", checkoutRequestId: "ws_CO_1" })).toBe("credit");
    expect(evaluateVerification(expected, { state: "success", reference: "e8uwt7cluw" })).toBe("credit");
  });
  test("a different reference, checkout id or amount never credits", () => {
    expect(evaluateVerification(expected, { state: "success", reference: "OTHER" })).toBe("mismatch");
    expect(evaluateVerification(expected, { state: "success", reference: "E8UWT7CLUW", checkoutRequestId: "ws_CO_2" })).toBe("mismatch");
    expect(evaluateVerification(expected, { state: "success", reference: "E8UWT7CLUW", amountKes: 1 })).toBe("mismatch");
    expect(evaluateVerification(expected, { state: "success" })).toBe("mismatch");
    expect(evaluateVerification({ amountKes: 500 }, { state: "success", reference: "X" })).toBe("mismatch");
  });
  test("pending, unknown and failed", () => {
    expect(evaluateVerification(expected, { state: "pending" })).toBe("pending");
    expect(evaluateVerification(expected, { state: "unknown" })).toBe("pending");
    expect(evaluateVerification(expected, { state: "failed" })).toBe("failed");
  });
});

describe("tokens and hashing", () => {
  test("callback tokens are 43 url-safe characters and unique", () => {
    const a = randomToken();
    expect(isCallbackTokenShape(a)).toBe(true);
    expect(randomToken()).not.toBe(a);
    expect(isCallbackTokenShape("short")).toBe(false);
    expect(isCallbackTokenShape(`${"a".repeat(42)}/`)).toBe(false);
  });
  test("hashes are stable, keyed and not the input", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const h1 = await hmacHex("k1", "+254712345678");
    expect(h1).toBe(await hmacHex("k1", "+254712345678"));
    expect(h1).not.toBe(await hmacHex("k2", "+254712345678"));
    expect(h1).not.toContain("712345678");
  });
});

describe("PayHero adapter (fetch mocked)", () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const input = {
    amountKes: 10,
    phoneLocal: "0712345678",
    externalReference: "WGabc",
    callbackUrl: "https://x.convex.site/webhooks/payhero/tok",
  };

  test("auth header accepts the token with or without the Basic prefix", () => {
    expect(basicAuthHeader("abc123==")).toBe("Basic abc123==");
    expect(basicAuthHeader("Basic abc123==")).toBe("Basic abc123==");
    expect(basicAuthHeader("  basic   abc123== ")).toBe("Basic abc123==");
  });

  test("initiate posts the documented body and parses the 201 response", async () => {
    const fetchMock = vi.fn(async () => json({ success: true, status: "QUEUED", reference: "E8UWT7CLUW", CheckoutRequestID: "ws_CO_1" }, 201));
    const p = createPayheroProvider({ authToken: "tok", channelId: 133 }, fetchMock as unknown as typeof fetch);
    const res = await p.initiate(input);
    expect(res).toEqual({ ok: true, reference: "E8UWT7CLUW", checkoutRequestId: "ws_CO_1" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://backend.payhero.co.ke/api/v2/payments");
    expect((init.headers as Record<string, string>).Authorization).toBe("Basic tok");
    expect(JSON.parse(init.body as string)).toEqual({
      amount: 10,
      phone_number: "0712345678",
      channel_id: 133,
      provider: "m-pesa",
      external_reference: "WGabc",
      callback_url: input.callbackUrl,
    });
  });

  test("initiate failures: rejected vs unavailable, never throws", async () => {
    const mk = (f: () => Promise<Response>) => createPayheroProvider({ authToken: "t", channelId: 1 }, f as unknown as typeof fetch);
    expect(await mk(async () => json({ error: "bad" }, 400)).initiate(input)).toEqual({ ok: false, reason: "rejected" });
    expect(await mk(async () => json({}, 503)).initiate(input)).toEqual({ ok: false, reason: "provider_unavailable" });
    expect(await mk(async () => { throw new Error("network"); }).initiate(input)).toEqual({ ok: false, reason: "provider_unavailable" });
    expect(await mk(async () => json({ success: true }, 201)).initiate(input)).toEqual({ ok: false, reason: "rejected" });
  });

  test("verify maps QUEUED / SUCCESS / FAILED and treats errors as unknown", async () => {
    const mk = (f: () => Promise<Response>) => createPayheroProvider({ authToken: "t", channelId: 1 }, f as unknown as typeof fetch);
    const ok = await mk(async () => json({ status: "SUCCESS", reference: "E8UWT7CLUW", CheckoutRequestID: "ws_CO_1", provider_reference: "RGH1234ABC" })).verify({
      reference: "E8UWT7CLUW",
    });
    expect(ok).toMatchObject({ state: "success", reference: "E8UWT7CLUW", checkoutRequestId: "ws_CO_1", receipt: "RGH1234ABC" });
    expect((await mk(async () => json({ status: "QUEUED" })).verify({ reference: "r" })).state).toBe("pending");
    expect((await mk(async () => json({ status: "FAILED" })).verify({ reference: "r" })).state).toBe("failed");
    expect((await mk(async () => json({ status: "???" })).verify({ reference: "r" })).state).toBe("unknown");
    expect((await mk(async () => json({}, 404)).verify({ reference: "r" })).state).toBe("unknown");
    expect((await mk(async () => { throw new Error("x"); }).verify({ reference: "r" })).state).toBe("unknown");
  });

  test("a non M-Pesa-looking provider_reference is not used as a receipt; the reference is URL-encoded", async () => {
    const fetchMock = vi.fn(async () => json({ status: "SUCCESS", reference: "R", provider_reference: "not a code" }));
    const p = createPayheroProvider({ authToken: "t", channelId: 1 }, fetchMock as unknown as typeof fetch);
    expect((await p.verify({ reference: "a b&c" })).receipt).toBeUndefined();
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toContain("reference=a%20b%26c");
  });

  test("dry-run adapter never touches the network and never reports success", async () => {
    const p = createDryRunProvider();
    const res = await p.initiate(input);
    expect(res.ok).toBe(true);
    expect((await p.verify({ reference: "x" })).state).toBe("pending");
  });

  test("callback hint keeps only the two fields we use", () => {
    expect(
      parseCallbackHint({ response: { ExternalReference: "WGabc", MpesaReceiptNumber: "rgh1234abc", Amount: 99999, Status: "Success" }, status: true }),
    ).toEqual({ externalReference: "WGabc", receipt: "RGH1234ABC" });
    expect(parseCallbackHint({ response: { MpesaReceiptNumber: "<script>" } })).toEqual({ externalReference: undefined, receipt: undefined });
    expect(parseCallbackHint(null)).toEqual({});
    expect(parseCallbackHint("x")).toEqual({});
  });
});
