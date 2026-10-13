import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireFeature } from "./lib/entitlements";
import { orgQuery } from "./lib/functions";

/**
 * Newest-first audit trail for the caller's organization (`audit:read`).
 *
 * P1: optional filters. The most selective one drives an index (actor, then
 * action, then resource type); the others are applied while scanning. The
 * date range always uses the `at` column of whichever index is chosen.
 * Each entry is enriched with a readable actor: a person, a paired kiosk
 * device (`actorUserId` is empty on kiosk self-service entries), or "System".
 */
export const list = orgQuery({
  args: {
    paginationOpts: paginationOptsValidator,
    actorUserId: v.optional(v.id("users")),
    action: v.optional(v.string()),
    resourceType: v.optional(v.string()),
    fromAt: v.optional(v.number()),
    toAt: v.optional(v.number()),
  },
  handler: async (ctx, { paginationOpts, actorUserId, action, resourceType, fromAt, toAt }) => {
    ctx.require("audit:read");
    await requireFeature(ctx, "audit_log");
    const orgId = ctx.oc.org._id;
    const lo = fromAt ?? 0;
    const hi = toAt ?? Number.MAX_SAFE_INTEGER;

    let query;
    if (actorUserId) {
      query = ctx.db
        .query("auditLogs")
        .withIndex("by_org_actor_at", (q) =>
          q.eq("organizationId", orgId).eq("actorUserId", actorUserId).gte("at", lo).lte("at", hi),
        );
    } else if (action) {
      query = ctx.db
        .query("auditLogs")
        .withIndex("by_org_action_at", (q) =>
          q.eq("organizationId", orgId).eq("action", action).gte("at", lo).lte("at", hi),
        );
    } else if (resourceType) {
      query = ctx.db
        .query("auditLogs")
        .withIndex("by_org_resource_at", (q) =>
          q.eq("organizationId", orgId).eq("resourceType", resourceType).gte("at", lo).lte("at", hi),
        );
    } else {
      query = ctx.db
        .query("auditLogs")
        .withIndex("by_org_at", (q) => q.eq("organizationId", orgId).gte("at", lo).lte("at", hi));
    }
    const page = await query
      .filter((q) =>
        q.and(
          action ? q.eq(q.field("action"), action) : true,
          resourceType ? q.eq(q.field("resourceType"), resourceType) : true,
        ),
      )
      .order("desc")
      .paginate(paginationOpts);

    const users = new Map<string, Promise<Doc<"users"> | null>>();
    const devices = new Map<string, Promise<Doc<"kioskDevices"> | null>>();
    const user = (id: Id<"users">) => {
      if (!users.has(id)) users.set(id, ctx.db.get(id));
      return users.get(id)!;
    };
    const device = (id: Id<"kioskDevices">) => {
      if (!devices.has(id)) devices.set(id, ctx.db.get(id));
      return devices.get(id)!;
    };
    const enriched = await Promise.all(
      page.page.map(async (entry) => {
        let actor: { kind: "user" | "kiosk" | "system"; name: string };
        if (entry.actorUserId) {
          const u = await user(entry.actorUserId);
          actor = { kind: "user", name: u?.name ?? u?.email ?? "Unknown user" };
        } else if (entry.kioskDeviceId) {
          const d = await device(entry.kioskDeviceId);
          actor = {
            kind: "kiosk",
            name: d && d.organizationId === orgId ? `Kiosk: ${d.name}` : "Kiosk device",
          };
        } else {
          actor = { kind: "system", name: "System" };
        }
        return { ...entry, actor };
      }),
    );
    return { ...page, page: enriched };
  },
});

/** People who can appear as an audit actor, for the filter dropdown. */
export const actors = orgQuery({
  args: {},
  handler: async (ctx) => {
    ctx.require("audit:read");
    await requireFeature(ctx, "audit_log");
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_org", (q) => q.eq("organizationId", ctx.oc.org._id))
      .take(300);
    const rows = await Promise.all(
      memberships.map(async (m) => {
        const u = await ctx.db.get(m.userId);
        return { userId: m.userId, name: u?.name ?? u?.email ?? "Unknown" };
      }),
    );
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  },
});
