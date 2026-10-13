import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  effectiveTier,
  entitlementsForTier,
  FEATURE_LABELS,
  LIMIT_LABELS,
  minTierFor,
  PAST_DUE_GRACE_MS,
  minTierForLimit,
  tierHasFeature,
  TIER_LABELS,
  type Entitlements,
  type Feature,
  type LimitKey,
  type SubscriptionStatus,
} from "../../lib/billing/entitlements";
import type { OrgContext } from "./auth";
import { planLimitError } from "./errors";
import { readUsage } from "./usage";

/**
 * Plan enforcement. Server-side source of truth; the UI only mirrors it.
 *
 * An organization's plan is its OWNER's Clerk subscription (Wageni tenants are
 * Convex organizations, not Clerk Organizations). Enforcement is off unless
 * the Convex env var BILLING_ENFORCEMENT is exactly "on"; when off, and for
 * demo organizations, every organization has full Enterprise entitlements, so
 * development, tests and pre-launch demos are unaffected.
 *
 * Downgrades never delete data. Over-limit organizations keep what they have
 * and simply cannot create more; extra sites become read-only (see
 * `assertSiteEditable`).
 */
export function billingEnforced(): boolean {
  return process.env.BILLING_ENFORCEMENT === "on";
}

export type OrgEntitlements = Entitlements & {
  /** False when enforcement is off or the organization is a demo (everything unlocked). */
  enforced: boolean;
  bypassReason: "enforcement_off" | "demo" | null;
  /** The Clerk user whose subscription decides the plan (the organization's owner). */
  ownerClerkUserId: string | null;
  ownerUserId: Id<"users"> | null;
  subscriptionStatus: SubscriptionStatus | null;
  isFreeTrial: boolean;
  trialEndsAt: number | null;
  currentPeriodEnd: number | null;
  /** When access ends if nothing changes (cancel at period end, or past-due grace). */
  accessEndsAt: number | null;
};

/** `users.tokenIdentifier` is `<issuer>|<clerk user id>`. */
export function clerkUserIdOf(user: Pick<Doc<"users">, "tokenIdentifier">): string {
  const i = user.tokenIdentifier.lastIndexOf("|");
  return i >= 0 ? user.tokenIdentifier.slice(i + 1) : user.tokenIdentifier;
}

export async function findOwner(ctx: QueryCtx, organizationId: Id<"organizations">) {
  const members = await ctx.db
    .query("memberships")
    .withIndex("by_org", (q) => q.eq("organizationId", organizationId))
    .take(500);
  const owners = members
    .filter((m) => m.role === "owner" && m.status === "active")
    .sort((a, b) => a.createdAt - b.createdAt);
  const first = owners[0];
  return first ? await ctx.db.get(first.userId) : null;
}

const unlocked = (reason: "enforcement_off" | "demo"): OrgEntitlements => ({
  ...entitlementsForTier("enterprise"),
  enforced: false,
  bypassReason: reason,
  ownerClerkUserId: null,
  ownerUserId: null,
  subscriptionStatus: null,
  isFreeTrial: false,
  trialEndsAt: null,
  currentPeriodEnd: null,
  accessEndsAt: null,
});

export async function getOrgEntitlements(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  now = Date.now(),
): Promise<OrgEntitlements> {
  if (!billingEnforced()) return unlocked("enforcement_off");
  const org = await ctx.db.get(organizationId);
  if (!org) return { ...unlocked("enforcement_off"), ...entitlementsForTier("free"), bypassReason: null, enforced: true };
  if (org.isDemo) return unlocked("demo");

  const owner = await findOwner(ctx, organizationId);
  const base = {
    enforced: true as const,
    bypassReason: null,
    ownerClerkUserId: owner ? clerkUserIdOf(owner) : null,
    ownerUserId: owner?._id ?? null,
  };
  if (!owner) return { ...unlocked("enforcement_off"), ...entitlementsForTier("free"), ...base };
  const rows = await ctx.db
    .query("subscriptions")
    .withIndex("by_clerk_user", (q) => q.eq("clerkUserId", base.ownerClerkUserId!))
    .take(50);
  const { tier, row } = effectiveTier(rows, now);
  let accessEndsAt: number | null = null;
  if (row?.status === "canceled") accessEndsAt = row.currentPeriodEnd ?? null;
  if (row?.status === "past_due") accessEndsAt = (row.pastDueAt ?? row.updatedAt) + PAST_DUE_GRACE_MS;
  return {
    ...entitlementsForTier(tier),
    ...base,
    subscriptionStatus: row?.status ?? null,
    isFreeTrial: row?.isFreeTrial ?? false,
    trialEndsAt: row?.isFreeTrial ? (row.trialEndsAt ?? row.currentPeriodEnd ?? null) : null,
    currentPeriodEnd: row?.currentPeriodEnd ?? null,
    accessEndsAt,
  };
}

export function hasFeature(ent: Pick<OrgEntitlements, "tier" | "enforced">, feature: Feature): boolean {
  return !ent.enforced || tierHasFeature(ent.tier, feature);
}

type WithOrg = { oc: Pick<OrgContext, "org"> };

/** Throw PLAN_LIMIT unless the organization's plan includes `feature`. */
export async function requireFeature(ctx: QueryCtx & WithOrg, feature: Feature): Promise<OrgEntitlements> {
  const ent = await getOrgEntitlements(ctx, ctx.oc.org._id);
  if (!hasFeature(ent, feature)) {
    const need = minTierFor(feature);
    throw planLimitError({
      kind: "feature",
      key: feature,
      requiredTier: need,
      message: `${FEATURE_LABELS[feature]} is not included in your current plan. Upgrade to ${TIER_LABELS[need]} to use it.`,
    });
  }
  return ent;
}

const CAP = 5000;

/** Current count of what `key` limits, counted only as far as `cap` (bounded read). */
export async function currentCount(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  key: LimitKey,
  cap = CAP,
): Promise<number> {
  switch (key) {
    case "sites": {
      const rows = await ctx.db
        .query("sites")
        .withIndex("by_org", (q) => q.eq("organizationId", organizationId))
        .take(cap + 1);
      return rows.filter((r) => r.status === "active").length;
    }
    case "gates": {
      const rows = await ctx.db
        .query("gates")
        .withIndex("by_org", (q) => q.eq("organizationId", organizationId))
        .take(cap + 1);
      return rows.filter((r) => r.status === "active").length;
    }
    case "staff": {
      const rows = await ctx.db
        .query("memberships")
        .withIndex("by_org", (q) => q.eq("organizationId", organizationId))
        .take(cap + 1);
      return rows.filter((r) => r.status === "active").length;
    }
    case "forms": {
      const rows = await ctx.db
        .query("forms")
        .withIndex("by_org", (q) => q.eq("organizationId", organizationId))
        .take(cap + 1);
      return rows.filter((r) => r.status !== "archived").length;
    }
    case "visitsPerMonth":
      return await readUsage(ctx, organizationId, "visits");
    case "notificationsPerMonth":
      return await readUsage(ctx, organizationId, "notifications");
  }
}

/**
 * Throw PLAN_LIMIT when adding `adding` more of `key` would exceed the plan.
 * Existing data over the limit (after a downgrade) is untouched; this only
 * stops new records.
 */
export async function requireWithinLimit(
  ctx: QueryCtx & WithOrg,
  key: LimitKey,
  adding = 1,
): Promise<OrgEntitlements> {
  const orgId = ctx.oc.org._id;
  const ent = await getOrgEntitlements(ctx, orgId);
  if (!ent.enforced) return ent;
  const limit = ent.limits[key];
  if (limit === null) return ent;
  const count = await currentCount(ctx, orgId, key, limit);
  if (count + adding > limit) {
    const need = minTierForLimit(key, count + adding - 1);
    throw planLimitError({
      kind: "limit",
      key,
      limit,
      requiredTier: need,
      message:
        limit === 0
          ? `${LIMIT_LABELS[key]} are not included in your current plan. Upgrade to ${TIER_LABELS[need]} to add them.`
          : `Your plan allows ${limit} ${LIMIT_LABELS[key].toLowerCase()}. Upgrade to ${TIER_LABELS[need]} to add more.`,
    });
  }
  return ent;
}

/**
 * Extra sites after a downgrade are view-only: only the oldest `limit` active
 * sites stay editable. Archiving an extra site is still allowed (it frees a slot).
 */
export async function assertSiteEditable(
  ctx: QueryCtx & WithOrg,
  siteId: Id<"sites">,
  opts: { archiving?: boolean } = {},
): Promise<void> {
  const orgId = ctx.oc.org._id;
  const ent = await getOrgEntitlements(ctx, orgId);
  const limit = ent.enforced ? ent.limits.sites : null;
  if (limit === null || opts.archiving) return;
  const rows = await ctx.db
    .query("sites")
    .withIndex("by_org", (q) => q.eq("organizationId", orgId))
    .take(CAP);
  const allowed = rows
    .filter((r) => r.status === "active")
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, limit)
    .map((r) => r._id);
  const site = rows.find((r) => r._id === siteId);
  if (site && site.status === "active" && !allowed.includes(siteId)) {
    throw planLimitError({
      kind: "limit",
      key: "sites",
      limit,
      requiredTier: minTierForLimit("sites", rows.length),
      message: `This site is over your plan's limit of ${limit} and is read-only. Upgrade to edit it, or archive it.`,
    });
  }
}
