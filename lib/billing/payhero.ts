import type { InitiateInput, InitiateResult, PaymentProvider, VerifyResult } from "./provider";

/**
 * PayHero adapter (https://docs.payhero.co.ke). Written from the published
 * docs; response fields beyond those documented are read defensively and have
 * NOT been exercised against a live account.
 *
 * - Auth: `Authorization: Basic <token>`, where the token is the ready-made
 *   "Basic Authorization token" from the PayHero dashboard. Both the bare
 *   token and the value with its `Basic ` prefix are accepted.
 * - STK push: POST /api/v2/payments  ->  201 { success, status: "QUEUED", reference, CheckoutRequestID }
 * - Status:   GET  /api/v2/transaction-status?reference=...  ->  { status: "QUEUED"|"SUCCESS"|"FAILED", reference, CheckoutRequestID, provider_reference, ... }
 */
export const PAYHERO_BASE = "https://backend.payhero.co.ke";

export function basicAuthHeader(token: string): string {
  const t = token.trim();
  return /^basic\s+/i.test(t) ? `Basic ${t.replace(/^basic\s+/i, "")}` : `Basic ${t}`;
}

const TIMEOUT_MS = 15_000;
const MPESA_CODE = /^[A-Z0-9]{10}$/;

type Fetch = typeof fetch;

async function request(fetchImpl: Fetch, url: string, init: RequestInit): Promise<Response | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: ctl.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** A non-negative finite number, also accepted from a numeric string; anything else is "not reported". */
function toAmount(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,9}(\.\d{1,2})?$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

const str = (v: unknown) => (typeof v === "string" && v.length > 0 && v.length <= 200 ? v : undefined);

export function createPayheroProvider(
  cfg: { authToken: string; channelId: number; baseUrl?: string },
  fetchImpl: Fetch = fetch,
): PaymentProvider {
  const base = cfg.baseUrl ?? PAYHERO_BASE;
  const headers = { Authorization: basicAuthHeader(cfg.authToken), "Content-Type": "application/json" };
  return {
    name: "payhero",

    async initiate(i: InitiateInput): Promise<InitiateResult> {
      const res = await request(fetchImpl, `${base}/api/v2/payments`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          amount: i.amountKes,
          phone_number: i.phoneLocal,
          channel_id: cfg.channelId,
          provider: "m-pesa",
          external_reference: i.externalReference,
          ...(i.customerName ? { customer_name: i.customerName } : {}),
          callback_url: i.callbackUrl,
        }),
      });
      if (!res) return { ok: false, reason: "provider_unavailable" };
      if (res.status >= 500) return { ok: false, reason: "provider_unavailable" };
      if (!res.ok) return { ok: false, reason: "rejected" };
      const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      const reference = str(json?.reference);
      if (!json || json.success === false || !reference) return { ok: false, reason: "rejected" };
      return { ok: true, reference, checkoutRequestId: str(json.CheckoutRequestID) };
    },

    async verify({ reference }): Promise<VerifyResult> {
      const res = await request(fetchImpl, `${base}/api/v2/transaction-status?reference=${encodeURIComponent(reference)}`, {
        method: "GET",
        headers,
      });
      if (!res || !res.ok) return { state: "unknown" };
      const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!json) return { state: "unknown" };
      const status = typeof json.status === "string" ? json.status.toUpperCase() : "";
      const state = status === "SUCCESS" ? "success" : status === "FAILED" ? "failed" : status === "QUEUED" ? "pending" : "unknown";
      const code = str(json.provider_reference)?.toUpperCase();
      const amount = toAmount(json.amount);
      return {
        state,
        reference: str(json.reference),
        checkoutRequestId: str(json.CheckoutRequestID),
        amountKes: amount,
        receipt: code && MPESA_CODE.test(code) ? code : undefined,
      };
    },
  };
}

/**
 * Dry-run adapter: no network. Payments are recorded as pending and stay so
 * until a developer simulates an outcome (billingPayhero.simulateOutcome).
 */
export function createDryRunProvider(): PaymentProvider {
  return {
    name: "dry-run",
    async initiate(i) {
      return { ok: true, reference: `DRY${i.externalReference.slice(-8).toUpperCase()}` };
    },
    async verify() {
      return { state: "pending" };
    },
  };
}

/** The shape of the (untrusted) callback body: only used as a hint. */
export type CallbackHint = { externalReference?: string; receipt?: string };

export function parseCallbackHint(body: unknown): CallbackHint {
  const r = (body && typeof body === "object" ? (body as Record<string, unknown>).response : null) as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return {};
  const receipt = str(r.MpesaReceiptNumber)?.toUpperCase();
  return { externalReference: str(r.ExternalReference), receipt: receipt && MPESA_CODE.test(receipt) ? receipt : undefined };
}
