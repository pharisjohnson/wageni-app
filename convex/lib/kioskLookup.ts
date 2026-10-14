import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { writeAudit } from "./audit";
import { appError } from "./errors";
import { logEvent } from "./log";
import { takePublicLimit } from "./publicLimit";
import type { KioskContext } from "./kiosk";
import { recordFailure, throttleLocked, type ThrottleConfig, type ThrottleState } from "./throttle";
import { dayBoundsInZone } from "./time";

/**
 * Failed-lookup throttle for kiosk functions that take guessable secrets
 * (a phone number, a badge code plus phone digits). Mutations that throw roll
 * back their writes, so these functions never throw for "no match": they
 * record the failure and return a generic result, which lets the counter
 * commit. Once a device has burned its failures in the window it is locked
 * and every lookup returns "locked" without touching data, so the response
 * never depends on whether a guess was right.
 *
 * H1: the lock escalates. 8 failures in 5 minutes lock the device for 5
 * minutes; each further lock within 24 hours doubles the time (10, 20, 40,
 * then 60 minutes), so a patient guesser gets at most about 8 guesses an hour
 * instead of 96. Revoking and re-pairing the device clears it.
 *
 * Counters live on the device (one kiosk = one budget). The general
 * 60 calls/minute limit from `kioskMutation` still applies on top.
 */
export const LOOKUP_WINDOW_MS = 5 * 60_000;
export const LOOKUP_MAX_FAILURES = 8;
export const LOOKUP_THROTTLE: ThrottleConfig = {
  windowMs: LOOKUP_WINDOW_MS,
  maxFailures: LOOKUP_MAX_FAILURES,
  baseLockMs: 5 * 60_000,
  maxLockMs: 60 * 60_000,
  levelDecayMs: 24 * 60 * 60_000,
};

function lookupState(device: Doc<"kioskDevices">): ThrottleState {
  return {
    windowStart: device.lookupWindowStart,
    failures: device.lookupFailures,
    lockUntil: device.lookupLockUntil,
    level: device.lookupLockLevel,
    lastLockAt: device.lookupLastLockAt,
  };
}

export function lookupLocked(device: Doc<"kioskDevices">, now = Date.now()) {
  return throttleLocked(lookupState(device), now);
}

/** Count one failed lookup. Audits once per lock, when the device becomes locked. */
export async function recordLookupFailure(ctx: MutationCtx, device: Doc<"kioskDevices">) {
  const { state, locked } = recordFailure(lookupState(device), LOOKUP_THROTTLE);
  await ctx.db.patch(device._id, {
    lookupWindowStart: state.windowStart,
    lookupFailures: state.failures,
    lookupLockUntil: state.lockUntil,
    lookupLockLevel: state.level,
    lookupLastLockAt: state.lastLockAt,
  });
  if (locked) {
    logEvent("warn", { event: "kiosk_lookup_locked", fn: "kioskLookup", outcome: "locked", org: device.organizationId, count: state.level ?? 1 });
    await writeAudit(ctx, {
      organizationId: device.organizationId,
      kioskDeviceId: device._id,
      action: "kiosk.lookup_throttled",
      resourceType: "kiosk_device",
      resourceId: device._id,
      metadata: { gateId: device.gateId, level: state.level ?? 1 },
    });
  }
}

/** Digits only. */
export function phoneDigits(phone: string) {
  return phone.replace(/\D/g, "");
}

/**
 * Comparison key for phone numbers typed in different formats
 * (+254 700 111 222, 0700111222): the last 9 digits.
 */
export function phoneKey(phone: string) {
  return phoneDigits(phone).slice(-9);
}

const MAX_TODAY = 300;

/** Approved appointments today at the device's site whose visitor phone matches. */
export async function todaysAppointmentsForPhone(ctx: MutationCtx & { kiosk: KioskContext }, phone: string) {
  const { org, site } = ctx.kiosk;
  const key = phoneKey(phone);
  const { start, end } = dayBoundsInZone(Date.now(), site.timeZone);
  const today = await ctx.db
    .query("appointments")
    .withIndex("by_site_start", (q) => q.eq("siteId", site._id).gte("scheduledStart", start).lt("scheduledStart", end))
    .take(MAX_TODAY);
  const out: { appt: Doc<"appointments">; visitor: Doc<"visitors"> }[] = [];
  for (const appt of today) {
    if (appt.organizationId !== org._id || appt.status !== "approved") continue;
    const visitor = await ctx.db.get(appt.visitorId);
    if (!visitor || visitor.organizationId !== org._id || !visitor.phone) continue;
    if (phoneKey(visitor.phone) === key) out.push({ appt, visitor });
  }
  return out;
}

/**
 * H1: walk-in spam budgets, on top of the 60 calls/minute device limit.
 * A kiosk creates a visitor record, a visit, an audit entry and notifications
 * per walk-in, so an unattended tablet could otherwise be used to flood an
 * organization's data. Budgets: per device per day, and per phone number per
 * organization per day (a returning visitor may legitimately register a few
 * times). Counters live in `publicRateLimits` (phone numbers are hashed).
 * Exceeding a budget throws RATE_LIMITED with a message the kiosk shows.
 */
export const WALK_IN_DAY_MS = 24 * 60 * 60_000;
export const WALK_IN_MAX_PER_DEVICE_PER_DAY = 250;
export const WALK_IN_MAX_PER_PHONE_PER_DAY = 3;

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function takeWalkInBudget(ctx: MutationCtx & { kiosk: KioskContext }, phone: string) {
  const { org, device } = ctx.kiosk;
  try {
    await takePublicLimit(ctx, `walkin_day:${device._id}`, WALK_IN_MAX_PER_DEVICE_PER_DAY, WALK_IN_DAY_MS);
  } catch {
    throw appError("RATE_LIMITED", "This kiosk has reached its daily limit of new visitors. Please see reception.");
  }
  try {
    const hash = await sha256Hex(`${org._id}:${phoneKey(phone)}`);
    await takePublicLimit(ctx, `walkin_phone:${hash}`, WALK_IN_MAX_PER_PHONE_PER_DAY, WALK_IN_DAY_MS);
  } catch {
    throw appError("RATE_LIMITED", "This phone number has already been registered several times today. Please see reception.");
  }
}
