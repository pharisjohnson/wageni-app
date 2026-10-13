import { v } from "convex/values";
import { channelStatus } from "../lib/notifications/channels";
import { maskAddress, normalizeEmail, normalizePhone } from "../lib/notifications/address";
import {
  CHANNELS,
  isEventType,
  PREFERENCE_EVENTS,
  TEMPLATES,
  validateOverride,
  type EventType,
} from "../lib/notifications/templates";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import { hasSiteAccess } from "./lib/auth";
import { writeAudit } from "./lib/audit";
import { appError } from "./lib/errors";
import { orgMutation, orgQuery } from "./lib/functions";
import { DEFAULT_CHANNELS, enqueueNotification, getSettings } from "./lib/notify";
import { vChannel, vNotificationStatus } from "./validators";

const MAX_LIST = 200;
const STATS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TEST_SENDS_PER_HOUR = 5;

function firstName(name: string | undefined) {
  return name?.trim().split(/\s+/)[0] ?? "";
}

function whenText(at: number, timeZone: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(at));
}

// --- Trigger hooks (internal) -----------------------------------------------------
// Callers in shared code schedule these with
//   ctx.scheduler.runAfter(0, internal.notifications.onX, { ... })
// so a notification problem can never roll back or fail the business action.

/**
 * A visitor reached the host: on site (kiosk check-in, guard admit, walk-in
 * admitted at once) or registered and waiting to be admitted. Reads the
 * visit's current status to pick the message. Once per visit and kind.
 */
export const onVisitArrived = internalMutation({
  args: { visitId: v.id("visits") },
  handler: async (ctx, { visitId }) => {
    const visit = await ctx.db.get(visitId);
    if (!visit?.hostUserId) return;
    const arrived = visit.status === "on_site";
    if (!arrived && visit.status !== "expected") return;
    const [visitor, site] = await Promise.all([ctx.db.get(visit.visitorId), ctx.db.get(visit.siteId)]);
    if (!visitor || visitor.organizationId !== visit.organizationId) return;
    await enqueueNotification(ctx, {
      organizationId: visit.organizationId,
      siteId: visit.siteId,
      eventType: arrived ? "visitor_arrived" : "visitor_awaiting_admit",
      recipient: { kind: "user", userId: visit.hostUserId },
      data: { visitorName: visitor.name, siteName: site?.name ?? "" },
      key: `${arrived ? "visit_arrived" : "visit_awaiting"}:${visitId}`,
    });
  },
});

/**
 * Appointment lifecycle. `actorUserId` is the person who made the change, so
 * the host is not told about their own action. Requested: to the host when
 * someone else booked and approval is pending. Approved, declined, cancelled
 * and rescheduled: to the visitor (and, for cancel/reschedule, the host).
 */
export const onAppointmentEvent = internalMutation({
  args: {
    appointmentId: v.id("appointments"),
    event: v.union(
      v.literal("requested"),
      v.literal("approved"),
      v.literal("declined"),
      v.literal("cancelled"),
      v.literal("rescheduled"),
    ),
    actorUserId: v.optional(v.id("users")),
  },
  handler: async (ctx, { appointmentId, event, actorUserId }) => {
    const appt = await ctx.db.get(appointmentId);
    if (!appt) return;
    const [visitor, host, site, org] = await Promise.all([
      ctx.db.get(appt.visitorId),
      ctx.db.get(appt.hostUserId),
      ctx.db.get(appt.siteId),
      ctx.db.get(appt.organizationId),
    ]);
    if (!visitor || !org || visitor.organizationId !== appt.organizationId) return;
    const when = whenText(appt.scheduledStart, site?.timeZone ?? org.timeZone);
    const base = { organizationId: appt.organizationId, siteId: appt.siteId };
    const hostName = host?.name ?? "your host";
    const contact = { kind: "visitor", email: visitor.email, phone: visitor.phone } as const;
    const toVisitor = (eventType: EventType, key: string) =>
      enqueueNotification(ctx, {
        ...base,
        eventType,
        recipient: contact,
        data: { firstName: firstName(visitor.name), orgName: org.name, when, hostName },
        key,
      });
    const toHost = (eventType: EventType, key: string) =>
      enqueueNotification(ctx, {
        ...base,
        eventType,
        recipient: { kind: "user", userId: appt.hostUserId },
        data: { visitorName: visitor.name, when, siteName: site?.name ?? "" },
        key,
      });
    const hostWasActor = actorUserId === appt.hostUserId;

    if (event === "requested") {
      if (appt.status === "pending_approval" && appt.createdBy !== appt.hostUserId) {
        await toHost("appointment_requested", `appt_requested:${appointmentId}`);
      }
    } else if (event === "approved") {
      await toVisitor("appointment_approved", `appt_approved:${appointmentId}`);
    } else if (event === "declined") {
      await toVisitor("appointment_declined", `appt_declined:${appointmentId}`);
    } else if (event === "cancelled") {
      await toVisitor("appointment_cancelled", `appt_cancelled:${appointmentId}`);
      if (!hostWasActor) await toHost("appointment_cancelled_host", `appt_cancelled_host:${appointmentId}`);
    } else {
      const stamp = `${appointmentId}:${appt.scheduledStart}`;
      await toVisitor("appointment_rescheduled", `appt_rescheduled:${stamp}`);
      if (!hostWasActor) await toHost("appointment_rescheduled_host", `appt_rescheduled_host:${stamp}`);
    }
  },
});

/**
 * An invitation was created (called by the invitations module).
 *
 * Args:
 * - `organizationId`: the inviting organization (must exist; suspended ones are skipped).
 * - `invitee`: `{ name?, email?, phone? }`. Email goes by email, phone by SMS/WhatsApp,
 *   subject to the organization's enabled channels. Neither is stored beyond the outbox row.
 * - `link`: the full invitation URL. It is a secret: it is stored in the outbox only
 *   until the message is sent or failed, then replaced with "[redacted]".
 * - `idempotencyKey`: stable per invitation (e.g. `invite:<invitationId>`), so calling
 *   this twice, or re-sending, delivers once. Use a new key to deliberately resend.
 *
 * Call from a mutation with
 * `ctx.scheduler.runAfter(0, internal.notifications.onInvitationCreated, { ... })`.
 */
export const onInvitationCreated = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    siteId: v.optional(v.id("sites")),
    invitee: v.object({
      name: v.optional(v.string()),
      email: v.optional(v.string()),
      phone: v.optional(v.string()),
    }),
    link: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.organizationId);
    if (!org) return;
    await enqueueNotification(ctx, {
      organizationId: args.organizationId,
      siteId: args.siteId,
      eventType: "invitation_created",
      recipient: { kind: "visitor", email: args.invitee.email, phone: args.invitee.phone },
      data: { firstName: firstName(args.invitee.name), orgName: org.name, link: args.link },
      key: args.idempotencyKey,
    });
  },
});

// --- History, stats, retry ----------------------------------------------------------

export const listOutbox = orgQuery({
  args: {
    status: v.optional(vNotificationStatus),
    eventType: v.optional(v.string()),
    channel: v.optional(vChannel),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    ctx.require("messages:read");
    const orgId = ctx.oc.org._id;
    const { status } = args;
    const rows = status
      ? await ctx.db
          .query("notificationOutbox")
          .withIndex("by_org_status_created", (q) => q.eq("organizationId", orgId).eq("status", status))
          .order("desc")
          .take(MAX_LIST * 2)
      : await ctx.db
          .query("notificationOutbox")
          .withIndex("by_org_created", (q) => q.eq("organizationId", orgId))
          .order("desc")
          .take(MAX_LIST * 2);
    const visible = rows
      .filter(
        (r) =>
          (!r.siteId || hasSiteAccess(ctx.oc.membership, r.siteId)) &&
          (!args.eventType || r.eventType === args.eventType) &&
          (!args.channel || r.channel === args.channel),
      )
      .slice(0, Math.min(args.limit ?? 100, MAX_LIST));
    const names = new Map<Id<"users">, string>();
    for (const r of visible) {
      if (r.recipientUserId && !names.has(r.recipientUserId)) {
        const u = await ctx.db.get(r.recipientUserId);
        names.set(r.recipientUserId, u?.name ?? u?.email ?? "Staff member");
      }
    }
    // Addresses are masked and message bodies are not returned.
    return visible.map((r) => ({
      _id: r._id,
      createdAt: r.createdAt,
      sentAt: r.sentAt ?? null,
      channel: r.channel,
      eventType: r.eventType,
      label: isEventType(r.eventType) ? TEMPLATES[r.eventType].label : r.eventType,
      status: r.status,
      attempts: r.attempts,
      lastError: r.lastError ?? null,
      deliveryStatus: r.deliveryStatus ?? null,
      mode: r.mode ?? null,
      recipient: r.recipientUserId ? (names.get(r.recipientUserId) ?? "Staff member") : "Visitor",
      to: maskAddress(r.to),
    }));
  },
});

/** Counts per event type and status over the last 7 days. */
export const stats = orgQuery({
  args: {},
  handler: async (ctx) => {
    ctx.require("messages:read");
    const since = Date.now() - STATS_WINDOW_MS;
    const rows = await ctx.db
      .query("notificationOutbox")
      .withIndex("by_org_created", (q) => q.eq("organizationId", ctx.oc.org._id).gte("createdAt", since))
      .take(2000);
    const byEvent = new Map<string, { sent: number; failed: number; skipped: number; queued: number }>();
    for (const r of rows) {
      const c = byEvent.get(r.eventType) ?? { sent: 0, failed: 0, skipped: 0, queued: 0 };
      c[r.status] += 1;
      byEvent.set(r.eventType, c);
    }
    const total = { sent: 0, failed: 0, skipped: 0, queued: 0 };
    const events = [...byEvent].map(([eventType, c]) => {
      for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += c[k];
      return {
        eventType,
        label: isEventType(eventType) ? TEMPLATES[eventType].label : eventType,
        ...c,
      };
    });
    events.sort((a, b) => b.sent + b.failed + b.skipped + b.queued - (a.sent + a.failed + a.skipped + a.queued));
    return { days: 7, total, events, truncated: rows.length >= 2000 };
  },
});

/** Put a failed message back in the queue for a fresh round of attempts. */
export const retry = orgMutation({
  args: { outboxId: v.id("notificationOutbox") },
  handler: async (ctx, { outboxId }) => {
    ctx.require("integrations:manage");
    const row = await ctx.db.get(outboxId);
    if (!row || row.organizationId !== ctx.oc.org._id) throw appError("NOT_FOUND");
    if (row.status !== "failed") throw appError("CONFLICT", "Only failed messages can be retried.");
    if (!row.to) throw appError("CONFLICT", "This message can no longer be sent.");
    await ctx.db.patch(outboxId, {
      status: "queued",
      attempts: 0,
      lastError: undefined,
      deliveryStatus: undefined,
      claimedAt: undefined,
      nextAttemptAt: undefined,
    });
    await ctx.scheduler.runAfter(0, internal.notificationsDelivery.deliver, { outboxId });
    await writeAudit(ctx, {
      organizationId: ctx.oc.org._id,
      actorUserId: ctx.oc.user._id,
      action: "notification.retried",
      resourceType: "notification",
      resourceId: outboxId,
    });
  },
});

// --- Organization settings -----------------------------------------------------------

const vOverrides = v.record(v.string(), v.object({ subject: v.optional(v.string()), body: v.optional(v.string()) }));

export const getOrgSettings = orgQuery({
  args: {},
  handler: async (ctx) => {
    ctx.require("messages:read");
    const s = await getSettings(ctx, ctx.oc.org._id);
    return {
      enabledChannels: s?.enabledChannels ?? DEFAULT_CHANNELS,
      senderName: s?.senderName ?? "",
      templateOverrides: s?.templateOverrides ?? {},
      isDefault: !s,
      canEdit: ctx.oc.permissions.has("integrations:manage"),
    };
  },
});

export const updateOrgSettings = orgMutation({
  args: {
    enabledChannels: v.array(vChannel),
    senderName: v.optional(v.string()),
    templateOverrides: vOverrides,
  },
  handler: async (ctx, args) => {
    ctx.require("integrations:manage");
    const senderName = args.senderName?.trim() || undefined;
    if (senderName && (senderName.length > 40 || /[<>"\r\n]/.test(senderName))) {
      throw appError("VALIDATION", "Sender name must be at most 40 characters without quotes or angle brackets.");
    }
    const overrides: Record<string, { subject?: string; body?: string }> = {};
    for (const [event, o] of Object.entries(args.templateOverrides)) {
      if (!isEventType(event)) throw appError("VALIDATION", "Unknown message type.");
      const clean = { subject: o.subject?.trim() || undefined, body: o.body?.trim() || undefined };
      const problem = validateOverride(event, clean);
      if (problem) throw appError("VALIDATION", `${TEMPLATES[event].label}: ${problem}`);
      if (clean.subject || clean.body) overrides[event] = clean;
    }
    const value = {
      organizationId: ctx.oc.org._id,
      enabledChannels: CHANNELS.filter((c) => args.enabledChannels.includes(c)),
      senderName,
      templateOverrides: overrides,
      updatedBy: ctx.oc.user._id,
      updatedAt: Date.now(),
    };
    const existing = await getSettings(ctx, ctx.oc.org._id);
    if (existing) await ctx.db.replace(existing._id, value);
    else await ctx.db.insert("notificationSettings", value);
    await writeAudit(ctx, {
      organizationId: ctx.oc.org._id,
      actorUserId: ctx.oc.user._id,
      action: "notification.settings_updated",
      resourceType: "notificationSettings",
      resourceId: ctx.oc.org._id,
    });
  },
});

/** Which channels are live or dry-run (from env). Names and modes only, never values. */
export const channelConfig = orgQuery({
  args: {},
  handler: async (ctx) => {
    ctx.require("integrations:manage");
    return {
      channels: channelStatus(process.env),
      webhookConfigured: Boolean(process.env.NOTIFY_WEBHOOK_SECRET),
    };
  },
});

/**
 * Send a test message to the caller's own email (default) or to a phone number
 * they enter. Limited to a few per hour per organization.
 */
export const sendTest = orgMutation({
  args: { channel: vChannel, phone: v.optional(v.string()) },
  handler: async (ctx, { channel, phone }) => {
    ctx.require("integrations:manage");
    const now = Date.now();
    const recent = await ctx.db
      .query("notificationOutbox")
      .withIndex("by_org_created", (q) => q.eq("organizationId", ctx.oc.org._id).gte("createdAt", now - 60 * 60 * 1000))
      .take(500);
    if (recent.filter((r) => r.eventType === "test_message").length >= MAX_TEST_SENDS_PER_HOUR) {
      throw appError("RATE_LIMITED", "Too many test messages. Try again later.");
    }
    let recipient: { kind: "visitor"; email?: string; phone?: string };
    if (channel === "email") {
      const email = normalizeEmail(ctx.oc.user.email);
      if (!email) throw appError("VALIDATION", "Your account has no email address.");
      recipient = { kind: "visitor", email };
    } else {
      const normalized = normalizePhone(phone, process.env.NOTIFY_DEFAULT_COUNTRY_CODE);
      if (!normalized) throw appError("VALIDATION", "Enter your phone number in international format, e.g. +254700000000.");
      recipient = { kind: "visitor", phone: normalized };
    }
    const ids = await enqueueNotification(ctx, {
      organizationId: ctx.oc.org._id,
      eventType: "test_message",
      recipient,
      data: { orgName: ctx.oc.org.name },
      key: `test:${ctx.oc.user._id}:${now}:${Math.random().toString(36).slice(2)}`,
      bypassPrefs: true,
      onlyChannels: [channel],
    });
    await writeAudit(ctx, {
      organizationId: ctx.oc.org._id,
      actorUserId: ctx.oc.user._id,
      action: "notification.test_sent",
      resourceType: "notification",
      resourceId: ids[0] ?? "none",
      metadata: { channel },
    });
    return { queued: ids.length };
  },
});

// --- Member preferences ----------------------------------------------------------------

type ChannelPrefs = { email?: boolean; sms?: boolean; whatsapp?: boolean };

/** The caller's own preferences, with the catalogue of events they can switch. */
export const myPreferences = orgQuery({
  args: {},
  handler: async (ctx) => {
    const prefs = await ctx.db
      .query("notificationPreferences")
      .withIndex("by_org_user", (q) => q.eq("organizationId", ctx.oc.org._id).eq("userId", ctx.oc.user._id))
      .unique();
    const settings = await getSettings(ctx, ctx.oc.org._id);
    return {
      phone: prefs?.phone ?? "",
      quietStartMin: prefs?.quietStartMin ?? null,
      quietEndMin: prefs?.quietEndMin ?? null,
      orgChannels: settings?.enabledChannels ?? DEFAULT_CHANNELS,
      events: PREFERENCE_EVENTS.map((e) => {
        const p: ChannelPrefs = prefs?.events[e] ?? {};
        return {
          eventType: e,
          label: TEMPLATES[e].label,
          email: p.email ?? true,
          sms: p.sms ?? false,
          whatsapp: p.whatsapp ?? false,
        };
      }),
    };
  },
});

export const updateMyPreferences = orgMutation({
  args: {
    phone: v.optional(v.string()),
    events: v.record(v.string(), v.object({ email: v.optional(v.boolean()), sms: v.optional(v.boolean()), whatsapp: v.optional(v.boolean()) })),
    quietStartMin: v.optional(v.number()),
    quietEndMin: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const phoneText = args.phone?.trim();
    const phone = phoneText ? normalizePhone(phoneText, process.env.NOTIFY_DEFAULT_COUNTRY_CODE) : null;
    if (phoneText && !phone) throw appError("VALIDATION", "Enter your phone number in international format, e.g. +254700000000.");
    const okMin = (n: number | undefined) => n === undefined || (Number.isInteger(n) && n >= 0 && n < 1440);
    if (!okMin(args.quietStartMin) || !okMin(args.quietEndMin)) throw appError("VALIDATION", "Quiet hours are invalid.");
    if ((args.quietStartMin === undefined) !== (args.quietEndMin === undefined)) {
      throw appError("VALIDATION", "Set both a start and an end for quiet hours, or neither.");
    }
    const events: Record<string, ChannelPrefs> = {};
    for (const [event, p] of Object.entries(args.events)) {
      if (!(PREFERENCE_EVENTS as string[]).includes(event)) throw appError("VALIDATION", "Unknown message type.");
      events[event] = p;
    }
    const value = {
      organizationId: ctx.oc.org._id,
      userId: ctx.oc.user._id,
      phone: phone ?? undefined,
      events,
      quietStartMin: args.quietStartMin,
      quietEndMin: args.quietEndMin,
      updatedAt: Date.now(),
    };
    const existing = await ctx.db
      .query("notificationPreferences")
      .withIndex("by_org_user", (q) => q.eq("organizationId", ctx.oc.org._id).eq("userId", ctx.oc.user._id))
      .unique();
    if (existing) await ctx.db.replace(existing._id, value);
    else await ctx.db.insert("notificationPreferences", value);
  },
});
