import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { LIMIT_KEYS, monthKey } from "../lib/billing/entitlements";
import { trialDays } from "../lib/billing/pricing";
import { DAY_MS } from "../lib/billing/subscription";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, query } from "./_generated/server";
import { paymentMode, simulateOutcome } from "./billingPayhero";
import { requirePlatformAdmin } from "./lib/auth";
import { writeAudit } from "./lib/audit";
import { appError } from "./lib/errors";
import { currentCount, getOrgEntitlements } from "./lib/entitlements";
import { orgMutation, orgQuery } from "./lib/functions";
import { readUsage } from "./lib/usage";
import { vBillingPeriod, vPlanKey } from "./validators";

/**
 * The organization's plan facts for the UI (hiding controls, upgrade prompts).
 * Any active member may read it; it contains no payment details. The server
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

/** Billing page data (`billing:manage`, owner-level by default). */
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
    const sub = await ctx.db
      .query("subscriptions")
      .withIndex("by_org", (q) => q.eq("organizationId", orgId))
      .unique();
    const payments = await ctx.db
      .query("billingPayments")
      .withIndex("by_org_created", (q) => q.eq("organizationId", orgId))
      .order("desc")
      .take(10);
    const days = trialDays();
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
        planKey: ent.planKey,
        period: sub?.period ?? null,
        source: ent.source,
        status: ent.subscriptionStatus,
        isFreeTrial: ent.isFreeTrial,
        trialEndsAt: ent.trialEndsAt,
        currentPeriodEnd: ent.currentPeriodEnd,
        accessEndsAt: ent.accessEndsAt,
      },
      trial: { available: days !== null && sub === null, days },
      payments: {
        mode: paymentMode(),
        simulationAllowed: paymentMode() === "dry-run" && process.env.ALLOW_BILLING_SIMULATION === "true",
      },
      recentPayments: payments.map((p) => ({
        _id: p._id,
        planKey: p.planKey,
        period: p.period,
        amountKes: p.amountKes,
        status: p.status,
        mpesaReceipt: p.mpesaReceipt ?? null,
        phoneLast4: p.phoneLast4,
        createdAt: p.createdAt,
        resolvedAt: p.resolvedAt ?? null,
      })),
    };
  },
});

/** Live status of one payment (the waiting screen subscribes to this). Same organization only. */
export const paymentStatus = orgQuery({
  args: { paymentId: v.id("billingPayments") },
  handler: async (ctx, { paymentId }) => {
    ctx.require("billing:manage");
    const p = await ctx.db.get(paymentId);
    if (!p || p.organizationId !== ctx.oc.org._id) throw appError("NOT_FOUND");
    return {
      _id: p._id,
      status: p.status,
      failureReason: p.failureReason ?? null,
      planKey: p.planKey,
      period: p.period,
      amountKes: p.amountKes,
      mpesaReceipt: p.mpesaReceipt ?? null,
      phoneLast4: p.phoneLast4,
      createdAt: p.createdAt,
      resolvedAt: p.resolvedAt ?? null,
      mode: p.provider,
    };
  },
});

/**
 * Start an M-Pesa payment: sends an STK push to `phone` and returns the
 * payment id to watch with `paymentStatus`. An action (not a mutation) so the
 * phone number is never written to the database or the scheduler: only its
 * last four digits and a keyed hash are stored. The caller's identity comes
 * from the verified session; permission and limits are checked in
 * `billingPayhero.createPending`.
 */
export const startCheckout = action({
  args: { organizationId: v.id("organizations"), planKey: vPlanKey, period: vBillingPeriod, phone: v.string() },
  handler: async (ctx, args): Promise<{ paymentId: Id<"billingPayments">; status: "pending" | "failed" }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw appError("UNAUTHENTICATED");
    return await ctx.runAction(internal.billingPayhero.initiate, { ...args, tokenIdentifier: identity.tokenIdentifier });
  },
});

/** Stop waiting for a payment (the STK prompt was dismissed, wrong number, ...). A late success is still honoured. */
export const cancelPayment = orgMutation({
  args: { paymentId: v.id("billingPayments") },
  handler: async (ctx, { paymentId }) => {
    ctx.require("billing:manage");
    const p = await ctx.db.get(paymentId);
    if (!p || p.organizationId !== ctx.oc.org._id) throw appError("NOT_FOUND");
    if (p.status !== "pending") return;
    await ctx.db.patch(paymentId, { status: "cancelled", failureReason: "cancelled", resolvedAt: Date.now() });
  },
});

/**
 * Start the free Business trial: no payment, once per organization, only when
 * a trial length is configured (BUSINESS_TRIAL_DAYS). Ends automatically.
 */
export const startTrial = orgMutation({
  args: {},
  handler: async (ctx) => {
    ctx.require("billing:manage");
    const orgId = ctx.oc.org._id;
    const days = trialDays();
    if (days === null) throw appError("VALIDATION", "There is no free trial at the moment.");
    const existing = await ctx.db
      .query("subscriptions")
      .withIndex("by_org", (q) => q.eq("organizationId", orgId))
      .unique();
    if (existing) throw appError("CONFLICT", "This organization has already had a plan or trial.");
    const now = Date.now();
    const end = now + days * DAY_MS;
    await ctx.db.insert("subscriptions", {
      organizationId: orgId,
      planKey: "business",
      period: "monthly",
      status: "trialing",
      currentPeriodStart: now,
      currentPeriodEnd: end,
      trialEndsAt: end,
      source: "trial",
      createdAt: now,
      updatedAt: now,
    });
    await writeAudit(ctx, {
      organizationId: orgId,
      actorUserId: ctx.oc.user._id,
      action: "billing.trial_started",
      resourceType: "subscription",
      resourceId: orgId,
      metadata: { days },
    });
  },
});

/**
 * Dry-run only: settle a pending dry-run payment as paid or failed. Needs
 * PAYHERO_MODE unset/"dry-run" AND ALLOW_BILLING_SIMULATION=true (a
 * development convenience that must never be set in production).
 */
export const simulatePayment = orgMutation({
  args: { paymentId: v.id("billingPayments"), outcome: v.union(v.literal("success"), v.literal("failure")) },
  handler: async (ctx, { paymentId, outcome }) => {
    ctx.require("billing:manage");
    if (process.env.ALLOW_BILLING_SIMULATION !== "true") throw appError("FORBIDDEN", "Simulation is switched off.");
    const p = await ctx.db.get(paymentId);
    if (!p || p.organizationId !== ctx.oc.org._id) throw appError("NOT_FOUND");
    await simulateOutcome(ctx, paymentId, outcome);
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
        const sub = await ctx.db
          .query("subscriptions")
          .withIndex("by_org", (q) => q.eq("organizationId", o._id))
          .unique();
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
          subscriptionSource: sub?.source ?? null,
          subscriptionEnd: sub?.currentPeriodEnd ?? null,
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

