import { v } from "convex/values";
import { ChannelError, getChannel } from "../lib/notifications/channels";
import { RECEIPT_STATUSES } from "../lib/notifications/webhook";
import { renderTemplate, sensitivePlaceholders, TEMPLATES, isEventType } from "../lib/notifications/templates";
import { internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";
import { backoffFor, getSettings, MAX_ATTEMPTS } from "./lib/notify";

/** A claimed row is not picked up again for this long (guards against double sends). */
const CLAIM_LOCK_MS = 2 * 60 * 1000;

/**
 * Take a queued message for sending: bump attempts, set a short lock and
 * return the rendered content. Null when there is nothing to do (already
 * sent, claimed by another run, organization suspended).
 */
export const claim = internalMutation({
  args: { outboxId: v.id("notificationOutbox") },
  handler: async (ctx, { outboxId }) => {
    const row = await ctx.db.get(outboxId);
    if (!row || row.status !== "queued" || !row.to || !isEventType(row.eventType)) return null;
    const now = Date.now();
    if (row.claimedAt && now - row.claimedAt < CLAIM_LOCK_MS) return null;
    const org = await ctx.db.get(row.organizationId);
    if (!org || org.status === "suspended") {
      await ctx.db.patch(outboxId, { status: "skipped", lastError: "organization_unavailable" });
      return null;
    }
    const settings = await getSettings(ctx, row.organizationId);
    const rendered = renderTemplate(row.eventType, row.payload, {
      override: settings?.templateOverrides[row.eventType],
    });
    await ctx.db.patch(outboxId, { attempts: row.attempts + 1, claimedAt: now });
    return {
      channel: row.channel,
      to: row.to,
      eventType: row.eventType,
      payload: row.payload,
      subject: rendered.subject,
      body: rendered.body,
      senderName: settings?.senderName ?? org.name,
    };
  },
});

/** Record the outcome of one attempt; schedule a retry with backoff or mark failed. */
export const complete = internalMutation({
  args: {
    outboxId: v.id("notificationOutbox"),
    ok: v.boolean(),
    providerMessageId: v.optional(v.string()),
    mode: v.optional(v.union(v.literal("dry_run"), v.literal("live"))),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { outboxId, ok, providerMessageId, mode, error }) => {
    const row = await ctx.db.get(outboxId);
    if (!row || row.status !== "queued") return;
    const now = Date.now();
    const settle = (): Record<string, string> => {
      // Secrets in the payload (links) are not kept once the message is settled.
      const redacted = { ...row.payload };
      if (isEventType(row.eventType)) {
        for (const k of sensitivePlaceholders(row.eventType)) if (k in redacted) redacted[k] = "[redacted]";
      }
      return redacted;
    };
    if (ok) {
      await ctx.db.patch(outboxId, {
        status: "sent",
        providerMessageId,
        mode,
        sentAt: now,
        lastError: undefined,
        claimedAt: undefined,
        nextAttemptAt: undefined,
        payload: settle(),
      });
      return;
    }
    const lastError = (error ?? "send_failed").slice(0, 200);
    if (row.attempts >= MAX_ATTEMPTS) {
      await ctx.db.patch(outboxId, {
        status: "failed",
        lastError,
        mode,
        claimedAt: undefined,
        nextAttemptAt: undefined,
        payload: settle(),
      });
      return;
    }
    const delay = backoffFor(row.attempts);
    await ctx.db.patch(outboxId, { lastError, mode, claimedAt: undefined, nextAttemptAt: now + delay });
    await ctx.scheduler.runAfter(delay, internal.notificationsDelivery.deliver, { outboxId });
  },
});

/**
 * Send one outbox message through the channel adapter chosen by env config
 * (dry-run unless a provider is fully configured). Errors never carry
 * provider response bodies or credentials.
 */
export const deliver = internalAction({
  args: { outboxId: v.id("notificationOutbox") },
  handler: async (ctx, { outboxId }) => {
    const job = await ctx.runMutation(internal.notificationsDelivery.claim, { outboxId });
    if (!job) return;
    const channel = getChannel(job.channel, process.env, {
      placeholderOrder: (key) => TEMPLATES[key].placeholders,
    });
    try {
      const result = await channel.send({
        to: job.to,
        template: { key: job.eventType, subject: job.subject, body: job.body },
        data: job.payload,
        senderName: job.senderName,
      });
      await ctx.runMutation(internal.notificationsDelivery.complete, {
        outboxId,
        ok: true,
        providerMessageId: result.providerMessageId,
        mode: channel.mode,
      });
    } catch (e) {
      await ctx.runMutation(internal.notificationsDelivery.complete, {
        outboxId,
        ok: false,
        mode: channel.mode,
        error: e instanceof ChannelError ? e.message : "network_error",
      });
    }
  },
});

const RANK = { sent: 0, delivered: 1, read: 2 } as const;

/**
 * Apply a provider delivery receipt (from the webhook). Unknown ids are
 * ignored. Receipts only move forward (sent, delivered, read) so a replayed or
 * out-of-order receipt is harmless; `failed` marks the message failed.
 */
export const applyReceipt = internalMutation({
  args: {
    providerMessageId: v.string(),
    status: v.union(...RECEIPT_STATUSES.map((s) => v.literal(s))),
  },
  handler: async (ctx, { providerMessageId, status }) => {
    const rows = await ctx.db
      .query("notificationOutbox")
      .withIndex("by_provider_message", (q) => q.eq("providerMessageId", providerMessageId))
      .take(2);
    // Provider ids are unique per provider; an ambiguous match is ignored rather than guessed.
    if (rows.length !== 1) return;
    const row = rows[0]!;
    if (status === "failed") {
      if (row.deliveryStatus === "delivered" || row.deliveryStatus === "read") return;
      await ctx.db.patch(row._id, { deliveryStatus: "failed", status: "failed", lastError: "delivery_failed" });
      return;
    }
    const current = row.deliveryStatus && row.deliveryStatus !== "failed" ? RANK[row.deliveryStatus] : -1;
    if (RANK[status] > current) await ctx.db.patch(row._id, { deliveryStatus: status });
  },
});
