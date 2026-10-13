import { constantTimeEqual } from "../notifications/webhook";

/**
 * Svix webhook signature verification (Clerk delivers webhooks through Svix).
 *
 * Headers: `svix-id`, `svix-timestamp` (unix seconds), `svix-signature`
 * (space separated list of `v1,<base64>`). The signed content is
 * `${svix-id}.${svix-timestamp}.${rawBody}`, HMAC-SHA256 with the key being the
 * base64-decoded part of the signing secret after its `whsec_` prefix.
 * Timestamps outside the replay window are rejected. Web Crypto only, so it
 * runs in Convex and in tests.
 */
export const SVIX_REPLAY_WINDOW_SECONDS = 300;

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}

async function hmac(secret: string, content: string): Promise<string | null> {
  const raw = base64ToBytes(secret.startsWith("whsec_") ? secret.slice(6) : secret);
  if (!raw || raw.length === 0) return null;
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToBase64(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(content)));
}

/** Produce a `v1,<sig>` header value. Used by tests; handy for local replays too. */
export async function signSvix(secret: string, id: string, timestamp: string, body: string): Promise<string> {
  const sig = await hmac(secret, `${id}.${timestamp}.${body}`);
  if (!sig) throw new Error("invalid secret");
  return `v1,${sig}`;
}

export async function verifySvix(input: {
  secret: string;
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  body: string;
  nowMs?: number;
}): Promise<boolean> {
  const { secret, id, timestamp, signature, body } = input;
  if (!secret || !id || !timestamp || !signature) return false;
  if (id.length > 200 || !/^\d{9,12}$/.test(timestamp)) return false;
  const skew = Math.abs((input.nowMs ?? Date.now()) / 1000 - Number(timestamp));
  if (skew > SVIX_REPLAY_WINDOW_SECONDS) return false;
  const expected = await hmac(secret, `${id}.${timestamp}.${body}`);
  if (!expected) return false;
  let ok = false;
  // Check every candidate (no early exit) so timing does not reveal which one matched.
  for (const part of signature.split(" ").slice(0, 10)) {
    const [version, sig] = part.split(",");
    if (version === "v1" && sig && constantTimeEqual(expected, sig)) ok = true;
  }
  return ok;
}
