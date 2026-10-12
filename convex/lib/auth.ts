import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  effectivePermissions,
  type Permission,
} from "../../lib/permissions";
import { appError } from "./errors";

/**
 * Resolve the signed-in user from the identity Convex verified from the
 * auth provider's JWT. Never accept a user id from the client.
 */
export async function requireUser(ctx: QueryCtx): Promise<Doc<"users">> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw appError("UNAUTHENTICATED");
  const user = await ctx.db
    .query("users")
    .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
    .unique();
  // The client calls `users.store` after sign-in; until then the user has no
  // record and therefore no memberships.
  if (!user) throw appError("UNAUTHENTICATED", "Account setup is not complete.");
  return user;
}

export type OrgContext = {
  user: Doc<"users">;
  org: Doc<"organizations">;
  membership: Doc<"memberships">;
  permissions: Set<Permission>;
};

/**
 * The single gate for organization data. Verifies the caller is an active
 * member of an active organization and (optionally) holds `permission`.
 * Non-members get NOT_FOUND so they cannot probe for organizations.
 */
export async function requireMembership(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  permission?: Permission,
): Promise<OrgContext> {
  const user = await requireUser(ctx);
  const org = await ctx.db.get(organizationId);
  if (!org) throw appError("NOT_FOUND");
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_org_user", (q) =>
      q.eq("organizationId", organizationId).eq("userId", user._id),
    )
    .unique();
  if (!membership || membership.status !== "active") throw appError("NOT_FOUND");
  if (org.status === "suspended") {
    throw appError("FORBIDDEN", "This organization is suspended.");
  }
  const permissions = effectivePermissions(
    membership.role,
    membership.permissionOverrides,
  );
  if (permission && !permissions.has(permission)) throw appError("FORBIDDEN");
  return { user, org, membership, permissions };
}

export function hasSiteAccess(
  membership: Doc<"memberships">,
  siteId: Id<"sites">,
): boolean {
  return membership.siteAccess === "all" || membership.siteAccess.includes(siteId);
}

/**
 * Load a site and make sure it belongs to the caller's organization and is
 * within the member's site access. Used by every site-scoped operation.
 */
export async function requireSite(
  ctx: QueryCtx,
  oc: OrgContext,
  siteId: Id<"sites">,
): Promise<Doc<"sites">> {
  const site = await ctx.db.get(siteId);
  if (!site || site.organizationId !== oc.org._id || !hasSiteAccess(oc.membership, siteId)) {
    throw appError("NOT_FOUND");
  }
  return site;
}

/** Platform operators only. Grants no access to tenant data by itself. */
export async function requirePlatformAdmin(ctx: QueryCtx): Promise<Doc<"users">> {
  const user = await requireUser(ctx);
  if (user.platformRole !== "super_admin") throw appError("FORBIDDEN");
  return user;
}
