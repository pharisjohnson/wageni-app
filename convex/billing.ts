import { paginationOptsValidator } from "convex/server";
import { LIMIT_KEYS, monthKey } from "../lib/billing/entitlements";
import { query } from "./_generated/server";
import { requirePlatformAdmin } from "./lib/auth";
import { currentCount, findOwner, getOrgEntitlements } from "./lib/entitlements";
import { orgQuery } from "./lib/functions";
import { readUsage } from "./lib/usage";

/**
 * The organization's plan facts for the UI (hiding controls, upgrade prompts).
 * Any active member may read it; it contains no billing identity. The server
 * still enforces every restriction itself.
 */
export const entitlements = orgQuery({
  args: {},
  handler: async (ctx) => {
    const ent = await getOrgEntitlements(ctx, ctx.oc.org._id);
    return {
      enforced: ent.enforced,
      tier: ent.tier,
      features: [...ent.features],
      limits: ent.limits,
    };
  },
});

/**
 * Billing page data (`billing:manage`, owner-level by default): plan, status,
 * limits against usage, and whether the caller holds the subscription.
 */
export const overview = orgQuery({
  args: {},
  handler: async (ctx) => {
    ctx.require("billing:manage");
    const orgId = ctx.oc.org._id;
    const ent = await getOrgEntitlements(ctx, orgId);
    const usage = Object.fromEntries(
      await Promise.all(LIMIT_KEYS.map(async (k) => [k, await currentCount(ctx, orgId, k)] as const)),
    ) as Record<(typeof LIMIT_KEYS)[number], number>;
    const [files, fileBytes] = await Promise.all([
      readUsage(ctx, orgId, "files"),
      readUsage(ctx, orgId, "fileBytes"),
    ]);
    const owner = await findOwner(ctx, orgId);
    const isSubscriptionHolder = owner !== null && owner._id === ctx.oc.user._id;
    return {
      enforced: ent.enforced,
      bypassReason: ent.bypassReason,
      tier: ent.tier,
      features: [...ent.features],
      limits: ent.limits,
      usage,
      filesThisMonth: files,
      fileBytesThisMonth: fileBytes,
      month: monthKey(Date.now()),
      subscription: {
        status: ent.subscriptionStatus,
        isFreeTrial: ent.isFreeTrial,
        trialEndsAt: ent.trialEndsAt,
        currentPeriodEnd: ent.currentPeriodEnd,
        accessEndsAt: ent.accessEndsAt,
      },
      isSubscriptionHolder,
      // Only shown when someone else holds the plan, so they can be asked to change it.
      ownerName: isSubscriptionHolder ? null : (owner?.name ?? owner?.email ?? null),
    };
  },
});

/**
 * Platform operators: per-organization plan and usage meters. Metadata and
 * counts only: no visitors, members, messages or file contents.
 */
export const platformUsage = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    await requirePlatformAdmin(ctx);
    const page = await ctx.db
      .query("organizations")
      .withIndex("by_created")
      .order("desc")
      .paginate(paginationOpts);
    const rows = await Promise.all(
      page.page.map(async (o) => {
        const ent = await getOrgEntitlements(ctx, o._id);
        const [sites, gates, staff, visits, notifications, files, fileBytes] = await Promise.all([
          currentCount(ctx, o._id, "sites"),
          currentCount(ctx, o._id, "gates"),
          currentCount(ctx, o._id, "staff"),
          readUsage(ctx, o._id, "visits"),
          readUsage(ctx, o._id, "notifications"),
          readUsage(ctx, o._id, "files"),
          readUsage(ctx, o._id, "fileBytes"),
        ]);
        return {
          _id: o._id,
          name: o.name,
          slug: o.slug,
          status: o.status,
          isDemo: o.isDemo ?? false,
          tier: ent.tier,
          enforced: ent.enforced,
          subscriptionStatus: ent.subscriptionStatus,
          limits: ent.limits,
          sites,
          gates,
          staff,
          visits,
          notifications,
          files,
          fileBytes,
        };
      }),
    );
    return { ...page, page: rows, month: monthKey(Date.now()) };
  },
});
