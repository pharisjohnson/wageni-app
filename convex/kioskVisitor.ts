import { v } from "convex/values";
import { effectivePermissions } from "../lib/permissions";
import { kioskCheckOutSchema, kioskPhoneSchema, kioskWalkInSchema } from "../lib/validation/visits";
import { kioskMutation, kioskQuery } from "./lib/kiosk";
import {
  lookupLocked,
  phoneDigits,
  recordLookupFailure,
  takeWalkInBudget,
  todaysAppointmentsForPhone,
} from "./lib/kioskLookup";
import { writeAudit } from "./lib/audit";
import { parseOrThrow } from "./lib/validate";
import { formRequiredForAppointment } from "./lib/formResponses";
import { assertHost, upsertVisitor } from "./lib/visitors";
import { admitAppointment, completeCheckOut, registerVisit } from "./lib/visits";

/**
 * Visitor self-service at a paired kiosk. Every function is a
 * `kioskQuery`/`kioskMutation`: the device token resolves org, site and gate,
 * so a visitor never chooses them and nothing here can reach another tenant
 * or site.
 *
 * Privacy rules for responses:
 * - Only minimal fields leave the server (first name, host name, time, badge
 *   code for the visit the caller just created). Never a list of
 *   appointments, never a last name, phone, email or purpose.
 * - "Nothing matched" is one generic `{ status: "no_match" }`. A wrong phone,
 *   an unapproved appointment, a different day, another site and a wrong
 *   badge code are indistinguishable.
 * - Guessable lookups (phone, badge code) are throttled per device by failure
 *   count (see convex/lib/kioskLookup.ts). They return results instead of
 *   throwing so the failure counter is committed.
 */

type NoMatch = { status: "no_match" };
type Locked = { status: "locked" };
const NO_MATCH: NoMatch = { status: "no_match" };
const LOCKED: Locked = { status: "locked" };
const FORM_REQUIRED = { status: "form_required" as const };

const MAX_ON_SITE = 1000;
/** H1: kiosk self check-out accepts a badge code for 24 hours, and 5 wrong phone-digit tries per visit. */
export const KIOSK_CHECKOUT_MAX_AGE_MS = 24 * 60 * 60_000;
export const KIOSK_CHECKOUT_MAX_VISIT_FAILURES = 5;

function firstName(name: string) {
  return name.trim().split(/\s+/)[0] ?? "";
}

/**
 * Hosts a walk-in can ask for: active members of the organization with access
 * to this site who can host visitors. Names only (no email, role or contact).
 */
export const hosts = kioskQuery({
  args: {},
  handler: async (ctx) => {
    const { org, site } = ctx.kiosk;
    const members = await ctx.db
      .query("memberships")
      .withIndex("by_org", (q) => q.eq("organizationId", org._id))
      .take(500);
    const eligible = members.filter(
      (m) =>
        m.status === "active" &&
        (m.siteAccess === "all" || m.siteAccess.includes(site._id)) &&
        effectivePermissions(m.role, m.permissionOverrides).has("visits:check_out_own"),
    );
    const users = await Promise.all(eligible.map((m) => ctx.db.get(m.userId)));
    return users
      .flatMap((u) => (u?.name ? [{ userId: u._id, name: u.name }] : []))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 200);
  },
});

/**
 * Step 1 of appointment check-in. Returns the caller's own approved
 * appointments today at this site: first name, host name and start time.
 */
export const findAppointments = kioskMutation({
  args: { phone: v.string() },
  handler: async (ctx, args) => {
    const phone = parseOrThrow(kioskPhoneSchema, args.phone);
    const { device } = ctx.kiosk;
    if (lookupLocked(device)) return LOCKED;
    const found = await todaysAppointmentsForPhone(ctx, phone);
    if (found.length === 0) {
      await recordLookupFailure(ctx, device);
      return NO_MATCH;
    }
    const matches = await Promise.all(
      found.map(async ({ appt, visitor }) => ({
        appointmentId: appt._id,
        firstName: firstName(visitor.name),
        hostName: (await ctx.db.get(appt.hostUserId))?.name ?? "your host",
        startAt: appt.scheduledStart,
      })),
    );
    matches.sort((a, b) => a.startAt - b.startAt);
    return { status: "found" as const, matches };
  },
});

/**
 * Step 2: the visitor confirms ("that's me"). The phone is verified again
 * server side, so an appointment id alone is never enough to check in. Creates
 * the visit as `on_site` through the same logic as `visits.checkInAppointment`.
 */
export const checkInAppointment = kioskMutation({
  args: { appointmentId: v.id("appointments"), phone: v.string() },
  handler: async (ctx, args) => {
    const phone = parseOrThrow(kioskPhoneSchema, args.phone);
    const { device, gate } = ctx.kiosk;
    if (lookupLocked(device)) return LOCKED;
    const found = await todaysAppointmentsForPhone(ctx, phone);
    const hit = found.find((f) => f.appt._id === args.appointmentId);
    if (!hit) {
      await recordLookupFailure(ctx, device);
      return NO_MATCH;
    }
    // A published visitor form must be answered first (kioskForms.checkInAppointmentWithForm).
    if (await formRequiredForAppointment(ctx, ctx.kiosk, hit.appt)) return FORM_REQUIRED;
    const { badgeCode } = await admitAppointment(ctx, hit.appt, gate._id, {
      kioskDeviceId: device._id,
    });
    return {
      status: "ok" as const,
      firstName: firstName(hit.visitor.name),
      hostName: (await ctx.db.get(hit.appt.hostUserId))?.name ?? "your host",
      badgeCode,
    };
  },
});

/**
 * Walk-in self-registration. Semantics match `visits.registerWalkIn` for a
 * caller who cannot admit: the visit is `expected` (no badge yet) until a
 * guard or receptionist admits it from the Visits page. The visitor is told to
 * wait for the host or reception. An existing visitor record with the same
 * phone is reused but never edited from the public form.
 */
export const registerWalkIn = kioskMutation({
  args: {
    visitor: v.object({ name: v.string(), phone: v.string(), company: v.optional(v.string()) }),
    purpose: v.string(),
    hostUserId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const data = parseOrThrow(kioskWalkInSchema, { ...args.visitor, purpose: args.purpose });
    const { org, site, gate, device } = ctx.kiosk;
    await assertHost(ctx, org._id, args.hostUserId, site._id);
    await takeWalkInBudget(ctx, data.phone);
    const visitorId = await upsertVisitor(
      ctx,
      org._id,
      { name: data.name, phone: data.phone, company: data.company },
      { updateExisting: false },
    );
    await registerVisit(
      ctx,
      {
        organizationId: org._id,
        siteId: site._id,
        visitorId,
        hostUserId: args.hostUserId,
        purpose: data.purpose,
        originGateId: gate._id,
      },
      { kioskDeviceId: device._id },
    );
    return {
      status: "ok" as const,
      firstName: firstName(data.name),
      hostName: (await ctx.db.get(args.hostUserId))?.name ?? "your host",
    };
  },
});

/**
 * Self check-out with the 6-digit badge code plus the last 4 digits of the
 * visitor's phone. Closes the visit with method `kiosk` at this gate.
 */
export const checkOut = kioskMutation({
  args: { badgeCode: v.string(), phoneLast4: v.string() },
  handler: async (ctx, args) => {
    const { badgeCode, phoneLast4 } = parseOrThrow(kioskCheckOutSchema, args);
    const { site, gate, device } = ctx.kiosk;
    if (lookupLocked(device)) return LOCKED;
    const onSite = await ctx.db
      .query("visits")
      .withIndex("by_site_status", (q) => q.eq("siteId", site._id).eq("status", "on_site"))
      .take(MAX_ON_SITE);
    const now = Date.now();
    for (const visit of onSite) {
      if (visit.organizationId !== ctx.kiosk.org._id || visit.badgeCode !== badgeCode) continue;
      // H1: a badge code stops working at the kiosk after a day, and after 5
      // wrong phone-digit attempts on this visit. Staff can still check the
      // visitor out. Both cases look like any other miss.
      if ((visit.checkedInAt ?? visit.createdAt) < now - KIOSK_CHECKOUT_MAX_AGE_MS) continue;
      if ((visit.checkoutFailures ?? 0) >= KIOSK_CHECKOUT_MAX_VISIT_FAILURES) continue;
      const visitor = await ctx.db.get(visit.visitorId);
      if (!visitor?.phone || phoneDigits(visitor.phone).slice(-4) !== phoneLast4) {
        const failures = (visit.checkoutFailures ?? 0) + 1;
        await ctx.db.patch(visit._id, { checkoutFailures: failures });
        if (failures === KIOSK_CHECKOUT_MAX_VISIT_FAILURES) {
          await writeAudit(ctx, {
            organizationId: visit.organizationId,
            kioskDeviceId: device._id,
            action: "visit.kiosk_checkout_locked",
            resourceType: "visit",
            resourceId: visit._id,
          });
        }
        continue;
      }
      await completeCheckOut(ctx, visit, "kiosk", { kioskDeviceId: device._id }, gate._id);
      return { status: "ok" as const, firstName: firstName(visitor.name) };
    }
    await recordLookupFailure(ctx, device);
    return NO_MATCH;
  },
});
