import { v } from "convex/values";
import { kioskWalkInSchema } from "../lib/validation/visits";
import { mappedValues, type Answers } from "../lib/validation/forms";
import { kioskMutation, kioskQuery } from "./lib/kiosk";
import { checkAnswers, fieldsOf, resolveActiveForm, servedFields, storeResponse } from "./lib/formResponses";
import { faceCaptureEnabled } from "./lib/policy";
import { appError } from "./lib/errors";
import { parseOrThrow } from "./lib/validate";
import { assertHost, upsertVisitor } from "./lib/visitors";
import { registerVisit } from "./lib/visits";
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
