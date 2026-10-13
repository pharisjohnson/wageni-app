import { v } from "convex/values";
import { requireSite } from "./lib/auth";
import { writeAudit } from "./lib/audit";
import { orgMutation, orgQuery } from "./lib/functions";
import { faceCaptureEnabled } from "./lib/policy";

/**
 * Organization and site policy switches shown in Settings.
 * - `requireApproval`: whether appointments and invitations wait for the host
 *   to approve. Organization default is "required"; a site can override it.
 * - `faceCaptureEnabled`: off by default. Turning it on only allows a plain
 *   photo (no matching or recognition exists anywhere in the product).
 */

export const get = orgQuery({
  args: {},
  handler: async (ctx) => {
    ctx.require("settings:manage");
    const { org } = ctx.oc;
    const sites = await ctx.db
      .query("sites")
      .withIndex("by_org", (q) => q.eq("organizationId", org._id))
      .take(200);
    return {
      faceCaptureEnabled: faceCaptureEnabled(org),
      requireApproval: org.policies?.requireApproval ?? true,
      sites: sites.map((s) => ({
        siteId: s._id,
        name: s.name,
        // null = follow the organization setting
        requireApproval: s.requireApproval ?? null,
      })),
    };
  },
});

export const updateOrganization = orgMutation({
  args: { faceCaptureEnabled: v.boolean(), requireApproval: v.boolean() },
  handler: async (ctx, { faceCaptureEnabled: face, requireApproval }) => {
    ctx.require("settings:manage");
    const before = faceCaptureEnabled(ctx.oc.org);
    await ctx.db.patch(ctx.oc.org._id, {
      policies: { ...ctx.oc.org.policies, faceCaptureEnabled: face, requireApproval },
      updatedAt: Date.now(),
    });
    await writeAudit(ctx, {
      organizationId: ctx.oc.org._id,
      actorUserId: ctx.oc.user._id,
      action: "organization.policies_updated",
      resourceType: "organization",
      resourceId: ctx.oc.org._id,
      metadata: { faceCaptureEnabled: face, requireApproval, faceCaptureChanged: before !== face },
    });
  },
});

/** `requireApproval: null` clears the override (follow the organization). */
export const updateSite = orgMutation({
  args: { siteId: v.id("sites"), requireApproval: v.union(v.boolean(), v.null()) },
  handler: async (ctx, { siteId, requireApproval }) => {
    ctx.require("settings:manage");
    await requireSite(ctx, ctx.oc, siteId);
    await ctx.db.patch(siteId, { requireApproval: requireApproval ?? undefined, updatedAt: Date.now() });
    await writeAudit(ctx, {
      organizationId: ctx.oc.org._id,
      actorUserId: ctx.oc.user._id,
      action: "site.approval_policy_updated",
      resourceType: "site",
      resourceId: siteId,
      metadata: { requireApproval },
    });
  },
});
