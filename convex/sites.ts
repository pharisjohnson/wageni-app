import { v } from "convex/values";
import { siteSchema } from "../lib/validation/organization";
import { hasSiteAccess, requireSite } from "./lib/auth";
import { writeAudit } from "./lib/audit";
import { orgMutation, orgQuery } from "./lib/functions";
import { parseOrThrow } from "./lib/validate";
import { vRecordStatus } from "./validators";

/** Upper bound per organization; sites are few, so no cursor is needed. */
const MAX_SITES = 200;

/** Sites the caller may access within the organization. */
export const list = orgQuery({
  args: {},
  handler: async (ctx) => {
    ctx.require("sites:read");
    const sites = await ctx.db
      .query("sites")
      .withIndex("by_org", (q) => q.eq("organizationId", ctx.oc.org._id))
      .take(MAX_SITES);
    return sites.filter((s) => hasSiteAccess(ctx.oc.membership, s._id));
  },
});

export const get = orgQuery({
  args: { siteId: v.id("sites") },
  handler: async (ctx, { siteId }) => {
    ctx.require("sites:read");
    return await requireSite(ctx, ctx.oc, siteId);
  },
});

export const create = orgMutation({
  args: { name: v.string(), address: v.optional(v.string()), timeZone: v.string() },
  handler: async (ctx, args) => {
    ctx.require("sites:manage");
    const input = parseOrThrow(siteSchema, args);
    const now = Date.now();
    const siteId = await ctx.db.insert("sites", {
      organizationId: ctx.oc.org._id,
      name: input.name,
      address: input.address || undefined,
      timeZone: input.timeZone,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    // A site-restricted manager keeps access to sites they create.
    const { membership } = ctx.oc;
    if (membership.siteAccess !== "all") {
      await ctx.db.patch(membership._id, {
        siteAccess: [...membership.siteAccess, siteId],
        updatedAt: now,
      });
    }
    await writeAudit(ctx, {
      organizationId: ctx.oc.org._id,
      actorUserId: ctx.oc.user._id,
      action: "site.created",
      resourceType: "site",
      resourceId: siteId,
    });
    return siteId;
  },
});

export const update = orgMutation({
  args: {
    siteId: v.id("sites"),
    name: v.string(),
    address: v.optional(v.string()),
    timeZone: v.string(),
    status: vRecordStatus,
  },
  handler: async (ctx, { siteId, status, ...rest }) => {
    ctx.require("sites:manage");
    await requireSite(ctx, ctx.oc, siteId);
    const input = parseOrThrow(siteSchema, rest);
    await ctx.db.patch(siteId, {
      name: input.name,
      address: input.address || undefined,
      timeZone: input.timeZone,
      status,
      updatedAt: Date.now(),
    });
    await writeAudit(ctx, {
      organizationId: ctx.oc.org._id,
      actorUserId: ctx.oc.user._id,
      action: "site.updated",
      resourceType: "site",
      resourceId: siteId,
      metadata: { status },
    });
  },
});
