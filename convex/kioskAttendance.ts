import { ConvexError, v } from "convex/values";
import {
  normalizeStaffNumber,
  PIN_PATTERN,
  STAFF_NUMBER_PATTERN,
} from "../lib/attendance/sessions";
import { effectivePermissions } from "../lib/permissions";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { logEvent } from "./lib/log";
import { checkClock, currentState, insertEvent } from "./lib/attendance";
import { hasSiteAccess } from "./lib/auth";
import { writeAudit } from "./lib/audit";
import { type KioskContext, kioskMutation } from "./lib/kiosk";
import { checkAnswers, resolveActiveForm, servedFields, storeResponse } from "./lib/formResponses";
import { recordFailure, throttleLocked, type ThrottleConfig, type ThrottleState } from "./lib/throttle";
import { dummyPinWork, PIN_LOCK_MS, PIN_MAX_FAILURES, verifyPin } from "./lib/pin";
import { vAttendanceType, vRawAnswers } from "./validators";

/**
 * Kiosk staff attendance. Two layers of trust, both checked on EVERY call:
 *  1. the device token (kioskMutation: token, slug, per-device rate limit), and
 *  2. the person: staff number + PIN, verified server-side here.
 *
 * Choosing "Staff" on the welcome screen grants nothing. Every failure
 * (unknown staff number, wrong PIN, no PIN set, locked, disabled, no access to
 * this site) returns the identical `{ ok: false }` and does comparable work, so
 * a caller cannot tell which one it was. These mutations deliberately RETURN
 * instead of throwing on failure: a thrown error would roll back the failed-
 * attempt counter and defeat the lockout.
 */
const FAIL = { ok: false as const };
/** H1: the device used up its PIN-failure budget. Says nothing about whether a guess was right. */
const THROTTLED = { ok: false as const, throttled: true as const };

/**
 * H1: device-wide budget for failed PIN attempts (any staff number, wrong PIN,
 * unknown number, locked person). 10 failures in 15 minutes lock the device
 * for 5 minutes, doubling per repeat lock up to an hour. While locked, nothing
 * is counted against any person, so one tablet cannot lock out the whole staff
 * list or keep re-locking one person: at most two people per window.
 */
export const PIN_DEVICE_THROTTLE: ThrottleConfig = {
  windowMs: 15 * 60_000,
  maxFailures: 10,
  baseLockMs: 5 * 60_000,
  maxLockMs: 60 * 60_000,
  levelDecayMs: 24 * 60 * 60_000,
};

function pinState(device: Doc<"kioskDevices">): ThrottleState {
  return {
    windowStart: device.pinWindowStart,
    failures: device.pinFailures,
    lockUntil: device.pinLockUntil,
    level: device.pinLockLevel,
    lastLockAt: device.pinLastLockAt,
  };
}

async function recordDeviceFailure(ctx: MutationCtx & { kiosk: KioskContext }) {
  const { device } = ctx.kiosk;
  const { state, locked } = recordFailure(pinState(device), PIN_DEVICE_THROTTLE);
  await ctx.db.patch(device._id, {
    pinWindowStart: state.windowStart,
    pinFailures: state.failures,
    pinLockUntil: state.lockUntil,
    pinLockLevel: state.level,
    pinLastLockAt: state.lastLockAt,
  });
  if (locked) {
    logEvent("warn", { event: "kiosk_pin_throttled", fn: "kioskAttendance", outcome: "locked", org: ctx.kiosk.org._id, count: state.level ?? 1 });
    await writeAudit(ctx, {
      organizationId: ctx.kiosk.org._id,
      kioskDeviceId: device._id,
      action: "kiosk.pin_throttled",
      resourceType: "kiosk_device",
      resourceId: device._id,
      metadata: { gateId: device.gateId, level: state.level ?? 1 },
    });
  }
}

function firstNameOf(user: Doc<"users"> | null) {
  const full = user?.name?.trim() || user?.email?.split("@")[0] || "";
  return full.split(/\s+/)[0] || "there";
}

type Authenticated = { membership: Doc<"memberships">; user: Doc<"users"> | null };

async function authenticate(
  ctx: MutationCtx & { kiosk: KioskContext },
  staffNumberRaw: string,
  pin: string,
): Promise<Authenticated | "throttled" | null> {
  if (throttleLocked(pinState(ctx.kiosk.device))) return "throttled";
  const staffNumber = normalizeStaffNumber(staffNumberRaw);
  if (!STAFF_NUMBER_PATTERN.test(staffNumber) || !PIN_PATTERN.test(pin)) {
    await recordDeviceFailure(ctx);
    return null;
  }
  const { org, site } = ctx.kiosk;
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_org_staff_number", (q) =>
      q.eq("organizationId", org._id).eq("staffNumber", staffNumber),
    )
    .unique();
  const eligible =
    membership !== null &&
    membership.status === "active" &&
    hasSiteAccess(membership, site._id) &&
    effectivePermissions(membership.role, membership.permissionOverrides).has("staff_attendance:create");
  const record =
    membership && eligible
      ? await ctx.db
          .query("staffPins")
          .withIndex("by_org_user", (q) =>
            q.eq("organizationId", org._id).eq("userId", membership.userId),
          )
          .unique()
      : null;
  const now = Date.now();
  if (!membership || !eligible || !record || (record.lockedUntil ?? 0) > now) {
    await dummyPinWork(pin);
    await recordDeviceFailure(ctx);
    return null;
  }
  // A lock that has run out starts a fresh set of attempts.
  const attempts = record.lockedUntil !== undefined ? 0 : record.failedAttempts;
  if (!(await verifyPin(pin, record))) {
    const failed = attempts + 1;
    const locking = failed >= PIN_MAX_FAILURES;
    await ctx.db.patch(record._id, {
      failedAttempts: failed,
      lockedUntil: locking ? now + PIN_LOCK_MS : undefined,
    });
    if (locking) {
      await writeAudit(ctx, {
        organizationId: org._id,
        kioskDeviceId: ctx.kiosk.device._id,
        action: "attendance.pin_locked",
        resourceType: "membership",
        resourceId: membership._id,
      });
    }
    await recordDeviceFailure(ctx);
    return null;
  }
  if (record.failedAttempts !== 0 || record.lockedUntil !== undefined) {
    await ctx.db.patch(record._id, { failedAttempts: 0, lockedUntil: undefined });
  }
  return { membership, user: await ctx.db.get(membership.userId) };
}

const credentials = { staffNumber: v.string(), pin: v.string() };

/** The staff form (daily declaration, shift note...) published for this kiosk's site, or null. */
async function activeStaffForm(ctx: MutationCtx & { kiosk: KioskContext }) {
  const { org, site } = ctx.kiosk;
  return await resolveActiveForm(ctx, org._id, site._id, "staff");
}

/**
 * Step 1: check staff number + PIN and say hello. Writes nothing except the
 * failed-attempt counter. The client keeps the PIN in memory only and sends it
 * again with `record`, which re-verifies it.
 */
export const identify = kioskMutation({
  args: credentials,
  handler: async (ctx, { staffNumber, pin }) => {
    const who = await authenticate(ctx, staffNumber, pin);
    if (who === "throttled") return THROTTLED;
    if (!who) return FAIL;
    const { open } = await currentState(ctx, ctx.kiosk.org._id, who.membership.userId);
    // The form is only handed out after the PIN checked out, and only when a
    // clock-in is possible. `record` enforces it again.
    const active = open ? null : await activeStaffForm(ctx);
    return {
      ok: true as const,
      firstName: firstNameOf(who.user),
      status: open ? ("in" as const) : ("out" as const),
      since: open?.start ?? null,
      form: active
        ? {
            versionId: active.version._id,
            version: active.version.version,
            name: active.version.name,
            fields: servedFields(ctx.kiosk.org, active.version),
          }
        : null,
    };
  },
});

/** Step 2: re-verify and append a clock event (source "kiosk") for the kiosk's site. */
export const record = kioskMutation({
  args: {
    ...credentials,
    type: vAttendanceType,
    /** Staff form answers, required for a clock-in when a staff form is published for the site. */
    versionId: v.optional(v.id("formVersions")),
    answers: v.optional(vRawAnswers),
  },
  handler: async (ctx, { staffNumber, pin, type, versionId, answers: rawAnswers }) => {
    const who = await authenticate(ctx, staffNumber, pin);
    if (who === "throttled") return THROTTLED;
    if (!who) return FAIL;
    const firstName = firstNameOf(who.user);
    const userId = who.membership.userId;
    const now = Date.now();
    const check = await checkClock(ctx, ctx.kiosk.org._id, userId, type, now);
    if (check.result === "already_in") {
      return { ok: true as const, outcome: "already_in" as const, firstName, at: check.since };
    }
    if (check.result === "not_in") {
      return { ok: true as const, outcome: "not_in" as const, firstName, at: null };
    }
    if (type === "clock_out" && check.siteId !== ctx.kiosk.site._id) {
      return { ok: true as const, outcome: "elsewhere" as const, firstName, at: null };
    }
    // Staff form: required for a clock-in when one is published for this site.
    // Problems are RETURNED (not thrown) so the PIN bookkeeping above commits.
    const active = type === "clock_in" ? await activeStaffForm(ctx) : null;
    let checked: Awaited<ReturnType<typeof checkAnswers>> | null = null;
    if (active) {
      if (!versionId || !rawAnswers) {
        return { ok: true as const, outcome: "form_required" as const, firstName, at: null };
      }
      if (versionId !== active.version._id) {
        return { ok: true as const, outcome: "form_stale" as const, firstName, at: null };
      }
      try {
        // Staff forms have no file fields, so there is no uploader.
        checked = await checkAnswers(ctx, ctx.kiosk.org, active.version, rawAnswers, null);
      } catch (e) {
        if (!(e instanceof ConvexError)) throw e;
        const message = (e.data as { message?: string } | undefined)?.message;
        return {
          ok: true as const,
          outcome: "form_invalid" as const,
          firstName,
          at: null,
          message: message ?? "Please check your answers.",
        };
      }
    }
    const eventId = await insertEvent(ctx, {
      organizationId: ctx.kiosk.org._id,
      siteId: ctx.kiosk.site._id,
      userId,
      type,
      at: now,
      source: "kiosk",
      gateId: ctx.kiosk.gate._id,
      kioskDeviceId: ctx.kiosk.device._id,
    });
    if (active && checked) {
      await storeResponse(ctx, {
        org: ctx.kiosk.org,
        siteId: ctx.kiosk.site._id,
        form: active.form,
        version: active.version,
        answers: checked.answers,
        fileIds: checked.fileIds,
        userId,
        attendanceEventId: eventId,
        actor: { kioskDeviceId: ctx.kiosk.device._id },
      });
    }
    return { ok: true as const, outcome: "recorded" as const, firstName, at: now };
  },
});
