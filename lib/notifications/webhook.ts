/**
 * Delivery-receipt webhook signing. Providers (or a thin relay in front of
 * them) POST JSON with:
 *   x-wageni-timestamp: unix seconds
 *   x-wageni-signature: hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)
 * The receiver rejects stale timestamps (replay window) and compares in
 * constant time. Uses Web Crypto only, so it runs in Convex and in tests.
 */
export const REPLAY_WINDOW_SECONDS = 300;

const enc = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signWebhook(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp}.${body}`)));
}

/** Compare two strings without an early exit on the first differing character. */
export function constantTimeEqual(a: string, b: string): boolean {
  const max = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < max; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export async function verifyWebhook(input: {
  secret: string;
  timestamp: string | null;
  signature: string | null;
  body: string;
  nowMs?: number;
}): Promise<boolean> {
  const { secret, timestamp, signature, body } = input;
  if (!secret || !timestamp || !signature || !/^\d{9,12}$/.test(timestamp)) return false;
  const skew = Math.abs((input.nowMs ?? Date.now()) / 1000 - Number(timestamp));
  if (skew > REPLAY_WINDOW_SECONDS) return false;
  const expected = await signWebhook(secret, timestamp, body);
  return constantTimeEqual(expected, signature.toLowerCase());
}

export const RECEIPT_STATUSES = ["delivered", "read", "failed"] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];
