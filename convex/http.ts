import { httpRouter } from "convex/server";
import { verifySvix } from "../lib/billing/svix";
import { RECEIPT_STATUSES, verifyWebhook, type ReceiptStatus } from "../lib/notifications/webhook";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { logEvent } from "./lib/log";

const http = httpRouter();

const MAX_BODY_BYTES = 4096;

function reply(status: number, body: Record<string, unknown> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * Provider delivery receipts. Signed with a shared secret (env
 * `NOTIFY_WEBHOOK_SECRET`): `x-wageni-timestamp` + `x-wageni-signature`, see
 * lib/notifications/webhook.ts. Every failure is the same generic 4xx, and a
 * success reveals nothing about whether the message id matched, so the
 * endpoint cannot be used to probe tenants or message ids. With no secret
 * configured the route does not exist (404).
 */
http.route({
  path: "/webhooks/notifications",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.NOTIFY_WEBHOOK_SECRET;
    if (!secret) return reply(404);
    const body = await request.text();
    if (body.length > MAX_BODY_BYTES) return reply(400, { error: "invalid_request" });
    const valid = await verifyWebhook({
      secret,
      timestamp: request.headers.get("x-wageni-timestamp"),
      signature: request.headers.get("x-wageni-signature"),
      body,
    });
    if (!valid) {
      logEvent("warn", { event: "webhook_rejected", fn: "http.notifications", outcome: "rejected", code: "401" });
      return reply(401, { error: "invalid_request" });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return reply(400, { error: "invalid_request" });
    }
    const { providerMessageId, status } = (parsed ?? {}) as { providerMessageId?: unknown; status?: unknown };
    if (
      typeof providerMessageId !== "string" ||
      providerMessageId.length === 0 ||
      providerMessageId.length > 200 ||
      !(RECEIPT_STATUSES as readonly unknown[]).includes(status)
    ) {
      return reply(400, { error: "invalid_request" });
    }
    await ctx.runMutation(internal.notificationsDelivery.applyReceipt, {
      providerMessageId,
      status: status as ReceiptStatus,
    });
    return reply(200, { ok: true });
  }),
});

// --- B1: Clerk Billing webhooks (Svix-signed). Env `CLERK_WEBHOOK_SECRET` (whsec_...).
// Unset = the route does not exist (404). Every rejection is the same generic 4xx.
const MAX_BILLING_BODY_BYTES = 256 * 1024;

http.route({
  path: "/webhooks/clerk-billing",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.CLERK_WEBHOOK_SECRET;
    if (!secret) return reply(404);
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_BILLING_BODY_BYTES) return reply(400, { error: "invalid_request" });
    const body = await request.text();
    if (body.length > MAX_BILLING_BODY_BYTES) return reply(400, { error: "invalid_request" });
    const id = request.headers.get("svix-id");
    const valid = await verifySvix({
      secret,
      id,
      timestamp: request.headers.get("svix-timestamp"),
      signature: request.headers.get("svix-signature"),
      body,
    });
    if (!valid || !id) return reply(401, { error: "invalid_request" });
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return reply(400, { error: "invalid_request" });
    }
    await ctx.runMutation(internal.billingWebhook.applyEvent, { eventId: id, payload });
    return reply(200, { ok: true });
  }),
});
// --- end B1

export default http;
