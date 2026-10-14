import { v } from "convex/values";
import { customMutation, customQuery } from "convex-helpers/server/customFunctions";
import type { Doc } from "../_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { appError } from "./errors";
import { logEvent } from "./log";

/**
 * Kiosk trust. /kiosk/<slug> is a public URL, so the URL alone never
 * authorises anything. A kiosk proves itself with a per-gate device token
 * created by an admin (see convex/kioskDevices.ts). Only the SHA-256 hash of
 * the token is stored.
 *
 * Use `kioskQuery` / `kioskMutation` for every function a kiosk calls. They
 * take `{ slug, token }`, resolve and verify the device, and expose
 * `ctx.kiosk = { org, site, gate, device }`. Every failure (unknown slug,
 * unknown/revoked token, token for another organization, suspended org,
 * inactive site/gate) throws the same generic NOT_FOUND, so a caller cannot
 * tell which check failed.
 *
 * Queries are read-only, so the per-device rate limit and `lastSeenAt` are
 * applied by `kioskMutation` only. Tokens carry 256 bits of entropy, which
 * makes guessing infeasible without per-attempt counters.
 */

/** Fixed window rate limit per device (mutations only). */
export const KIOSK_RATE_WINDOW_MS = 60_000;
export const KIOSK_RATE_MAX_PER_WINDOW = 60;
/** `lastSeenAt` is touched at most this often. */
export const KIOSK_LAST_SEEN_INTERVAL_MS = 5 * 60_000;

const TOKEN_PREFIX = "wk_";
const MAX_TOKEN_LENGTH = 128;

function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashKioskToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toHex(new Uint8Array(digest));
}

/** A new random device token (256 bits, base64url). Shown to the admin once. */
export function generateKioskToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64url = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return TOKEN_PREFIX + b64url;
}

export type KioskContext = {
  org: Doc<"organizations">;
  site: Doc<"sites">;
  gate: Doc<"gates">;
  device: Doc<"kioskDevices">;
};

/** Resolve and verify a device. Throws a generic NOT_FOUND on any failure. */
export async function resolveKiosk(
  ctx: QueryCtx,
  { slug, token }: { slug: string; token: string },
): Promise<KioskContext> {
  const fail = () => appError("NOT_FOUND");
  if (!token.startsWith(TOKEN_PREFIX) || token.length > MAX_TOKEN_LENGTH || slug.length > 100) {
    throw fail();
  }
  const tokenHash = await hashKioskToken(token);
  const device = await ctx.db
    .query("kioskDevices")
    .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
    .unique();
  if (!device || device.status !== "active") throw fail();
  const org = await ctx.db.get(device.organizationId);
  if (!org || org.status === "suspended" || org.slug !== slug.toLowerCase()) throw fail();
  const [site, gate] = await Promise.all([ctx.db.get(device.siteId), ctx.db.get(device.gateId)]);
  if (
    !site ||
    !gate ||
    site.organizationId !== org._id ||
    gate.organizationId !== org._id ||
    gate.siteId !== site._id ||
    site.status !== "active" ||
    gate.status !== "active"
  ) {
    throw fail();
  }
  return { org, site, gate, device };
}

/** Rate limit + sparse lastSeenAt touch. Mutations only. */
async function meter(ctx: MutationCtx, device: Doc<"kioskDevices">) {
  const now = Date.now();
  const windowStart = device.rateWindowStart;
  const inWindow = windowStart !== undefined && now - windowStart < KIOSK_RATE_WINDOW_MS;
  const count = inWindow ? (device.rateCount ?? 0) : 0;
  if (count >= KIOSK_RATE_MAX_PER_WINDOW) {
    logEvent("warn", { event: "rate_limited", fn: "kiosk.meter", outcome: "rejected", org: device.organizationId, code: "RATE_LIMITED" });
    throw appError("RATE_LIMITED");
  }
  const patch: Partial<Doc<"kioskDevices">> = inWindow
    ? { rateCount: count + 1 }
    : { rateWindowStart: now, rateCount: 1 };
  if (device.lastSeenAt === undefined || now - device.lastSeenAt > KIOSK_LAST_SEEN_INTERVAL_MS) {
    patch.lastSeenAt = now;
  }
  await ctx.db.patch(device._id, patch);
}

const kioskArgs = { slug: v.string(), token: v.string() };

export const kioskQuery = customQuery(query, {
  args: kioskArgs,
  input: async (ctx, args) => ({ ctx: { kiosk: await resolveKiosk(ctx, args) }, args: {} }),
});

export const kioskMutation = customMutation(mutation, {
  args: kioskArgs,
  input: async (ctx, args) => {
    const kiosk = await resolveKiosk(ctx, args);
    await meter(ctx, kiosk.device);
    return { ctx: { kiosk }, args: {} };
  },
});
