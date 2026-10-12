import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  canAssignRole,
  canGrantOverrides,
  ROLE_RANK,
} from "../lib/permissions";
import type { OrgContext } from "./lib/auth";
import { writeAudit } from "./lib/audit";
import { appError } from "./lib/errors";
import { orgMutation, orgQuery } from "./lib/functions";
import type { MutationCtx } from "./_generated/server";
import {
  vMembershipStatus,
  vOrgRole,
  vPermissionOverrides,
  vSiteAccess,
} from "./validators";

export const list = orgQuery({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    ctx.require("members:read");
    const page = await ctx.db
      .query("memberships")
      .withIndex("by_org", (q) => q.eq("organizationId", ctx.oc.org._id))
      .paginate(paginationOpts);
    const rows = [];
    for (const m of page.page) {
      const user = await ctx.db.get(m.userId);
      rows.push({
        _id: m._id,
        role: m.role,
        status: m.status,
        siteAccess: m.siteAccess,
        permissionOverrides: m.permissionOverrides,
        isSelf: m.userId === ctx.oc.user._id,
        user: { name: user?.name ?? null, email: user?.email ?? null },
      });
    }
    return { ...page, page: rows };
  },
});

/**
 * Load another member of the caller's organization for modification. Blocks
 * self-modification (no one can raise their own privileges) and edits to
 * members who rank at or above the caller (unless the caller is an owner).
 */
async function loadManageableMember(
  ctx: MutationCtx & { oc: OrgContext },
  membershipId: Id<"memberships">,
): Promise<Doc<"memberships">> {
  const target = await ctx.db.get(membershipId);
  if (!target || target.organizationId !== ctx.oc.org._id) throw appError("NOT_FOUND");
  if (target.userId === ctx.oc.user._id) {
    throw appError("FORBIDDEN", "You cannot change your own membership.");
  }
  const actorRole = ctx.oc.membership.role;
  if (actorRole !== "owner" && ROLE_RANK[target.role] >= ROLE_RANK[actorRole]) {
    throw appError("FORBIDDEN");
  }
  return target;
}

export const updateRole = orgMutation({
  args: { membershipId: v.id("memberships"), role: vOrgRole },
  handler: async (ctx, { membershipId, role }) => {
    ctx.require("members:manage");
    const target = await loadManageableMember(ctx, membershipId);
    if (!canAssignRole(ctx.oc.membership.role, target.role, role)) throw appError("FORBIDDEN");
    await ctx.db.patch(membershipId, { role, updatedAt: Date.now() });
    await writeAudit(ctx, {
      organizationId: ctx.oc.org._id,
      actorUserId: ctx.oc.user._id,
      action: "membership.role_changed",
      resourceType: "membership",
      resourceId: membershipId,
      metadata: { from: target.role, to: role },
    });
  },
});

export const setOverrides = orgMutation({
  args: { membershipId: v.id("memberships"), overrides: vPermissionOverrides },
  handler: async (ctx, { membershipId, overrides }) => {
    ctx.require("members:manage");
    await loadManageableMember(ctx, membershipId);
    if (!canGrantOverrides(ctx.oc.permissions, overrides)) {
      throw appError("FORBIDDEN", "You can only grant permissions you hold yourself.");
    }
    const unique = {
      grant: [...new Set(overrides.grant)],
      revoke: [...new Set(overrides.revoke)],
    };
    await ctx.db.patch(membershipId, { permissionOverrides: unique, updatedAt: Date.now() });
    await writeAudit(ctx, {
      organizationId: ctx.oc.org._id,
      actorUserId: ctx.oc.user._id,
      action: "membership.overrides_changed",
      resourceType: "membership",
      resourceId: membershipId,
      metadata: { grant: unique.grant.join(","), revoke: unique.revoke.join(",") },
    });
  },
});

export const setSiteAccess = orgMutation({
  args: { membershipId: v.id("memberships"), siteAccess: vSiteAccess },
  handler: async (ctx, { membershipId, siteAccess }) => {
    ctx.require("members:manage");
    await loadManageableMember(ctx, membershipId);
    const actorAccess = ctx.oc.membership.siteAccess;
    if (siteAccess === "all") {
      if (actorAccess !== "all") throw appError("FORBIDDEN");
    } else {
      for (const siteId of siteAccess) {
        const site = await ctx.db.get(siteId);
        if (!site || site.organizationId !== ctx.oc.org._id) throw appError("NOT_FOUND");
        if (actorAccess !== "all" && !actorAccess.includes(siteId)) throw appError("FORBIDDEN");
      }
    }
    await ctx.db.patch(membershipId, { siteAccess, updatedAt: Date.now() });
    await writeAudit(ctx, {
      organizationId: ctx.oc.org._id,
      actorUserId: ctx.oc.user._id,
      action: "membership.site_access_changed",
      resourceType: "membership",
      resourceId: membershipId,
      metadata: { siteAccess: siteAccess === "all" ? "all" : siteAccess.join(",") },
    });
  },
});

export const setStatus = orgMutation({
  args: { membershipId: v.id("memberships"), status: vMembershipStatus },
  handler: async (ctx, { membershipId, status }) => {
    ctx.require("members:manage");
    const target = await loadManageableMember(ctx, membershipId);
    if (status === "invited") throw appError("VALIDATION");
    await ctx.db.patch(membershipId, { status, updatedAt: Date.now() });
    await writeAudit(ctx, {
      organizationId: ctx.oc.org._id,
      actorUserId: ctx.oc.user._id,
      action: "membership.status_changed",
      resourceType: "membership",
      resourceId: membershipId,
      metadata: { from: target.status, to: status },
    });
  },
});
