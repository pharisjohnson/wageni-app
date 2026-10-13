import { describe, expect, test } from "vitest";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { LOOKUP_MAX_FAILURES } from "../../convex/lib/kioskLookup";
import { CONSENT, formsSetup, visitorFields, type FormsSetup } from "./formsSetup";
import { expectCode, newTest, type T } from "./setup";

const HOUR = 60 * 60 * 1000;
const PHONE = "+254700111222";

/** An approved appointment today at the kiosk's site, for a visitor with a full record. */
async function appointment(
  t: T,
  s: FormsSetup,
  opts: { phone?: string; siteId?: Id<"sites">; email?: string; company?: string } = {},
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const visitorId = await ctx.db.insert("visitors", {
      organizationId: s.organizationId,
      name: "Jane Visitor",
      phone: opts.phone ?? PHONE,
      email: opts.email,
      company: opts.company,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.insert("appointments", {
      organizationId: s.organizationId,
      siteId: opts.siteId ?? s.siteId,
      visitorId,
      hostUserId: s.host.userId,
      purpose: "Contract talks",
      scheduledStart: now,
      scheduledEnd: now + HOUR,
      status: "approved",
      createdBy: s.host.userId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

const visits = (t: T) => t.run(async (ctx) => ctx.db.query("visits").collect());
const responses = (t: T) => t.run(async (ctx) => ctx.db.query("formResponses").collect());

describe("with no published visitor form", () => {
  test("behaviour is unchanged: the form step says no_form and plain check-in works", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const appointmentId = await appointment(t, s);
    expect(await t.mutation(api.kioskForms.formForAppointment, { ...s.k, appointmentId, phone: PHONE })).toEqual({
      status: "no_form",
    });
    const done = await t.mutation(api.kioskVisitor.checkInAppointment, { ...s.k, appointmentId, phone: PHONE });
    expect(done).toMatchObject({ status: "ok", firstName: "Jane" });
    expect(await visits(t)).toHaveLength(1);
    expect(await responses(t)).toHaveLength(0);
  });
});

describe("with a published visitor form", () => {
  test("plain check-in is closed: the visit is not created until the form is answered", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    await s.publishedForm();
    const appointmentId = await appointment(t, s);
    expect(await t.mutation(api.kioskVisitor.checkInAppointment, { ...s.k, appointmentId, phone: PHONE })).toEqual({
      status: "form_required",
    });
    expect(await visits(t)).toHaveLength(0);
  });

  test("the form step needs the phone, shares the failure throttle and leaks nothing on a miss", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    await s.publishedForm();
    const appointmentId = await appointment(t, s);
    const miss = await t.mutation(api.kioskForms.formForAppointment, { ...s.k, appointmentId, phone: "0799999999" });
    expect(miss).toEqual({ status: "no_match" });
    for (let i = 0; i < LOOKUP_MAX_FAILURES; i++) {
      await t.mutation(api.kioskForms.formForAppointment, { ...s.k, appointmentId, phone: "0799999999" });
    }
    // Locked even for the right phone, same as the other lookups on this device.
    expect(await t.mutation(api.kioskForms.formForAppointment, { ...s.k, appointmentId, phone: PHONE })).toEqual({
      status: "locked",
    });
    expect(
      await t.mutation(api.kioskVisitor.findAppointments, { ...s.k, phone: PHONE }),
    ).toEqual({ status: "locked" });
  });

  test("a device token is required for the new functions", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const { versionId } = await s.publishedForm();
    const appointmentId = await appointment(t, s);
    for (const k of [{ slug: "acme", token: "" }, { slug: "acme", token: "wk_nope" }]) {
      await expectCode(t.mutation(api.kioskForms.formForAppointment, { ...k, appointmentId, phone: PHONE }), "NOT_FOUND");
      await expectCode(
        t.mutation(api.kioskForms.checkInAppointmentWithForm, { ...k, appointmentId, phone: PHONE, versionId, answers: {} }),
        "NOT_FOUND",
      );
    }
  });

  test("fields known from the appointment are filled server side and not asked again", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const { versionId } = await s.publishedForm();
    const appointmentId = await appointment(t, s);
    const step = await t.mutation(api.kioskForms.formForAppointment, { ...s.k, appointmentId, phone: PHONE });
    if (step.status !== "form") throw new Error("expected a form");
    expect(step.versionId).toBe(versionId);
    // name, phone and purpose are known; company is not on the visitor record.
    expect(step.prefilledFieldIds.sort()).toEqual(["name", "phone", "purpose"]);
    // The values themselves never travel to the screen.
    const json = JSON.stringify(step);
    for (const secret of ["Jane Visitor", "Contract talks", PHONE]) expect(json).not.toContain(secret);
  });

  test("a stored value the field would reject is asked for instead of blocking the visitor", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    await s.publishedForm();
    const appointmentId = await appointment(t, s);
    await t.run(async (ctx) => {
      const appt = (await ctx.db.get(appointmentId))!;
      await ctx.db.patch(appt.visitorId, { email: "not-an-email" });
    });
    // No email-mapped field in this form, so nothing changes; map one and check it is not prefilled.
    const fields = visitorFields();
    fields.push({ id: "mail", type: "email", label: "Email", required: false, sensitive: false, mapsTo: "visitor.email" });
    const t2 = newTest();
    const s2 = await formsSetup(t2);
    await s2.publishedForm(fields);
    const a2 = await appointment(t2, s2, { email: "not-an-email" });
    const step = await t2.mutation(api.kioskForms.formForAppointment, { ...s2.k, appointmentId: a2, phone: PHONE });
    if (step.status !== "form") throw new Error("expected a form");
    expect(step.prefilledFieldIds).not.toContain("mail");
    expect(step.prefilledFieldIds).toContain("name");
  });

  test("answers are validated, the visit is created, and the response keeps visit, appointment and version", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const { formId, versionId } = await s.publishedForm();
    const appointmentId = await appointment(t, s);
    const done = await t.mutation(api.kioskForms.checkInAppointmentWithForm, {
      ...s.k,
      appointmentId,
      phone: "0700 111 222",
      versionId,
      answers: { consent: { accepted: true, text: CONSENT }, contact: "Phone" },
    });
    expect(done).toEqual({ status: "ok", firstName: "Jane", hostName: "acme-hana", badgeCode: expect.stringMatching(/^\d{6}$/) });
    const [visit] = await visits(t);
    expect(visit).toMatchObject({ status: "on_site", appointmentId });
    const [response] = await responses(t);
    expect(response).toMatchObject({ formId, formVersionId: versionId, visitId: visit!._id, appointmentId });
    expect(response!.userId).toBeUndefined();
    // Known details were stored with the response, as walk-ins' mapped fields are.
    expect(response!.answers).toMatchObject({
      name: "Jane Visitor",
      phone: PHONE,
      purpose: "Contract talks",
      contact: "Phone",
      consent: { accepted: true, text: CONSENT },
    });
    // Audited against the device, like other kiosk actions.
    const log = (await t.run(async (ctx) => ctx.db.query("auditLogs").collect())).find((a) => a.action === "form_response.created");
    expect(log).toMatchObject({ kioskDeviceId: s.deviceId, resourceId: response!._id });
    // The appointment is checked in, so it cannot be used again.
    expect(await t.mutation(api.kioskForms.formForAppointment, { ...s.k, appointmentId, phone: PHONE })).toEqual({ status: "no_match" });
  });

  test("the saved responses show on the visit detail like walk-ins' do", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const { versionId } = await s.publishedForm();
    const appointmentId = await appointment(t, s);
    await t.mutation(api.kioskForms.checkInAppointmentWithForm, {
      ...s.k,
      appointmentId,
      phone: PHONE,
      versionId,
      answers: { consent: { accepted: true, text: CONSENT } },
    });
    const [visit] = await visits(t);
    const list = await s.reception.as.query(api.forms.visitResponses, { ...s.orgArg, visitId: visit!._id });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ formName: "Visitor registration", version: 1 });
    const byId = Object.fromEntries(list[0]!.items.map((i) => [i.id, i]));
    expect(byId.purpose).toMatchObject({ value: "Contract talks" });
    // The ID number field is sensitive, so its value is not in the query result.
    expect(JSON.stringify(list)).not.toContain("id_number\":\"");
  });

  test("invalid answers stop the check-in: no visit, no response", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const { versionId } = await s.publishedForm();
    const appointmentId = await appointment(t, s);
    const base = { ...s.k, appointmentId, phone: PHONE, versionId };
    // Consent is required.
    await expectCode(t.mutation(api.kioskForms.checkInAppointmentWithForm, { ...base, answers: {} }), "VALIDATION");
    // Wrong consent text.
    await expectCode(
      t.mutation(api.kioskForms.checkInAppointmentWithForm, { ...base, answers: { consent: { accepted: true, text: "other" } } }),
      "VALIDATION",
    );
    // Unknown field.
    await expectCode(
      t.mutation(api.kioskForms.checkInAppointmentWithForm, {
        ...base,
        answers: { consent: { accepted: true, text: CONSENT }, hack: "x" },
      }),
      "VALIDATION",
    );
    // Conditional field required once its trigger is chosen.
    await expectCode(
      t.mutation(api.kioskForms.checkInAppointmentWithForm, {
        ...base,
        answers: { consent: { accepted: true, text: CONSENT }, contact: "Email" },
      }),
      "VALIDATION",
    );
    expect(await visits(t)).toHaveLength(0);
    expect(await responses(t)).toHaveLength(0);
    expect((await t.run(async (ctx) => ctx.db.get(appointmentId)))!.status).toBe("approved");
  });

  test("what the screen sends for a prefilled field is ignored in favour of the appointment's own details", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const { versionId } = await s.publishedForm();
    const appointmentId = await appointment(t, s);
    await t.mutation(api.kioskForms.checkInAppointmentWithForm, {
      ...s.k,
      appointmentId,
      phone: PHONE,
      versionId,
      answers: { consent: { accepted: true, text: CONSENT }, name: "Mallory", purpose: "Heist" },
    });
    const [response] = await responses(t);
    expect(response!.answers).toMatchObject({ name: "Jane Visitor", purpose: "Contract talks" });
  });

  test("a stale form version is refused", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const { formId, versionId } = await s.publishedForm();
    const appointmentId = await appointment(t, s);
    await s.owner.as.mutation(api.forms.publish, { ...s.orgArg, formId });
    await expectCode(
      t.mutation(api.kioskForms.checkInAppointmentWithForm, {
        ...s.k,
        appointmentId,
        phone: PHONE,
        versionId,
        answers: { consent: { accepted: true, text: CONSENT } },
      }),
      "CONFLICT",
    );
    expect(await visits(t)).toHaveLength(0);
  });

  test("the phone is verified again: an appointment id alone is not enough", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const { versionId } = await s.publishedForm();
    const appointmentId = await appointment(t, s);
    const res = await t.mutation(api.kioskForms.checkInAppointmentWithForm, {
      ...s.k,
      appointmentId,
      phone: "0711000000",
      versionId,
      answers: { consent: { accepted: true, text: CONSENT } },
    });
    expect(res).toEqual({ status: "no_match" });
    expect(await visits(t)).toHaveLength(0);
  });

  test("a visitor who already answered through their invitation link is not asked again", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const { formId, versionId } = await s.publishedForm();
    const appointmentId = await appointment(t, s);
    await t.run(async (ctx) =>
      ctx.db.insert("formResponses", {
        organizationId: s.organizationId,
        siteId: s.siteId,
        formId,
        formVersionId: versionId,
        appointmentId,
        answers: { name: "Jane Visitor" },
        createdAt: Date.now(),
      }),
    );
    expect(await t.mutation(api.kioskForms.formForAppointment, { ...s.k, appointmentId, phone: PHONE })).toEqual({ status: "no_form" });
    const done = await t.mutation(api.kioskVisitor.checkInAppointment, { ...s.k, appointmentId, phone: PHONE });
    expect(done.status).toBe("ok");
    // The old response is reachable from the new visit through the appointment.
    const [visit] = await visits(t);
    const list = await s.reception.as.query(api.forms.visitResponses, { ...s.orgArg, visitId: visit!._id });
    expect(list).toHaveLength(1);
  });

  test("a form for another site does not apply here, and a site-specific form wins over an org-wide one", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const other = await s.owner.as.mutation(api.sites.create, { ...s.orgArg, name: "Branch", timeZone: "Africa/Nairobi" });
    await s.publishedForm(undefined, { siteId: other, name: "Branch only" });
    const appointmentId = await appointment(t, s);
    // Only the branch has a form, so this site behaves as before.
    expect(await t.mutation(api.kioskForms.formForAppointment, { ...s.k, appointmentId, phone: PHONE })).toEqual({ status: "no_form" });
    expect((await t.mutation(api.kioskVisitor.checkInAppointment, { ...s.k, appointmentId, phone: PHONE })).status).toBe("ok");

    const t2 = newTest();
    const s2 = await formsSetup(t2);
    await s2.publishedForm(undefined, { name: "Everywhere" });
    const local = await s2.publishedForm(undefined, { siteId: s2.siteId, name: "This site" });
    const appt2 = await appointment(t2, s2);
    const step = await t2.mutation(api.kioskForms.formForAppointment, { ...s2.k, appointmentId: appt2, phone: PHONE });
    if (step.status !== "form") throw new Error("expected a form");
    expect(step.versionId).toBe(local.versionId);
    expect(step.name).toBe("This site");
  });

  test("a staff form never shows up at the visitor desk", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const staffForm = await s.owner.as.mutation(api.forms.create, {
      ...s.orgArg,
      name: "Staff",
      audience: "staff",
      fields: [{ id: "fit", type: "yes_no", label: "Fit?", required: true, sensitive: false }] as never,
    });
    await s.owner.as.mutation(api.forms.publish, { ...s.orgArg, formId: staffForm });
    const appointmentId = await appointment(t, s);
    expect(await t.mutation(api.kioskForms.formForAppointment, { ...s.k, appointmentId, phone: PHONE })).toEqual({ status: "no_form" });
    expect(await s.activeForm()).toBeNull();
  });

  test("another organization's kiosk cannot reach this appointment", async () => {
    const t = newTest();
    const a = await formsSetup(t, "acme");
    const b = await formsSetup(t, "beta");
    await a.publishedForm();
    const appointmentId = await appointment(t, a);
    expect(await t.mutation(api.kioskForms.formForAppointment, { ...b.k, appointmentId, phone: PHONE })).toEqual({ status: "no_match" });
  });
});
