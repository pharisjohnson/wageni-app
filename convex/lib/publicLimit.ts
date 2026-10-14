import type { MutationCtx } from "../_generated/server";
import { appError } from "./errors";
import { logEvent } from "./log";

/**
 * Fixed-window counter for public (unauthenticated) mutations, keyed by an
 * opaque string such as "invite_submit" or "upload:<device>". Throws
 * RATE_LIMITED once `max` calls were taken in the window. Because a throw
 * rolls the transaction back, only calls that were allowed are counted, which
 * is exactly the budget being enforced.
 *
 * Convex gives a function no caller IP, so limits are per key (token, device,
 * or global), not per client. IP-level limiting belongs at the edge (Vercel
 * Firewall); see docs/security.md.
 */
export async function takePublicLimit(ctx: MutationCtx, key: string, max: number, windowMs: number) {
  const now = Date.now();
  const row = await ctx.db
    .query("publicRateLimits")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
  if (!row) {
    await ctx.db.insert("publicRateLimits", { key, windowStart: now, count: 1 });
    return;
  }
  if (now - row.windowStart >= windowMs) {
    await ctx.db.patch(row._id, { windowStart: now, count: 1 });
    return;
  }
  if (row.count >= max) {
    // Scope only (never the key: it can hold a device id or an IP hash).
    const scope = key.startsWith("ip:") ? (key.split(":")[1] ?? "ip") : (key.split(":")[0] ?? "key");
    logEvent("warn", { event: "rate_limited", fn: `publicLimit.${scope}`, outcome: "rejected", code: "RATE_LIMITED" });
    throw appError("RATE_LIMITED");
  }
  await ctx.db.patch(row._id, { count: row.count + 1 });
}
