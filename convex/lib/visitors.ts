import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { visitorSchema } from "../../lib/validation/visits";
import { hasSiteAccess, type OrgContext } from "./auth";
import { appError } from "./errors";
import { parseOrThrow } from "./validate";

export type VisitorInput = { name: string; phone?: string; email?: string; company?: string };

/**
 * Find a returning visitor by phone within the organization, or create one.
 * Matching is per organization only; visitors are never shared across tenants.
 */
export async function upsertVisitor(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  input: VisitorInput,
  /**
   * Kiosk (public) callers pass `false`: a returning visitor is matched by
   * phone but their stored record is never edited by an unauthenticated form.
   */
  { updateExisting = true }: { updateExisting?: boolean } = {},
): Promise<Id<"visitors">> {
  const data = parseOrThrow(visitorSchema, input);
  const now = Date.now();
  if (data.phone) {
    const existing = await ctx.db
      .query("visitors")
      .withIndex("by_org_phone", (q) => q.eq("organizationId", organizationId).eq("phone", data.phone))
      .first();
    if (existing) {
      if (!updateExisting) return existing._id;
      await ctx.db.patch(existing._id, {
        name: data.name,
        email: data.email ?? existing.email,
        company: data.company ?? existing.company,
        updatedAt: now,
      });
      return existing._id;
    }
  }
  return await ctx.db.insert("visitors", {
    organizationId,
    name: data.name,
    phone: data.phone,
    email: data.email,
    company: data.company,
    createdAt: now,
    updatedAt: now,
  });
}

/** An active gate at `siteId` in the caller's organization. */
export async function requireGate(
  ctx: QueryCtx,
  oc: OrgContext,
  gateId: Id<"gates">,
  siteId: Id<"sites">,
) {
  const gate = await ctx.db.get(gateId);
  if (!gate || gate.organizationId !== oc.org._id || gate.siteId !== siteId) {
    throw appError("NOT_FOUND");
  }
  if (gate.status !== "active") throw appError("CONFLICT", "This gate is inactive.");
  return gate;
}

/** A host must be an active member of the organization with access to the site. */
export async function requireHost(
  ctx: QueryCtx,
  oc: OrgContext,
  hostUserId: Id<"users">,
  siteId: Id<"sites">,
) {
  await assertHost(ctx, oc.org._id, hostUserId, siteId);
}

/** Same check without a signed-in context (used by the kiosk). Returns the membership. */
export async function assertHost(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  hostUserId: Id<"users">,
  siteId: Id<"sites">,
) {
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_org_user", (q) => q.eq("organizationId", organizationId).eq("userId", hostUserId))
    .unique();
  if (!membership || membership.status !== "active" || !hasSiteAccess(membership, siteId)) {
    throw appError("VALIDATION", "Choose a host who works at this site.");
  }
  return membership;
}
