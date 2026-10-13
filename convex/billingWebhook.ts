import { v } from "convex/values";
import { parseBillingEvent } from "../lib/billing/events";
import { internalMutation } from "./_generated/server";

/** Delivery ids are remembered this long (Svix retries for days; the 5 minute replay window is far shorter). */
export const PROCESSED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Apply one verified Clerk Billing webhook delivery. The HTTP route has already
 * checked the Svix signature and replay window. Everything here runs in one
 * transaction: a failure rolls back the idempotency record too, so Svix's
 * retry is processed normally.
 *
 * Returns "duplicate" when the delivery id was already processed, "ignored"
 * for events that do not change entitlements, else "applied". Never logs the
 * payload (it contains the payer's name and email).
 */
export const applyEvent = internalMutation({
  args: { eventId: v.string(), payload: v.any() },
  handler: async (ctx, { eventId, payload }): Promise<"applied" | "ignored" | "duplicate"> => {
    const seen = await ctx.db
      .query("processedWebhooks")
      .withIndex("by_event", (q) => q.eq("eventId", eventId))
      .first();
    if (seen) return "duplicate";
    const now = Date.now();
    await ctx.db.insert("processedWebhooks", { eventId, processedAt: now });

    const ev = parseBillingEvent(payload, now);
    if (!ev) return "ignored";

    const existing = await ctx.db
      .query("subscriptions")
      .withIndex("by_item", (q) => q.eq("clerkItemId", ev.clerkItemId))
      .unique();

    if (existing) {
      // Out-of-order delivery: never let an older event overwrite a newer one.
      if (ev.eventAt < existing.lastEventAt) return "ignored";
      if (ev.status === null) {
        // The item went back to a non-entitled state (e.g. abandoned): treat as ended.
        await ctx.db.patch(existing._id, { status: "ended", lastEventId: eventId, lastEventAt: ev.eventAt, updatedAt: now });
        return "applied";
      }
      await ctx.db.patch(existing._id, {
        clerkUserId: ev.clerkUserId,
        planSlug: ev.planSlug || existing.planSlug,
        featureSlugs: ev.featureSlugs.length > 0 ? ev.featureSlugs : existing.featureSlugs,
        status: ev.status,
        isFreeTrial: ev.isFreeTrial,
        trialEndsAt: ev.isFreeTrial ? ev.currentPeriodEnd : undefined,
        currentPeriodEnd: ev.currentPeriodEnd ?? existing.currentPeriodEnd,
        pastDueAt: ev.status === "past_due" ? (ev.pastDueAt ?? existing.pastDueAt ?? now) : undefined,
        canceledAt: ev.canceledAt ?? existing.canceledAt,
        lastEventId: eventId,
        lastEventAt: ev.eventAt,
        updatedAt: now,
      });
      return "applied";
    }

    if (ev.status === null) return "ignored";
    await ctx.db.insert("subscriptions", {
      clerkUserId: ev.clerkUserId,
      clerkItemId: ev.clerkItemId,
      planSlug: ev.planSlug,
      featureSlugs: ev.featureSlugs.length > 0 ? ev.featureSlugs : undefined,
      status: ev.status,
      isFreeTrial: ev.isFreeTrial,
      trialEndsAt: ev.isFreeTrial ? ev.currentPeriodEnd : undefined,
      currentPeriodEnd: ev.currentPeriodEnd,
      pastDueAt: ev.status === "past_due" ? (ev.pastDueAt ?? now) : undefined,
      canceledAt: ev.canceledAt,
      lastEventId: eventId,
      lastEventAt: ev.eventAt,
      updatedAt: now,
    });
    return "applied";
  },
});

/** Cron: forget delivery ids older than the TTL (bounded batch per run). */
export const sweepProcessed = internalMutation({
  args: {},
  handler: async (ctx) => {
    const old = await ctx.db
      .query("processedWebhooks")
      .withIndex("by_processed", (q) => q.lt("processedAt", Date.now() - PROCESSED_TTL_MS))
      .take(500);
    for (const row of old) await ctx.db.delete(row._id);
    return old.length;
  },
});
