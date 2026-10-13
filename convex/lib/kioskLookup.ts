import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { writeAudit } from "./audit";
import type { KioskContext } from "./kiosk";
import { dayBoundsInZone } from "./time";

/**
 * Failed-lookup throttle for kiosk functions that take guessable secrets
 * (a phone number, a badge code plus phone digits). Mutations that throw roll
 * back their writes, so these functions never throw for "no match": they
 * record the failure and return a generic result, which lets the counter
 * commit. Once a device has burned its failures in the window, every lookup
 * returns "locked" without touching data, so the response never depends on
 * whether a guess was right.
 *
 * Counters live on the device (one kiosk = one budget). The general
 * 60 calls/minute limit from `kioskMutation` still applies on top.
 */
export const LOOKUP_WINDOW_MS = 5 * 60_000;
export const LOOKUP_MAX_FAILURES = 8;

function inWindow(device: Doc<"kioskDevices">, now: number) {
  return device.lookupWindowStart !== undefined && now - device.lookupWindowStart < LOOKUP_WINDOW_MS;
}

export function lookupLocked(device: Doc<"kioskDevices">, now = Date.now()) {
  return inWindow(device, now) && (device.lookupFailures ?? 0) >= LOOKUP_MAX_FAILURES;
}

/** Count one failed lookup. Audits once, when the device first becomes locked. */
export async function recordLookupFailure(ctx: MutationCtx, device: Doc<"kioskDevices">) {
  const now = Date.now();
  const open = inWindow(device, now);
  const failures = (open ? (device.lookupFailures ?? 0) : 0) + 1;
  await ctx.db.patch(device._id, {
    lookupWindowStart: open ? device.lookupWindowStart : now,
    lookupFailures: failures,
  });
  if (failures === LOOKUP_MAX_FAILURES) {
    await writeAudit(ctx, {
      organizationId: device.organizationId,
      kioskDeviceId: device._id,
      action: "kiosk.lookup_throttled",
      resourceType: "kiosk_device",
      resourceId: device._id,
      metadata: { gateId: device.gateId },
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
