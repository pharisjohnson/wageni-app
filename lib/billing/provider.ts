/**
 * Payment provider abstraction. PayHero (M-Pesa STK push) is the only live
 * implementation; a "dry-run" adapter records payments without any network
 * call. Another provider can be added by implementing PaymentProvider and
 * selecting it in `convex/billingPayhero.ts#getProvider`.
 */
export type InitiateInput = {
  amountKes: number;
  /** Local Kenyan format, e.g. 0712345678. Exists only in memory for this call. */
  phoneLocal: string;
  externalReference: string;
  callbackUrl: string;
  customerName?: string;
};

export type InitiateResult =
  | { ok: true; reference: string; checkoutRequestId?: string }
  | { ok: false; reason: "rejected" | "provider_unavailable" };

export type VerifyResult = {
  /** "unknown" = the provider could not be asked, or does not know the payment (yet). Never credit on it. */
  state: "success" | "failed" | "pending" | "unknown";
  reference?: string;
  checkoutRequestId?: string;
  /** Present only if the provider's status response carries it. */
  amountKes?: number;
  /** M-Pesa confirmation code, when the provider reports it. */
  receipt?: string;
};

export interface PaymentProvider {
  readonly name: "payhero" | "dry-run";
  initiate(input: InitiateInput): Promise<InitiateResult>;
  /** Ask the PROVIDER (server to server) what happened to a payment. The source of truth. */
  verify(args: { reference: string }): Promise<VerifyResult>;
}

/** What we stored when the payment was created; the verification result must agree with it. */
export type ExpectedPayment = {
  amountKes: number;
  payheroReference?: string;
  checkoutRequestId?: string;
};

export type Decision = "credit" | "failed" | "pending" | "mismatch";

/**
 * Decide what a provider verification means for OUR stored payment. Credits
 * only on an explicit success whose identifiers (and amount, if reported)
 * match what we recorded.
 */
export function evaluateVerification(expected: ExpectedPayment, result: VerifyResult): Decision {
  if (result.state === "failed") return "failed";
  if (result.state !== "success") return "pending";
  if (!expected.payheroReference || !result.reference) return "mismatch";
  if (result.reference.toUpperCase() !== expected.payheroReference.toUpperCase()) return "mismatch";
  if (expected.checkoutRequestId && result.checkoutRequestId && result.checkoutRequestId !== expected.checkoutRequestId) {
    return "mismatch";
  }
  if (typeof result.amountKes === "number" && result.amountKes !== expected.amountKes) return "mismatch";
  return "credit";
}

// ---- Retry and abuse limits (ours; PayHero blocks a number after >10 failures in a row) ----

export const PAYMENT_LIMITS = {
  /** An unanswered STK push is given up on after this long. */
  pendingTtlMs: 10 * 60 * 1000,
  /** Pending payments are not checked against the provider before this age (the callback usually arrives first). */
  reconcileAfterMs: 30 * 1000,
  /** Minimum gap between two attempts by one organization. */
  cooldownMs: 30 * 1000,
  /** Attempts per phone number (all organizations) per hour. */
  perPhonePerHour: 3,
  /** Attempts per organization per hour. */
  perOrgPerHour: 6,
  /** Failed, cancelled or timed-out attempts in a row on one number within 24h before it is blocked for us (PayHero blocks at more than 10). */
  maxConsecutiveFailuresPerPhone: 5,
  /** Failed attempts across the whole account in 6h before we pause new checkouts (PayHero restricts the account above 50). */
  globalFailuresPer6h: 40,
  /** Late successes are still looked for this long after an attempt. */
  lateSuccessWindowMs: 24 * 60 * 60 * 1000,
  /** Verification calls for one payment are at least this far apart (callback flooding guard). */
  minCheckGapMs: 3 * 1000,
} as const;

export const MAX_CALLBACK_BYTES = 8 * 1024;

// ---- Tokens and hashing (Web Crypto, available in Convex and Node) ----

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** URL tokens produced by randomToken(32): 43 base64url characters. */
export function isCallbackTokenShape(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** Keyed hash for phone numbers (low entropy, so a plain hash would be reversible by enumeration). */
export async function hmacHex(key: string, text: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text)));
}
