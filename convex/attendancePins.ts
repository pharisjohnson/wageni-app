import { v } from "convex/values";
import {
  isWeakPin,
  normalizeStaffNumber,
  PIN_PATTERN,
  STAFF_NUMBER_PATTERN,
} from "../lib/attendance/sessions";
import { ROLE_RANK } from "../lib/permissions";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import type { OrgContext } from "./lib/auth";
import { writeAudit } from "./lib/audit";
import { appError } from "./lib/errors";
import { orgMutation, orgQuery } from "./lib/functions";
import { hashPin } from "./lib/pin";

/** Whether I have a kiosk PIN and a staff number. Never returns the PIN or its hash. */
export const myPinStatus = orgQuery({
  args: {},
  handler: async (ctx) => {
    ctx.require("staff_attendance:create");
    const pin = await ctx.db
      .query("staffPins")
      .withIndex("by_org_user", (q) =>
        q.eq("organizationId", ctx.oc.org._id).eq("userId", ctx.oc.user._id),
      )
      .unique();
    return {
      staffNumber: ctx.oc.membership.staffNumber ?? null,
      pinSet: pin !== null,
      locked: (pin?.lockedUntil ?? 0) > Date.now(),
      updatedAt: pin?.updatedAt ?? null,
    };
  },
});

/**
 * Set or change my own kiosk PIN (4-6 digits). The caller is signed in, so no
 * current PIN is needed; setting a PIN also clears any lockout. The PIN is
 * hashed immediately and never stored, returned or logged.
 */
export const setMyPin = orgMutation({
  args: { pin: v.string() },
  handler: async (ctx, { pin }) => {
    ctx.require("staff_attendance:create");
    if (!PIN_PATTERN.test(pin)) throw appError("VALIDATION", "Use 4 to 6 digits.");
    if (isWeakPin(pin)) {
      throw appError("VALIDATION", "That PIN is too easy to guess. Avoid repeats and runs like 1234.");
    }
    if (!ctx.oc.membership.staffNumber) {
      throw appError("VALIDATION", "Ask a manager to give you a staff number first.");
    }
    const hashed = await hashPin(pin);
    const now = Date.now();
    const existing = await ctx.db
      .query("staffPins")
      .withIndex("by_org_user", (q) =>
        q.eq("organizationId", ctx.oc.org._id).eq("userId", ctx.oc.user._id),
      )
      .unique();
    const fields = { ...hashed, failedAttempts: 0, lockedUntil: undefined, setBy: ctx.oc.user._id, updatedAt: now };
    if (existing) await ctx.db.patch(existing._id, fields);
    else {
      await ctx.db.insert("staffPins", {
        organizationId: ctx.oc.org._id,
        userId: ctx.oc.user._id,
        ...fields,
        createdAt: now,
      });
    }
    await writeAudit(ctx, {
      organizationId: ctx.oc.org._id,
      actorUserId: ctx.oc.user._id,
      action: "attendance.pin_set",
      resourceType: "membership",
      resourceId: ctx.oc.membership._id,
    });
  },
});

async function loadManageable(
  ctx: MutationCtx & { oc: OrgContext },
  membershipId: Id<"memberships">,
) {
  const target = await ctx.db.get(membershipId);
  if (!target || target.organizationId !== ctx.oc.org._id) throw appError("NOT_FOUND");
  if (target.userId === ctx.oc.user._id) {
    throw appError("FORBIDDEN", "Use your own Attendance page to change your PIN.");
  }
  const actorRole = ctx.oc.membership.role;
  if (actorRole !== "owner" && ROLE_RANK[target.role] >= ROLE_RANK[actorRole]) throw appError("FORBIDDEN");
  return target;
}

/**
 * Remove someone's PIN (also clears a lockout). They set a new one themselves
 * from Attendance, so a manager never knows or chooses a PIN.
 */
export const resetPin = orgMutation({
  args: { membershipId: v.id("memberships") },
  handler: async (ctx, { membershipId }) => {
    ctx.require("staff_attendance:manage_pins");
    const target = await loadManageable(ctx, membershipId);
    const pin = await ctx.db
      .query("staffPins")
      .withIndex("by_org_user", (q) =>
        q.eq("organizationId", ctx.oc.org._id).eq("userId", target.userId),
      )
      .unique();
    if (pin) await ctx.db.delete(pin._id);
    await writeAudit(ctx, {
      organizationId: ctx.oc.org._id,
      actorUserId: ctx.oc.user._id,
      action: "attendance.pin_reset",
      resourceType: "membership",
      resourceId: membershipId,
    });
  },
});

/** Assign (or clear) the staff number staff type at the kiosk. Unique per organization. */
export const setStaffNumber = orgMutation({
  args: { membershipId: v.id("memberships"), staffNumber: v.union(v.string(), v.null()) },
  handler: async (ctx, { membershipId, staffNumber }) => {
    ctx.require("staff_attendance:manage_pins");
    const target = await loadManageable(ctx, membershipId);
    const normalized = staffNumber === null || staffNumber.trim() === "" ? null : normalizeStaffNumber(staffNumber);
    if (normalized !== null) {
      if (!STAFF_NUMBER_PATTERN.test(normalized)) {
        throw appError("VALIDATION", "Use 2 to 12 letters, numbers or dashes.");
      }
      const clash = await ctx.db
        .query("memberships")
        .withIndex("by_org_staff_number", (q) =>
          q.eq("organizationId", ctx.oc.org._id).eq("staffNumber", normalized),
        )
        .take(2);
      if (clash.some((m) => m._id !== target._id)) {
        throw appError("CONFLICT", "That staff number is already in use.");
      }
    }
    await ctx.db.patch(target._id, { staffNumber: normalized ?? undefined, updatedAt: Date.now() });
    // A changed identity must not keep an old PIN.
    const pin = await ctx.db
      .query("staffPins")
      .withIndex("by_org_user", (q) =>
        q.eq("organizationId", ctx.oc.org._id).eq("userId", target.userId),
      )
      .unique();
    if (pin && target.staffNumber !== (normalized ?? undefined)) await ctx.db.delete(pin._id);
    await writeAudit(ctx, {
      organizationId: ctx.oc.org._id,
      actorUserId: ctx.oc.user._id,
      action: "attendance.staff_number_set",
      resourceType: "membership",
      resourceId: membershipId,
    });
  },
});
