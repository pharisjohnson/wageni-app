import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { requirePlatformAdmin } from "./lib/auth";
import { writeAudit } from "./lib/audit";
import { appError } from "./lib/errors";
import { vPlanKey } from "./validators";

/**
 * Platform (SaaS operator) functions. These expose organization metadata
 * only — never visitors, members or other tenant records.
 */
export const listOrganizations = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    await requirePlatformAdmin(ctx);
    const page = await ctx.db
      .query("organizations")
      .withIndex("by_created")
      .order("desc")
      .paginate(paginationOpts);
    return {
      ...page,
      page: page.page.map((o) => ({
        _id: o._id,
        name: o.name,
        slug: o.slug,
        status: o.status,
        isDemo: o.isDemo ?? false,
        createdAt: o.createdAt,
      })),
    };
  },
});

export const setOrganizationStatus = mutation({
  args: {
    organizationId: v.id("organizations"),
    status: v.union(v.literal("trial"), v.literal("active"), v.literal("suspended")),
    reason: v.string(),
  },
  handler: async (ctx, { organizationId, status, reason }) => {
    const admin = await requirePlatformAdmin(ctx);
    const trimmed = reason.trim();
    if (trimmed.length < 5 || trimmed.length > 500) {
      throw appError("VALIDATION", "Provide a reason (5–500 characters).");
    }
    const org = await ctx.db.get(organizationId);
    if (!org) throw appError("NOT_FOUND");
    await ctx.db.patch(organizationId, { status, updatedAt: Date.now() });
    await writeAudit(ctx, {
      organizationId,
      actorUserId: admin._id,
      action: "platform.organization_status_changed",
      resourceType: "organization",
      resourceId: organizationId,
      metadata: { from: org.status, to: status, reason: trimmed },
    });
  },
});

/**
 * Bootstrap a platform operator. Internal: callable only from the Convex
 * dashboard or CLI by someone with deployment access, e.g.
 * `npx convex run platform:grantSuperAdmin '{"email":"ops@example.com"}'`.
 */
export const grantSuperAdmin = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email.trim()))
      .first();
    if (!user) throw appError("NOT_FOUND", "No user with that email has signed in yet.");
    await ctx.db.patch(user._id, { platformRole: "super_admin", updatedAt: Date.now() });
    return user._id;
  },
});

const MAX_GRANT_MS = 5 * 366 * 24 * 60 * 60 * 1000;

/**
 * Give an organization a plan until a date without M-Pesa payment (manual or
 * invoiced customers, sales-assisted Enterprise). Replaces any existing
 * subscription row. Platform administrators only; always audit-logged with the
 * reason. No reminders are sent for manual grants; after `until` the usual
 * 7-day grace applies, then the organization is on Starter (data is kept).
 */
export const grantPlan = mutation({
  args: { organizationId: v.id("organizations"), planKey: vPlanKey, until: v.number(), reason: v.string() },
  handler: async (ctx, { organizationId, planKey, until, reason }) => {
    const admin = await requirePlatformAdmin(ctx);
    const trimmed = reason.trim();
    if (trimmed.length < 5 || trimmed.length > 500) throw appError("VALIDATION", "Provide a reason (5-500 characters).");
    const now = Date.now();
    if (!Number.isFinite(until) || until <= now || until > now + MAX_GRANT_MS) {
      throw appError("VALIDATION", "Choose an end date in the future, at most five years away.");
    }
    const org = await ctx.db.get(organizationId);
    if (!org) throw appError("NOT_FOUND");
    const existing = await ctx.db
      .query("subscriptions")
      .withIndex("by_org", (q) => q.eq("organizationId", organizationId))
      .unique();
    const fields = {
      planKey,
      period: undefined,
      status: "active" as const,
      currentPeriodStart: now,
      currentPeriodEnd: until,
      source: "manual" as const,
      updatedAt: now,
    };
    if (existing) await ctx.db.replace(existing._id, { organizationId, ...fields, trialEndsAt: existing.trialEndsAt, createdAt: existing.createdAt });
    else await ctx.db.insert("subscriptions", { organizationId, ...fields, createdAt: now });
    await writeAudit(ctx, {
      organizationId,
      actorUserId: admin._id,
      action: "platform.plan_granted",
      resourceType: "subscription",
      resourceId: organizationId,
      metadata: {
        planKey,
        until,
        reason: trimmed,
        previousPlan: existing?.planKey ?? null,
        previousSource: existing?.source ?? null,
      },
    });
  },
});
