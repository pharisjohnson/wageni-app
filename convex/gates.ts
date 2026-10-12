import { v } from "convex/values";
import { gateSchema } from "../lib/validation/organization";
import { requireSite } from "./lib/auth";
import { writeAudit } from "./lib/audit";
import { appError } from "./lib/errors";
import { orgMutation, orgQuery } from "./lib/functions";
import { parseOrThrow } from "./lib/validate";
import { vGateType, vRecordStatus } from "./validators";

const MAX_GATES_PER_SITE = 100;

export const listBySite = orgQuery({
  args: { siteId: v.id("sites") },
  handler: async (ctx, { siteId }) => {
    ctx.require("sites:read");
    await requireSite(ctx, ctx.oc, siteId);
    return await ctx.db
      .query("gates")
      .withIndex("by_site", (q) => q.eq("siteId", siteId))
      .take(MAX_GATES_PER_SITE);
  },
});

export const create = orgMutation({
  args: { siteId: v.id("sites"), name: v.string(), type: vGateType },
  handler: async (ctx, { siteId, ...rest }) => {
    ctx.require("sites:manage");
    await requireSite(ctx, ctx.oc, siteId);
    const input = parseOrThrow(gateSchema, rest);
    const existing = await ctx.db
      .query("gates")
      .withIndex("by_site", (q) => q.eq("siteId", siteId))
      .take(MAX_GATES_PER_SITE);
    if (existing.length >= MAX_GATES_PER_SITE) {
      throw appError("FORBIDDEN", "This site has reached the maximum number of gates.");
    }
    const now = Date.now();
    const gateId = await ctx.db.insert("gates", {
      organizationId: ctx.oc.org._id,
      siteId,
      name: input.name,
      type: input.type,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await writeAudit(ctx, {
      organizationId: ctx.oc.org._id,
      actorUserId: ctx.oc.user._id,
      action: "gate.created",
      resourceType: "gate",
      resourceId: gateId,
      metadata: { siteId },
    });
    return gateId;
  },
});

export const update = orgMutation({
  args: { gateId: v.id("gates"), name: v.string(), type: vGateType, status: vRecordStatus },
  handler: async (ctx, { gateId, status, ...rest }) => {
    ctx.require("sites:manage");
    const gate = await ctx.db.get(gateId);
    if (!gate || gate.organizationId !== ctx.oc.org._id) throw appError("NOT_FOUND");
    await requireSite(ctx, ctx.oc, gate.siteId);
    const input = parseOrThrow(gateSchema, rest);
    await ctx.db.patch(gateId, { ...input, status, updatedAt: Date.now() });
    await writeAudit(ctx, {
      organizationId: ctx.oc.org._id,
      actorUserId: ctx.oc.user._id,
      action: "gate.updated",
      resourceType: "gate",
      resourceId: gateId,
      metadata: { status },
    });
  },
});
