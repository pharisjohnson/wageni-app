import { effectivePermissions } from "../../lib/permissions";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { EventType } from "../../lib/notifications/templates";
import { enqueueNotification } from "./notify";

/** Absolute link to the billing page when APP_BASE_URL is set, else the path. */
export function billingLink(): string {
  const base = process.env.APP_BASE_URL?.trim().replace(/\/+$/, "");
  return `${base && /^https?:\/\//.test(base) ? base : ""}/app/billing`;
}

export function formatDate(ms: number, timeZone = "Africa/Nairobi"): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short", year: "numeric" }).format(new Date(ms));
}

/**
 * Send a billing notification to every active member who can manage billing
 * (the owners by default). Idempotent per `key`: a repeated trigger enqueues
 * once.
 */
export async function notifyBillingManagers(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  eventType: EventType,
  data: Record<string, string>,
  key: string,
) {
  const members = await ctx.db
    .query("memberships")
    .withIndex("by_org", (q) => q.eq("organizationId", organizationId))
    .take(200);
  for (const m of members) {
    if (m.status !== "active") continue;
    if (!effectivePermissions(m.role, m.permissionOverrides).has("billing:manage")) continue;
    await enqueueNotification(ctx, {
      organizationId,
      eventType,
      recipient: { kind: "user", userId: m.userId },
      data,
      key,
    });
  }
}
