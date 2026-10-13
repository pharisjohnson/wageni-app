import { v } from "convex/values";
import {
  normalizeStaffNumber,
  PIN_PATTERN,
  STAFF_NUMBER_PATTERN,
} from "../lib/attendance/sessions";
import { effectivePermissions } from "../lib/permissions";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { checkClock, currentState, insertEvent } from "./lib/attendance";
import { hasSiteAccess } from "./lib/auth";
import { writeAudit } from "./lib/audit";
import { type KioskContext, kioskMutation } from "./lib/kiosk";
import { dummyPinWork, PIN_LOCK_MS, PIN_MAX_FAILURES, verifyPin } from "./lib/pin";
import { vAttendanceType } from "./validators";

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

function firstNameOf(user: Doc<"users"> | null) {
  const full = user?.name?.trim() || user?.email?.split("@")[0] || "";
  return full.split(/\s+/)[0] || "there";
}

type Authenticated = { membership: Doc<"memberships">; user: Doc<"users"> | null };

async function authenticate(
  ctx: MutationCtx & { kiosk: KioskContext },
  staffNumberRaw: string,
  pin: string,
): Promise<Authenticated | null> {
  const staffNumber = normalizeStaffNumber(staffNumberRaw);
  if (!STAFF_NUMBER_PATTERN.test(staffNumber) || !PIN_PATTERN.test(pin)) return null;
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
        actorUserId: membership.userId,
        action: "attendance.pin_locked",
        resourceType: "membership",
        resourceId: membership._id,
        metadata: { deviceId: ctx.kiosk.device._id },
      });
    }
    return null;
  }
  if (record.failedAttempts !== 0 || record.lockedUntil !== undefined) {
    await ctx.db.patch(record._id, { failedAttempts: 0, lockedUntil: undefined });
  }
  return { membership, user: await ctx.db.get(membership.userId) };
}

const credentials = { staffNumber: v.string(), pin: v.string() };

/**
 * Step 1: check staff number + PIN and say hello. Writes nothing except the
 * failed-attempt counter. The client keeps the PIN in memory only and sends it
 * again with `record`, which re-verifies it.
 */
export const identify = kioskMutation({
  args: credentials,
  handler: async (ctx, { staffNumber, pin }) => {
    const who = await authenticate(ctx, staffNumber, pin);
    if (!who) return FAIL;
    const { open } = await currentState(ctx, ctx.kiosk.org._id, who.membership.userId);
    return {
      ok: true as const,
      firstName: firstNameOf(who.user),
      status: open ? ("in" as const) : ("out" as const),
      since: open?.start ?? null,
    };
  },
});

/** Step 2: re-verify and append a clock event (source "kiosk") for the kiosk's site. */
export const record = kioskMutation({
  args: { ...credentials, type: vAttendanceType },
  handler: async (ctx, { staffNumber, pin, type }) => {
    const who = await authenticate(ctx, staffNumber, pin);
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
    await insertEvent(ctx, {
      organizationId: ctx.kiosk.org._id,
      siteId: ctx.kiosk.site._id,
      userId,
      type,
      at: now,
      source: "kiosk",
      gateId: ctx.kiosk.gate._id,
      kioskDeviceId: ctx.kiosk.device._id,
    });
    return { ok: true as const, outcome: "recorded" as const, firstName, at: now };
  },
});
