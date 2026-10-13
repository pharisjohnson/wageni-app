import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { normalizeEmail, normalizePhone } from "../../lib/notifications/address";
import { inQuietHours } from "../../lib/notifications/quiet-hours";
import { CHANNELS, cleanValue, type Channel, type EventType } from "../../lib/notifications/templates";

/** Attempts before a message is marked failed. Backoff before attempt n+1 is BACKOFF_MS[n-1]. */
export const MAX_ATTEMPTS = 4;
export const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000];
/** Messages per organization per hour (all channels). Excess is recorded as skipped. */
export const RATE_LIMIT_PER_HOUR = 300;
const HOUR = 60 * 60 * 1000;

/** Channels used when an organization has not saved settings. */
export const DEFAULT_CHANNELS: Channel[] = ["email"];
/** A member's default: email only until they opt in to phone channels. */
const DEFAULT_USER_CHANNEL: Record<Channel, boolean> = { email: true, sms: false, whatsapp: false };

export type Recipient =
  | { kind: "user"; userId: Id<"users"> }
  | { kind: "visitor"; email?: string; phone?: string };

export function backoffFor(attempts: number) {
  return BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1]!;
}

export async function getSettings(ctx: QueryCtx, organizationId: Id<"organizations">) {
  return await ctx.db
    .query("notificationSettings")
    .withIndex("by_org", (q) => q.eq("organizationId", organizationId))
    .unique();
}

/** Count one message against the organization's hourly window. False when over the limit. */
async function takeRateToken(ctx: MutationCtx, organizationId: Id<"organizations">, now: number) {
  const row = await ctx.db
    .query("notificationUsage")
    .withIndex("by_org", (q) => q.eq("organizationId", organizationId))
    .unique();
  if (!row) {
    await ctx.db.insert("notificationUsage", { organizationId, windowStart: now, count: 1 });
    return true;
  }
  if (now - row.windowStart >= HOUR) {
    await ctx.db.patch(row._id, { windowStart: now, count: 1 });
    return true;
  }
  if (row.count >= RATE_LIMIT_PER_HOUR) return false;
  await ctx.db.patch(row._id, { count: row.count + 1 });
  return true;
}

type Target = { channel: Channel; to: string };

/**
 * Resolve where a message goes, per channel. Staff come from the membership
 * (must be active in THIS organization), their email and their preferences;
 * visitors from the contact details passed in. Channels without an address
 * or switched off are simply absent.
 */
async function resolveTargets(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  eventType: EventType,
  recipient: Recipient,
  channels: readonly Channel[],
  prefs: Doc<"notificationPreferences"> | null,
  bypassPrefs: boolean,
): Promise<Target[]> {
  const cc = process.env.NOTIFY_DEFAULT_COUNTRY_CODE;
  const out: Target[] = [];
  if (recipient.kind === "visitor") {
    for (const channel of channels) {
      const to = channel === "email" ? normalizeEmail(recipient.email) : normalizePhone(recipient.phone, cc);
      if (to) out.push({ channel, to });
    }
    return out;
  }
  const user = await ctx.db.get(recipient.userId);
  if (!user) return out;
  for (const channel of channels) {
    const allowed = bypassPrefs || (prefs?.events[eventType]?.[channel] ?? DEFAULT_USER_CHANNEL[channel]);
    if (!allowed) continue;
    const to = channel === "email" ? normalizeEmail(user.email) : normalizePhone(prefs?.phone, cc);
    if (to) out.push({ channel, to });
  }
  return out;
}

/**
 * Queue a notification (one outbox row per channel) and schedule delivery.
 *
 * - Idempotent: `key` plus channel plus recipient identifies the message, so a
 *   trigger firing twice (retries, double submits) enqueues once.
 * - Tenant-safe: staff recipients must hold an active membership in the
 *   organization; settings and preferences are read for that organization only.
 * - Respects organization channels, member preferences and quiet hours (staff
 *   only; recorded as `skipped`) and the per-organization hourly rate limit.
 * - `data` holds placeholder values only. Keep it to what the template needs.
 */
export async function enqueueNotification(
  ctx: MutationCtx,
  input: {
    organizationId: Id<"organizations">;
    siteId?: Id<"sites">;
    eventType: EventType;
    recipient: Recipient;
    data: Record<string, string>;
    key: string;
    /** Test sends ignore the member's own preferences and quiet hours (still need a configured channel). */
    bypassPrefs?: boolean;
    /** Restrict to these channels (test sends). */
    onlyChannels?: readonly Channel[];
  },
): Promise<Id<"notificationOutbox">[]> {
  const { organizationId, eventType, recipient, key } = input;
  const org = await ctx.db.get(organizationId);
  if (!org || org.status === "suspended") return [];
  const settings = await getSettings(ctx, organizationId);
  const orgChannels = settings ? settings.enabledChannels : DEFAULT_CHANNELS;
  const channels = CHANNELS.filter(
    (c) => (input.bypassPrefs ? true : orgChannels.includes(c)) && (!input.onlyChannels || input.onlyChannels.includes(c)),
  );
  if (channels.length === 0) return [];

  let prefs: Doc<"notificationPreferences"> | null = null;
  if (recipient.kind === "user") {
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_org_user", (q) => q.eq("organizationId", organizationId).eq("userId", recipient.userId))
      .unique();
    if (!membership || membership.status !== "active") return [];
    prefs = await ctx.db
      .query("notificationPreferences")
      .withIndex("by_org_user", (q) => q.eq("organizationId", organizationId).eq("userId", recipient.userId))
      .unique();
  }

  const targets = await resolveTargets(ctx, organizationId, eventType, recipient, channels, prefs, Boolean(input.bypassPrefs));
  const payload = Object.fromEntries(Object.entries(input.data).map(([k, v]) => [k, cleanValue(v)]));
  const now = Date.now();
  const who = recipient.kind === "user" ? recipient.userId : "visitor";
  const created: Id<"notificationOutbox">[] = [];

  for (const { channel, to } of targets) {
    const idempotencyKey = `${key}|${channel}|${who}`;
    const dup = await ctx.db
      .query("notificationOutbox")
      .withIndex("by_org_idem", (q) => q.eq("organizationId", organizationId).eq("idempotencyKey", idempotencyKey))
      .first();
    if (dup) continue;

    let skipReason: string | undefined;
    if (
      recipient.kind === "user" &&
      !input.bypassPrefs &&
      inQuietHours(now, org.timeZone, prefs?.quietStartMin, prefs?.quietEndMin)
    ) {
      skipReason = "quiet_hours";
    } else if (!(await takeRateToken(ctx, organizationId, now))) {
      skipReason = "rate_limited";
    }

    const id = await ctx.db.insert("notificationOutbox", {
      organizationId,
      siteId: input.siteId,
      channel,
      eventType,
      templateKey: eventType,
      recipientKind: recipient.kind,
      recipientUserId: recipient.kind === "user" ? recipient.userId : undefined,
      to: skipReason ? undefined : to,
      payload,
      status: skipReason ? "skipped" : "queued",
      attempts: 0,
      lastError: skipReason,
      idempotencyKey,
      createdAt: now,
    });
    created.push(id);
    if (!skipReason) await ctx.scheduler.runAfter(0, internal.notificationsDelivery.deliver, { outboxId: id });
  }
  return created;
}
