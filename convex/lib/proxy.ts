import { v } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import { appError } from "./errors";
import { takePublicLimit } from "./publicLimit";

/**
 * Per-IP rate limiting for the public invitation functions.
 *
 * Convex cannot see a caller's IP. The Next.js route handlers under
 * `app/api/invite/*` can (platform headers), so they hash the address with a
 * server secret and call Convex with `{ proxySecret, ipHash }`. The Convex
 * functions refuse any call whose `proxySecret` does not match the
 * `INVITE_PROXY_SECRET` Convex environment variable, so the only way in is
 * through the proxy and its per-IP counters cannot be skipped by calling
 * Convex directly.
 *
 * Failing closed: with no secret configured every call is refused (FORBIDDEN),
 * unless `ALLOW_UNPROXIED_INVITES=true` is set, which is meant for local
 * development only. In that mode the secret is not checked and all callers
 * share the `dev` counter.
 */

export const proxyArgs = { proxySecret: v.string(), ipHash: v.string() };
export type ProxyArgs = { proxySecret: string; ipHash: string };

const MIN_SECRET_LENGTH = 16;
const HASH_RE = /^[0-9a-f]{64}$/;

async function digest(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/**
 * Constant-time string equality: both sides are hashed to equal-length
 * digests first, so neither the length nor the position of the first
 * difference changes the work done.
 */
export async function secretsMatch(provided: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(provided), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function devUnproxiedAllowed(): boolean {
  return process.env.ALLOW_UNPROXIED_INVITES === "true";
}

/** Throws FORBIDDEN unless the call came through the Next.js proxy (or dev mode is on). */
export async function requireProxy(args: ProxyArgs): Promise<{ ipKey: string }> {
  const expected = process.env.INVITE_PROXY_SECRET ?? "";
  if (expected.length === 0) {
    if (devUnproxiedAllowed()) return { ipKey: "dev" };
    throw appError("FORBIDDEN");
  }
  if (expected.length < MIN_SECRET_LENGTH) throw appError("FORBIDDEN");
  const ok = await secretsMatch(args.proxySecret, expected);
  if (!ok || !HASH_RE.test(args.ipHash)) throw appError("FORBIDDEN");
  return { ipKey: args.ipHash };
}

/** Verify the proxy, then take one unit from this client's budget for `scope`. */
export async function takeIpLimit(
  ctx: MutationCtx,
  args: ProxyArgs,
  scope: string,
  max: number,
  windowMs: number,
): Promise<void> {
  const { ipKey } = await requireProxy(args);
  await takePublicLimit(ctx, `ip:${scope}:${ipKey}`, max, windowMs);
}
