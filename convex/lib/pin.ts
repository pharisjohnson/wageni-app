/**
 * Staff PIN hashing. PBKDF2-HMAC-SHA256 via Web Crypto (available in the
 * Convex runtime), per-user random 16-byte salt, 100k iterations. PINs are 4-6
 * digits, so the hash only slows offline guessing; the real protection is the
 * server-side lockout (5 failures, 15 minutes) plus the kiosk device token and
 * rate limit. The PIN is never stored or logged in plain text.
 */
export const PIN_ITERATIONS = 100_000;
export const PIN_MAX_FAILURES = 5;
export const PIN_LOCK_MS = 15 * 60_000;

function toB64(bytes: Uint8Array) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(value: string) {
  const s = atob(value);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function derive(pin: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPin(pin: string) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await derive(pin, salt, PIN_ITERATIONS);
  return { pinHash: toB64(hash), salt: toB64(salt), iterations: PIN_ITERATIONS };
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function verifyPin(
  pin: string,
  record: { pinHash: string; salt: string; iterations: number },
) {
  const hash = await derive(pin, fromB64(record.salt), record.iterations);
  return timingSafeEqual(hash, fromB64(record.pinHash));
}

/** Burn the same CPU as a real check so unknown identifiers are not distinguishable by timing. */
export async function dummyPinWork(pin: string) {
  await derive(pin, new Uint8Array(16), PIN_ITERATIONS);
}
