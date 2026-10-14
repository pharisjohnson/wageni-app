import { v } from "convex/values";
import { effectivePermissions } from "../lib/permissions";
import { TIER_LABELS, type PaidPlanKey } from "../lib/billing/entitlements";
import { createDryRunProvider, createPayheroProvider, parseCallbackHint } from "../lib/billing/payhero";
import { formatKes, priceFor } from "../lib/billing/pricing";
import {
  evaluateVerification,
  hmacHex,
  mpesaCodeAsReference,
  PAYMENT_LIMITS,
  randomToken,
  sha256Hex,
  type PaymentProvider,
  type VerifyResult,
} from "../lib/billing/provider";
import { normalizeKenyanMobile } from "../lib/billing/phone";
import { extendSubscription, isBlockedDowngrade } from "../lib/billing/subscription";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type ActionCtx, type MutationCtx } from "./_generated/server";
import { writeAudit } from "./lib/audit";
import { formatDate, notifyBillingManagers } from "./lib/billingNotify";
import { billingEnforced } from "./lib/entitlements";
import { appError } from "./lib/errors";
import { vBillingPeriod, vPlanKey } from "./validators";

/**
 * PayHero M-Pesa billing: the payment state machine.
 *
 * Trust model. PayHero's callback carries no signature, so it is only a
 * HINT that something happened. The callback URL contains a random per-payment
 * token (stored hashed); on receipt we look the payment up by that token, ask
 * PayHero's transaction-status API server to server, and credit only when that
 * API says SUCCESS for the reference we stored. The plan and amount always
 * come from OUR row, never from the callback. A reconciliation cron resolves
 * payments whose callback never arrived.
 */

export type PaymentMode = "dry-run" | "live";

export function paymentMode(): PaymentMode {
  return process.env.PAYHERO_MODE === "live" ? "live" : "dry-run";
}

type ProviderConfig = { provider: PaymentProvider; callbackBase: string | null };

const NOT_CONFIGURED = "Payments are not set up yet. Please contact support.";

/** The provider for NEW payments. Live mode needs its env vars, else checkout is refused. */
export function providerConfig(): ProviderConfig {
  if (paymentMode() === "dry-run") {
    // Dry-run never charges anyone, so with enforcement on it would only ever
    // leave paying customers waiting. A production deployment that forgot
    // PAYHERO_MODE must fail loudly instead of looking like it works.
    if (billingEnforced() && process.env.ALLOW_DRY_RUN_BILLING !== "true") throw appError("VALIDATION", NOT_CONFIGURED);
    return { provider: createDryRunProvider(), callbackBase: null };
  }
  if (!strongPepper()) throw appError("VALIDATION", NOT_CONFIGURED);
  const authToken = process.env.PAYHERO_AUTH_TOKEN;
  const channelId = Number(process.env.PAYHERO_CHANNEL_ID);
  const base = process.env.PAYHERO_CALLBACK_BASE?.trim().replace(/\/+$/, "");
  if (!authToken || !Number.isInteger(channelId) || channelId <= 0 || !base || !/^https:\/\//.test(base)) {
    throw appError("VALIDATION", NOT_CONFIGURED);
  }
  return { provider: createPayheroProvider({ authToken, channelId }), callbackBase: base };
}

/** The provider that must answer for an EXISTING payment (by the provider it was created with). */
function providerFor(name: "payhero" | "dry-run"): PaymentProvider | null {
  if (name === "dry-run") return createDryRunProvider();
  const authToken = process.env.PAYHERO_AUTH_TOKEN;
  return authToken ? createPayheroProvider({ authToken, channelId: Number(process.env.PAYHERO_CHANNEL_ID) || 0 }) : null;
}

/**
 * Secret key for the phone-number hashes. Kenyan mobile numbers are a small
 * space, so an unkeyed or guessable-key hash could be reversed by enumeration:
 * live mode therefore REQUIRES a long random BILLING_HASH_PEPPER (no fallback
 * to anything else). Dry-run uses a fixed development key.
 */
function strongPepper(): string | null {
  const p = process.env.BILLING_HASH_PEPPER?.trim();
  return p && p.length >= 16 ? p : null;
}

function pepper(): string {
  return strongPepper() ?? (paymentMode() === "live" ? "" : "wageni-dev-pepper");
}

/** Unsafe or incomplete billing configuration, for the platform page (no secrets, only names). */
export function billingHealth(): { mode: PaymentMode; enforcement: boolean; warnings: string[] } {
  const mode = paymentMode();
  const enforcement = billingEnforced();
  const warnings: string[] = [];
  if (enforcement && mode === "dry-run") {
    warnings.push(
      process.env.ALLOW_DRY_RUN_BILLING === "true"
        ? "Plan enforcement is ON but PAYHERO_MODE is not live and ALLOW_DRY_RUN_BILLING=true: payments are recorded but never charged. Remove ALLOW_DRY_RUN_BILLING and set PAYHERO_MODE=live."
        : "Plan enforcement is ON but PAYHERO_MODE is not live: customers cannot pay and checkout is refused. Set PAYHERO_MODE=live and the PayHero variables.",
    );
  }
  if (process.env.ALLOW_BILLING_SIMULATION === "true") {
    warnings.push("ALLOW_BILLING_SIMULATION=true: remove it on any deployment with real customers.");
  }
  if (mode === "live") {
    if (!strongPepper()) warnings.push("BILLING_HASH_PEPPER is missing or shorter than 16 characters: live checkout is refused.");
    if (!process.env.PAYHERO_AUTH_TOKEN || !process.env.PAYHERO_CHANNEL_ID || !process.env.PAYHERO_CALLBACK_BASE) {
      warnings.push("PAYHERO_AUTH_TOKEN, PAYHERO_CHANNEL_ID or PAYHERO_CALLBACK_BASE is missing: live checkout is refused.");
    }
    if (!enforcement) warnings.push("PAYHERO_MODE is live but BILLING_ENFORCEMENT is not on: payments work but plans are not enforced.");
  }
  return { mode, enforcement, warnings };
}

const HOUR = 60 * 60 * 1000;
const FAILED = ["failed", "timed_out", "cancelled"] as const;
const isFailure = (s: string) => (FAILED as readonly string[]).includes(s);

// ---------------------------------------------------------------------------
// Starting a payment
// ---------------------------------------------------------------------------

/**
 * Orchestrates one STK push. Called by the public `billing.startCheckout`
 * action, which passes the caller's verified token identifier (never a client
 * supplied id). The phone number exists only in this action's memory: the
 * database gets its last four digits and a keyed hash.
 */
export const initiate = internalAction({
  args: {
    tokenIdentifier: v.string(),
    organizationId: v.id("organizations"),
    planKey: vPlanKey,
    period: vBillingPeriod,
    phone: v.string(),
  },
  handler: async (ctx, a): Promise<{ paymentId: Id<"billingPayments">; status: "pending" | "failed" }> => {
    const phone = normalizeKenyanMobile(a.phone);
    if (!phone) throw appError("VALIDATION", "Enter a valid Safaricom M-Pesa number, for example 0712 345 678.");
    const { provider, callbackBase } = providerConfig();
    const token = randomToken();
    const created: { paymentId: Id<"billingPayments">; amountKes: number; externalReference: string } = await ctx.runMutation(
      internal.billingPayhero.createPending,
      {
        tokenIdentifier: a.tokenIdentifier,
        organizationId: a.organizationId,
        planKey: a.planKey,
        period: a.period,
        phoneHash: await hmacHex(pepper(), phone.e164),
        phoneLast4: phone.e164.slice(-4),
        callbackTokenHash: await sha256Hex(token),
        provider: provider.name,
      },
    );
    const result = await provider.initiate({
      amountKes: created.amountKes,
      phoneLocal: phone.local,
      externalReference: created.externalReference,
      callbackUrl: `${callbackBase ?? "https://dry-run.invalid"}/webhooks/payhero/${token}`,
    });
    if (!result.ok) {
      await ctx.runMutation(internal.billingPayhero.markFailed, { paymentId: created.paymentId, reason: result.reason });
      return { paymentId: created.paymentId, status: "failed" };
    }
    await ctx.runMutation(internal.billingPayhero.markInitiated, {
      paymentId: created.paymentId,
      reference: result.reference,
      checkoutRequestId: result.checkoutRequestId,
    });
    return { paymentId: created.paymentId, status: "pending" };
  },
});

/** Validate permission and limits, then record a pending payment. No phone number is seen here. */
export const createPending = internalMutation({
  args: {
    tokenIdentifier: v.string(),
    organizationId: v.id("organizations"),
    planKey: vPlanKey,
    period: vBillingPeriod,
    phoneHash: v.string(),
    phoneLast4: v.string(),
    callbackTokenHash: v.string(),
    provider: v.union(v.literal("payhero"), v.literal("dry-run")),
  },
  handler: async (ctx, a) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", a.tokenIdentifier))
      .unique();
    if (!user) throw appError("UNAUTHENTICATED");
    const org = await ctx.db.get(a.organizationId);
    const membership = org
      ? await ctx.db
          .query("memberships")
          .withIndex("by_org_user", (q) => q.eq("organizationId", a.organizationId).eq("userId", user._id))
          .unique()
      : null;
    if (!org || !membership || membership.status !== "active") throw appError("NOT_FOUND");
    if (org.status === "suspended") throw appError("FORBIDDEN", "This organization is suspended.");
    if (!effectivePermissions(membership.role, membership.permissionOverrides).has("billing:manage")) throw appError("FORBIDDEN");

    const amountKes = priceFor(a.planKey as PaidPlanKey, a.period);
    if (amountKes === null) {
      throw appError("VALIDATION", "Online payment is not available for this plan yet: the KES price has not been announced.");
    }

    const now = Date.now();
    const sub = await ctx.db
      .query("subscriptions")
      .withIndex("by_org", (q) => q.eq("organizationId", a.organizationId))
      .unique();
    if (sub && isBlockedDowngrade(sub, a.planKey, now)) {
      throw appError(
        "CONFLICT",
        `Your ${TIER_LABELS[sub.planKey]} plan is paid until ${formatDate(sub.currentPeriodEnd)}. You can switch to ${TIER_LABELS[a.planKey]} after it ends.`,
      );
    }

    // ---- Retry and abuse limits (PayHero blocks numbers and accounts after repeated failures) ----
    const L = PAYMENT_LIMITS;
    const recent = await ctx.db
      .query("billingPayments")
      .withIndex("by_org_created", (q) => q.eq("organizationId", a.organizationId).gte("createdAt", now - HOUR))
      .order("desc")
      .take(L.perOrgPerHour + 4);
    const live = recent.find((p) => p.status === "pending" && now - p.createdAt < L.pendingTtlMs);
    if (live) throw appError("CONFLICT", "A payment is already waiting for your M-Pesa PIN. Finish it or cancel it first.");
    if (recent[0] && now - recent[0].createdAt < L.cooldownMs) {
      throw appError("RATE_LIMITED", "Please wait about 30 seconds before trying again.");
    }
    if (recent.length >= L.perOrgPerHour) {
      throw appError("RATE_LIMITED", "Too many payment attempts this hour. Please try again later.");
    }
    const byPhone = await ctx.db
      .query("billingPayments")
      .withIndex("by_phone_created", (q) => q.eq("phoneHash", a.phoneHash).gte("createdAt", now - 24 * HOUR))
      .order("desc")
      .take(60);
    if (byPhone.filter((p) => now - p.createdAt < HOUR).length >= L.perPhonePerHour) {
      throw appError("RATE_LIMITED", "Too many attempts with this phone number. Please try again in an hour.");
    }
    let streak = 0;
    for (const p of byPhone) {
      if (p.status === "success") break;
      if (isFailure(p.status)) streak++;
    }
    if (streak >= L.maxConsecutiveFailuresPerPhone) {
      throw appError("RATE_LIMITED", "This phone number has had several unfinished payments. Please try again tomorrow or use another number.");
    }
    // Account-wide circuit breaker. Each organization counts for at most a few
    // failures (so one tenant cannot pause everyone), and a customer that has
    // already paid us (an active payment-sourced subscription) is never paused.
    const perOrg = new Map<string, number>();
    for (const s of FAILED) {
      const rows = await ctx.db
        .query("billingPayments")
        .withIndex("by_status_created", (q) => q.eq("status", s).gte("createdAt", now - 6 * HOUR))
        .take(300);
      for (const r of rows) perOrg.set(r.organizationId, (perOrg.get(r.organizationId) ?? 0) + 1);
    }
    let globalFailures = 0;
    for (const n of perOrg.values()) globalFailures += Math.min(n, L.globalFailuresPerOrgCap);
    const isPayingCustomer = sub?.source === "payment";
    if (globalFailures >= L.globalFailuresPer6h && !isPayingCustomer) {
      throw appError("RATE_LIMITED", "Payments are temporarily paused. Please try again in a few hours.");
    }

    const externalReference = `WG${randomToken(9)}`.replace(/[-_]/g, "x");
    const paymentId = await ctx.db.insert("billingPayments", {
      organizationId: a.organizationId,
      planKey: a.planKey,
      period: a.period,
      amountKes,
      provider: a.provider,
      phoneLast4: a.phoneLast4,
      phoneHash: a.phoneHash,
      externalReference,
      callbackTokenHash: a.callbackTokenHash,
      status: "pending",
      createdBy: user._id,
      createdAt: now,
    });
    return { paymentId, amountKes, externalReference };
  },
});

export const markInitiated = internalMutation({
  args: { paymentId: v.id("billingPayments"), reference: v.string(), checkoutRequestId: v.optional(v.string()) },
  handler: async (ctx, { paymentId, reference, checkoutRequestId }) => {
    const p = await ctx.db.get(paymentId);
    // Kept even when the payer already cancelled: a late success must stay verifiable.
    if (!p || p.status === "success" || p.payheroReference) return;
    // One PayHero reference belongs to exactly one payment. A reused reference
    // (a provider bug, or something stranger) must never be able to credit twice.
    const clash = await ctx.db
      .query("billingPayments")
      .withIndex("by_reference", (q) => q.eq("payheroReference", reference))
      .first();
    if (clash && clash._id !== paymentId) {
      if (p.status === "pending") {
        await ctx.db.patch(paymentId, { status: "failed", failureReason: "reference_reused", resolvedAt: Date.now() });
      }
      return;
    }
    await ctx.db.patch(paymentId, { payheroReference: reference, checkoutRequestId });
  },
});

export const markFailed = internalMutation({
  args: { paymentId: v.id("billingPayments"), reason: v.string() },
  handler: async (ctx, { paymentId, reason }) => {
    const p = await ctx.db.get(paymentId);
    if (!p || p.status !== "pending") return;
    await ctx.db.patch(paymentId, { status: "failed", failureReason: reason, resolvedAt: Date.now() });
  },
});

// ---------------------------------------------------------------------------
// Verification (the only road to "success")
// ---------------------------------------------------------------------------

/** Mark a verification attempt (and throttle callback floods). Null = nothing to check. */
export const claimCheck = internalMutation({
  args: { paymentId: v.id("billingPayments") },
  handler: async (ctx, { paymentId }) => {
    const p = await ctx.db.get(paymentId);
    if (!p || p.status === "success" || p.status === "failed") return null;
    if (!p.payheroReference) return null;
    const now = Date.now();
    if (p.lastCheckedAt !== undefined && now - p.lastCheckedAt < PAYMENT_LIMITS.minCheckGapMs) return null;
    await ctx.db.patch(paymentId, { lastCheckedAt: now });
    return { reference: p.payheroReference, provider: p.provider };
  },
});

/**
 * Ask the provider what happened and apply it. Shared by the callback route
 * and the reconciliation cron. `receiptHint` (from the untrusted callback) is
 * only ever shown as the receipt number after the provider confirmed success.
 */
export async function verifyPayment(
  ctx: ActionCtx,
  paymentId: Id<"billingPayments">,
  receiptHint?: string,
): Promise<"applied" | "duplicate" | "pending" | "failed" | "mismatch" | "skipped"> {
  const claim = await ctx.runMutation(internal.billingPayhero.claimCheck, { paymentId });
  if (!claim) return "skipped";
  const provider = providerFor(claim.provider);
  if (!provider) return "skipped";
  const result = await provider.verify({ reference: claim.reference });
  return await ctx.runMutation(internal.billingPayhero.recordVerification, { paymentId, result, receiptHint });
}

export const verify = internalAction({
  args: { paymentId: v.id("billingPayments") },
  handler: async (ctx, { paymentId }) => await verifyPayment(ctx, paymentId),
});

const vVerifyResult = v.object({
  state: v.union(v.literal("success"), v.literal("failed"), v.literal("pending"), v.literal("unknown")),
  reference: v.optional(v.string()),
  checkoutRequestId: v.optional(v.string()),
  amountKes: v.optional(v.number()),
  receipt: v.optional(v.string()),
});

/** Apply a provider verification result to our stored payment. Idempotent. */
export const recordVerification = internalMutation({
  args: { paymentId: v.id("billingPayments"), result: vVerifyResult, receiptHint: v.optional(v.string()) },
  handler: async (ctx, { paymentId, result, receiptHint }): Promise<"applied" | "duplicate" | "pending" | "failed" | "mismatch"> => {
    const p = await ctx.db.get(paymentId);
    if (!p) return "pending";
    if (p.status === "success" || p.appliedAt !== undefined) return "duplicate";
    const decision = evaluateVerification(p, result as VerifyResult);
    if (decision === "credit") {
      // One real transaction can pay for one payment only: neither the PayHero
      // reference nor the M-Pesa receipt may already belong to another payment.
      const viaCode = mpesaCodeAsReference(p, result as VerifyResult);
      const providerReceipt = result.receipt ?? viaCode ?? undefined;
      const refOwners = p.payheroReference
        ? await ctx.db
            .query("billingPayments")
            .withIndex("by_reference", (q) => q.eq("payheroReference", p.payheroReference))
            .take(3)
        : [];
      const receiptTaken = async (code: string) =>
        (await ctx.db.query("billingPayments").withIndex("by_receipt", (q) => q.eq("mpesaReceipt", code)).take(2)).some(
          (r) => r._id !== p._id,
        );
      if (refOwners.some((r) => r._id !== p._id) || (providerReceipt && (await receiptTaken(providerReceipt)))) {
        return await markMismatch(ctx, p);
      }
      // The callback's receipt is only a display hint: drop it if someone else owns it.
      const hint = receiptHint && !providerReceipt && !(await receiptTaken(receiptHint)) ? receiptHint : undefined;
      await applySuccess(ctx, p, providerReceipt ?? hint);
      return "applied";
    }
    if (decision === "failed") {
      // Only an unresolved attempt can fail; a timed-out/cancelled one just stays that way.
      if (p.status === "pending") {
        await ctx.db.patch(paymentId, { status: "failed", failureReason: "not_completed", resolvedAt: Date.now() });
      }
      return "failed";
    }
    if (decision === "mismatch") return await markMismatch(ctx, p);
    return "pending";
  },
});

/** A success that does not match our record: never credited, closed and audited for the operator. */
async function markMismatch(ctx: MutationCtx, p: Doc<"billingPayments">): Promise<"mismatch"> {
  await ctx.db.patch(p._id, { status: "failed", failureReason: "verification_mismatch", resolvedAt: Date.now() });
  await writeAudit(ctx, {
    organizationId: p.organizationId,
    action: "billing.payment_mismatch",
    resourceType: "billingPayment",
    resourceId: p._id,
    metadata: { amountKes: p.amountKes },
  });
  return "mismatch";
}

/**
 * Credit a verified payment: create or extend the organization's
 * subscription, mark the payment, audit it and send the receipt. Called only
 * from verified paths (recordVerification, the dry-run simulator).
 */
export async function applySuccess(ctx: MutationCtx, p: Doc<"billingPayments">, receipt: string | undefined) {
  if (p.appliedAt !== undefined || p.status === "success") return;
  const now = Date.now();
  const sub = await ctx.db
    .query("subscriptions")
    .withIndex("by_org", (q) => q.eq("organizationId", p.organizationId))
    .unique();
  const ext = extendSubscription(sub, { planKey: p.planKey, period: p.period }, now);
  const fields = {
    planKey: ext.planKey,
    period: ext.period,
    status: "active" as const,
    currentPeriodStart: ext.currentPeriodStart,
    currentPeriodEnd: ext.currentPeriodEnd,
    lastPaymentId: p._id,
    source: "payment" as const,
    updatedAt: now,
  };
  if (sub) await ctx.db.patch(sub._id, fields);
  else await ctx.db.insert("subscriptions", { organizationId: p.organizationId, ...fields, createdAt: now });
  const code = receipt ?? p.payheroReference ?? "n/a";
  await ctx.db.patch(p._id, { status: "success", mpesaReceipt: receipt, resolvedAt: now, appliedAt: now, failureReason: undefined });
  await writeAudit(ctx, {
    organizationId: p.organizationId,
    action: "billing.payment_applied",
    resourceType: "billingPayment",
    resourceId: p._id,
    metadata: { planKey: ext.planKey, period: p.period, amountKes: p.amountKes, periodEnd: ext.currentPeriodEnd, receipt: code },
  });
  const org = await ctx.db.get(p.organizationId);
  await notifyBillingManagers(
    ctx,
    p.organizationId,
    "billing_payment_received",
    {
      orgName: org?.name ?? "your organization",
      planName: TIER_LABELS[ext.planKey],
      amount: formatKes(p.amountKes),
      receipt: code,
      endDate: formatDate(ext.currentPeriodEnd, org?.timeZone),
    },
    `billing_receipt:${p._id}`,
  );
}

// ---------------------------------------------------------------------------
// Callback and reconciliation
// ---------------------------------------------------------------------------

export const byTokenHash = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const p = await ctx.db
      .query("billingPayments")
      .withIndex("by_token_hash", (q) => q.eq("callbackTokenHash", tokenHash))
      .unique();
    return p ? { _id: p._id, externalReference: p.externalReference } : null;
  },
});

/**
 * Handle a PayHero callback. `hint` is the untrusted body, reduced to the two
 * fields we use. Nothing is credited from it: we verify with PayHero.
 */
export const handleCallback = internalAction({
  args: { tokenHash: v.string(), body: v.any() },
  handler: async (ctx, { tokenHash, body }): Promise<"unknown" | "ignored" | "checked"> => {
    const payment = await ctx.runQuery(internal.billingPayhero.byTokenHash, { tokenHash });
    if (!payment) return "unknown";
    const hint = parseCallbackHint(body);
    // A callback naming a different external reference is not about this payment.
    if (hint.externalReference && hint.externalReference !== payment.externalReference) return "ignored";
    await verifyPayment(ctx, payment._id, hint.receipt);
    return "checked";
  },
});

export const listForReconcile = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const L = PAYMENT_LIMITS;
    const pending = await ctx.db
      .query("billingPayments")
      .withIndex("by_status_created", (q) => q.eq("status", "pending").lt("createdAt", now - L.reconcileAfterMs))
      .take(50);
    const late: Doc<"billingPayments">[] = [];
    for (const s of ["timed_out", "cancelled"] as const) {
      const rows = await ctx.db
        .query("billingPayments")
        .withIndex("by_status_created", (q) => q.eq("status", s).gte("createdAt", now - L.lateSuccessWindowMs))
        .take(50);
      late.push(...rows.filter((r) => r.lastCheckedAt === undefined || now - r.lastCheckedAt > L.pendingTtlMs));
    }
    return [...pending, ...late.slice(0, 25)].map((p) => ({ _id: p._id, status: p.status, createdAt: p.createdAt }));
  },
});

/** Give up on a still-unanswered payment once it is older than the pending window. */
export const expirePending = internalMutation({
  args: { paymentId: v.id("billingPayments") },
  handler: async (ctx, { paymentId }) => {
    const p = await ctx.db.get(paymentId);
    if (!p || p.status !== "pending" || Date.now() - p.createdAt < PAYMENT_LIMITS.pendingTtlMs) return false;
    await ctx.db.patch(paymentId, { status: "timed_out", failureReason: "timed_out", resolvedAt: Date.now() });
    return true;
  },
});

/**
 * Cron: resolve payments whose callback was lost. Pending payments older than
 * ~30s are checked with PayHero; those still unanswered after ~10 minutes are
 * marked timed out (and a late success is still honoured for 24 hours).
 */
export const reconcile = internalAction({
  args: {},
  handler: async (ctx): Promise<{ checked: number; timedOut: number }> => {
    const rows = await ctx.runQuery(internal.billingPayhero.listForReconcile, {});
    let timedOut = 0;
    for (const r of rows) {
      await verifyPayment(ctx, r._id);
      if (r.status === "pending" && (await ctx.runMutation(internal.billingPayhero.expirePending, { paymentId: r._id }))) timedOut++;
    }
    return { checked: rows.length, timedOut };
  },
});

// ---------------------------------------------------------------------------
// Dry-run simulator (development only)
// ---------------------------------------------------------------------------

/**
 * Simulate the outcome of a dry-run payment. Refuses unless PAYHERO_MODE is
 * not "live" AND the payment was created by the dry-run provider, so it can
 * never credit a real payment. Used by `npx convex run` and, when
 * ALLOW_BILLING_SIMULATION=true, by the billing page's "simulate" buttons.
 */
export async function simulateOutcome(ctx: MutationCtx, paymentId: Id<"billingPayments">, outcome: "success" | "failure") {
  const p = await ctx.db.get(paymentId);
  if (!p || p.provider !== "dry-run" || paymentMode() !== "dry-run") throw appError("FORBIDDEN", "Simulation is only available in dry-run mode.");
  if (p.status !== "pending") throw appError("CONFLICT", "This payment is already settled.");
  if (outcome === "success") {
    await applySuccess(ctx, p, `SIM${p._id.slice(-7).toUpperCase().replace(/[^A-Z0-9]/g, "0")}`);
  } else {
    await ctx.db.patch(paymentId, { status: "failed", failureReason: "not_completed", resolvedAt: Date.now() });
  }
}

export const simulate = internalMutation({
  args: { paymentId: v.id("billingPayments"), outcome: v.union(v.literal("success"), v.literal("failure")) },
  handler: async (ctx, { paymentId, outcome }) => {
    await simulateOutcome(ctx, paymentId, outcome);
  },
});

