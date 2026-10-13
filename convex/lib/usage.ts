import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { monthKey } from "../../lib/billing/entitlements";

export type UsageKey = "visits" | "notifications" | "files" | "fileBytes";

/**
 * Add `delta` to this month's counter for an organization. Called from the
 * mutation paths that create the metered thing (never by scanning tables).
 * One small indexed read plus one write.
 */
export async function bumpUsage(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  key: UsageKey,
  delta = 1,
  now = Date.now(),
) {
  const period = monthKey(now);
  const row = await ctx.db
    .query("usageCounters")
    .withIndex("by_org_period_key", (q) => q.eq("organizationId", organizationId).eq("period", period).eq("key", key))
    .unique();
  if (row) await ctx.db.patch(row._id, { value: row.value + delta });
  else await ctx.db.insert("usageCounters", { organizationId, period, key, value: delta });
}

export async function readUsage(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  key: UsageKey,
  now = Date.now(),
): Promise<number> {
  const row = await ctx.db
    .query("usageCounters")
    .withIndex("by_org_period_key", (q) =>
      q.eq("organizationId", organizationId).eq("period", monthKey(now)).eq("key", key),
    )
    .unique();
  return row?.value ?? 0;
}
