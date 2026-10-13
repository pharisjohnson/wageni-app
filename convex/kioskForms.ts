import { v } from "convex/values";
import { kioskWalkInSchema } from "../lib/validation/visits";
import { kioskPhoneSchema } from "../lib/validation/visits";
import { mappedValues, usableAutoFill, type Answers, type FormField, type InviteDetails } from "../lib/validation/forms";
import type { Doc } from "./_generated/dataModel";
import { kioskMutation, kioskQuery } from "./lib/kiosk";
import { lookupLocked, recordLookupFailure, todaysAppointmentsForPhone } from "./lib/kioskLookup";
import {
  checkAnswers,
  fieldsOf,
  formRequiredForAppointment,
  resolveActiveForm,
  servedFields,
  storeResponse,
} from "./lib/formResponses";
import { faceCaptureEnabled } from "./lib/policy";
import { appError } from "./lib/errors";
import { parseOrThrow } from "./lib/validate";
import { assertHost, upsertVisitor } from "./lib/visitors";
import { admitAppointment, registerVisit } from "./lib/visits";
import { vRawAnswers } from "./validators";

/**
 * The visitor form at a paired kiosk. The device token fixes organization and
 * site, so a visitor can never ask for another site's form.
 */

/**
 * The published visitor form for this device's site, or null (the kiosk then
 * falls back to its fixed fields). Only the form definition leaves the
 * server, never any answers.
 */
export const activeVisitorForm = kioskQuery({
  args: {},
  handler: async (ctx) => {
    const { org, site } = ctx.kiosk;
    const active = await resolveActiveForm(ctx, org._id, site._id, "visitor");
    if (!active) return null;
    return {
      formId: active.form._id,
      versionId: active.version._id,
      version: active.version.version,
      name: active.version.name,
      fields: servedFields(org, active.version),
      faceCaptureEnabled: faceCaptureEnabled(org),
    };
  },
});

function firstName(name: string) {
  return name.trim().split(/\s+/)[0] ?? "";
}

/**
 * What the appointment already tells us. These fill form fields mapped to the
 * same targets (name, phone, email, company, purpose) on the server, so the
 * visitor is not asked twice and the values never travel to the screen.
 */
function knownDetails(appt: Doc<"appointments">, visitor: Doc<"visitors">): InviteDetails {
  return {
    name: visitor.name,
    phone: visitor.phone ?? "",
    email: visitor.email,
    company: visitor.company,
    purpose: appt.purpose,
  };
}

const NO_MATCH = { status: "no_match" as const };
const LOCKED = { status: "locked" as const };

/**
 * Appointment check-in, step 2 (after the phone matched): the form this visit
 * must answer. Re-verifies the phone (an appointment id alone is useless) and
 * shares the failed-lookup throttle. `no_form` means check in directly
 * (`kioskVisitor.checkInAppointment`): either no form is published for this
 * site or the visitor already answered it through their invitation link.
 * `prefilledFieldIds` are fields filled server-side from the appointment; the
 * screen must not show them.
 */
export const formForAppointment = kioskMutation({
  args: { appointmentId: v.id("appointments"), phone: v.string() },
  handler: async (ctx, args) => {
    const phone = parseOrThrow(kioskPhoneSchema, args.phone);
    const { org, device } = ctx.kiosk;
    if (lookupLocked(device)) return LOCKED;
    const hit = (await todaysAppointmentsForPhone(ctx, phone)).find((f) => f.appt._id === args.appointmentId);
    if (!hit) {
      await recordLookupFailure(ctx, device);
      return NO_MATCH;
    }
    const active = await formRequiredForAppointment(ctx, ctx.kiosk, hit.appt);
    if (!active) return { status: "no_form" as const };
    const fields = servedFields(org, active.version);
    return {
      status: "form" as const,
      versionId: active.version._id,
      version: active.version.version,
      name: active.version.name,
      fields,
      prefilledFieldIds: Object.keys(usableAutoFill(fields, knownDetails(hit.appt, hit.visitor))),
      faceCaptureEnabled: faceCaptureEnabled(org),
    };
  },
});

/**
 * Appointment check-in WITH the published form: verifies the phone again,
 * validates the answers server-side against the version being served (same
 * `validateAnswers` as walk-ins), creates the visit through the shared
 * `admitAppointment`, and stores the response against the visit, the
 * appointment and the exact form version. Anything invalid throws before the
 * visit is created, so a rejected form never admits anyone.
 */
export const checkInAppointmentWithForm = kioskMutation({
  args: {
    appointmentId: v.id("appointments"),
    phone: v.string(),
    versionId: v.id("formVersions"),
    answers: vRawAnswers,
  },
  handler: async (ctx, args) => {
    const phone = parseOrThrow(kioskPhoneSchema, args.phone);
    const { org, site, gate, device } = ctx.kiosk;
    if (lookupLocked(device)) return LOCKED;
    const hit = (await todaysAppointmentsForPhone(ctx, phone)).find((f) => f.appt._id === args.appointmentId);
    if (!hit) {
      await recordLookupFailure(ctx, device);
      return NO_MATCH;
    }
    const active = await formRequiredForAppointment(ctx, ctx.kiosk, hit.appt);
    if (!active) throw appError("CONFLICT", "This form is no longer needed. Please start again.");
    if (active.version._id !== args.versionId) {
      throw appError("CONFLICT", "This form was updated. Please start again.");
    }
    const fields: FormField[] = fieldsOf(active.version);
    // Known details win over anything the screen sent for those fields.
    const filled = { ...args.answers, ...usableAutoFill(fields, knownDetails(hit.appt, hit.visitor)) };
    const { answers, fileIds } = await checkAnswers(ctx, org, active.version, filled, { kioskDeviceId: device._id });
    const { visitId, badgeCode } = await admitAppointment(ctx, hit.appt, gate._id, { kioskDeviceId: device._id });
    await storeResponse(ctx, {
      org,
      siteId: site._id,
      form: active.form,
      version: active.version,
      answers,
      fileIds,
      visitId,
      appointmentId: hit.appt._id,
      actor: { kioskDeviceId: device._id },
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
 * Walk-in with the published form. Same outcome as `kioskVisitor.registerWalkIn`
 * (an `expected` visit awaiting admission), plus a `formResponses` row that
 * permanently references the version answered. The submitted version must be
 * the one currently served, so a stale screen cannot post to an old form.
 */
export const submitWalkIn = kioskMutation({
  args: { hostUserId: v.id("users"), versionId: v.id("formVersions"), answers: vRawAnswers },
  handler: async (ctx, args) => {
    const { org, site, gate, device } = ctx.kiosk;
    const active = await resolveActiveForm(ctx, org._id, site._id, "visitor");
    if (!active || active.version._id !== args.versionId) {
      throw appError("CONFLICT", "This form was updated. Please start again.");
    }
    await assertHost(ctx, org._id, args.hostUserId, site._id);
    const { answers, fileIds } = await checkAnswers(ctx, org, active.version, args.answers, {
      kioskDeviceId: device._id,
    });
    const mapped = mappedValues(fieldsOf(active.version), answers as Answers);
    const data = parseOrThrow(kioskWalkInSchema, {
      name: mapped["visitor.name"],
      phone: mapped["visitor.phone"],
      company: mapped["visitor.company"],
      purpose: mapped["visit.purpose"],
    });
    const visitorId = await upsertVisitor(
      ctx,
      org._id,
      { name: data.name, phone: data.phone, company: data.company, email: mapped["visitor.email"] },
      { updateExisting: false },
    );
    const visitId = await registerVisit(
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
    await storeResponse(ctx, {
      org,
      siteId: site._id,
      form: active.form,
      version: active.version,
      answers,
      fileIds,
      visitId,
      actor: { kioskDeviceId: device._id },
    });
    return {
      status: "ok" as const,
      firstName: firstName(data.name),
      hostName: (await ctx.db.get(args.hostUserId))?.name ?? "your host",
    };
  },
});
