import { describe, expect, test } from "vitest";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { PIN_MAX_FAILURES } from "../../convex/lib/pin";
import { formsSetup, visitorFields, type FormsSetup } from "./formsSetup";
import { addMember, expectCode, newTest, type T } from "./setup";

const PIN = "4829";
const NUMBER = "S100";
const DECLARATION = "I declare that I am fit for work today.";

const declarationFields = () => [
  { id: "fit", type: "yes_no", label: "Fit for work?", required: true, sensitive: false },
  { id: "symptoms", type: "multi_choice", label: "Symptoms", required: false, sensitive: true, options: ["Cough", "Fever", "None"] },
  { id: "note", type: "long_text", label: "Shift note", required: false, sensitive: false },
  { id: "declare", type: "consent", label: "Declaration", required: true, sensitive: false, consentText: DECLARATION },
];
const GOOD = { fit: true, symptoms: ["None"], note: "All good", declare: { accepted: true, text: DECLARATION } };

async function setup(t: T) {
  const s = await formsSetup(t);
  const staff = await addMember(t, s.organizationId, "acme-sam", "staff");
  const membership = await t.run((ctx) =>
    ctx.db
      .query("memberships")
      .withIndex("by_org_user", (q) => q.eq("organizationId", s.organizationId).eq("userId", staff.userId))
      .unique(),
  );
  await s.admin.as.mutation(api.attendancePins.setStaffNumber, {
    ...s.orgArg,
    membershipId: membership!._id,
    staffNumber: NUMBER,
  });
  await staff.as.mutation(api.attendancePins.setMyPin, { ...s.orgArg, pin: PIN });
  async function staffForm(fields: object[] = declarationFields(), extra: { siteId?: Id<"sites">; name?: string } = {}) {
    const formId = await s.owner.as.mutation(api.forms.create, {
      ...s.orgArg,
      name: extra.name ?? "Daily declaration",
      audience: "staff",
      siteId: extra.siteId,
      fields: fields as never,
    });
    const versionId = await s.owner.as.mutation(api.forms.publish, { ...s.orgArg, formId });
    return { formId, versionId };
  }
  return { ...s, staff, staffForm };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const cred = { staffNumber: NUMBER, pin: PIN };
const events = (t: T) => t.run((ctx) => ctx.db.query("attendanceEvents").collect());
const responses = (t: T) => t.run((ctx) => ctx.db.query("formResponses").collect());
const record = (t: T, s: Setup, extra: object = {}, type: "clock_in" | "clock_out" = "clock_in") =>
  t.mutation(api.kioskAttendance.record, { ...s.k, ...cred, type, ...extra } as never);

describe("publishing staff forms", () => {
  test("a staff form needs no visitor mappings and publishes", async () => {
    const t = newTest();
    const s = await setup(t);
    const { versionId } = await s.staffForm();
    expect(versionId).toBeTruthy();
    const list = await s.owner.as.query(api.forms.list, s.orgArg);
    expect(list.find((f) => f.audience === "staff")).toMatchObject({ status: "published", publishedVersion: 1 });
  });

  test("visit mappings and file-like fields are refused for staff forms", async () => {
    const t = newTest();
    const s = await setup(t);
    const mapped = await s.owner.as.mutation(api.forms.create, {
      ...s.orgArg,
      name: "Bad",
      audience: "staff",
      fields: [{ id: "n", type: "short_text", label: "Name", required: true, sensitive: false, mapsTo: "visitor.name" }] as never,
    });
    await expectCode(s.owner.as.mutation(api.forms.publish, { ...s.orgArg, formId: mapped }), "VALIDATION");
    for (const type of ["signature", "file_upload", "photo", "id_scan"]) {
      const f = await s.owner.as.mutation(api.forms.create, {
        ...s.orgArg,
        name: `Bad ${type}`,
        audience: "staff",
        fields: [{ id: "x", type, label: "File", required: false, sensitive: false }] as never,
      });
      await expectCode(s.owner.as.mutation(api.forms.publish, { ...s.orgArg, formId: f }), "VALIDATION");
    }
  });

  test("visitor forms still need their mappings", async () => {
    const t = newTest();
    const s = await setup(t);
    const f = await s.owner.as.mutation(api.forms.create, {
      ...s.orgArg,
      name: "Visitor form",
      audience: "visitor",
      fields: declarationFields() as never,
    });
    await expectCode(s.owner.as.mutation(api.forms.publish, { ...s.orgArg, formId: f }), "VALIDATION");
    expect(visitorFields().length).toBeGreaterThan(0);
  });

  test("a staff form is never served to visitors", async () => {
    const t = newTest();
    const s = await setup(t);
    await s.staffForm();
    expect(await s.activeForm()).toBeNull();
  });
});

describe("kiosk clock-in with a staff form", () => {
  test("with no staff form published, clock-in works exactly as before", async () => {
    const t = newTest();
    const s = await setup(t);
    const id = await t.mutation(api.kioskAttendance.identify, { ...s.k, ...cred });
    expect(id).toMatchObject({ ok: true, status: "out", form: null });
    expect(await record(t, s)).toMatchObject({ ok: true, outcome: "recorded" });
    expect(await events(t)).toHaveLength(1);
    expect(await responses(t)).toHaveLength(0);
  });

  test("identify hands out the form only after the PIN, and only when a clock-in is possible", async () => {
    const t = newTest();
    const s = await setup(t);
    const { versionId } = await s.staffForm();
    const id = await t.mutation(api.kioskAttendance.identify, { ...s.k, ...cred });
    if (!id.ok) throw new Error("identify failed");
    expect(id.form).toMatchObject({ versionId, version: 1, name: "Daily declaration" });
    expect(id.form!.fields.map((f) => f.id)).toEqual(["fit", "symptoms", "note", "declare"]);
    // A wrong PIN gets the generic failure and no form.
    const bad = await t.mutation(api.kioskAttendance.identify, { ...s.k, staffNumber: NUMBER, pin: "9999" });
    expect(bad).toEqual({ ok: false });
    // Already clocked in: nothing to answer.
    await record(t, s, { versionId, answers: GOOD });
    const again = await t.mutation(api.kioskAttendance.identify, { ...s.k, ...cred });
    expect(again).toMatchObject({ ok: true, status: "in", form: null });
  });

  test("clock-in is refused until the form is answered; nothing is recorded", async () => {
    const t = newTest();
    const s = await setup(t);
    await s.staffForm();
    expect(await record(t, s)).toMatchObject({ ok: true, outcome: "form_required" });
    expect(await events(t)).toHaveLength(0);
    expect(await responses(t)).toHaveLength(0);
  });

  test("invalid answers are returned (not thrown), with a message and no event", async () => {
    const t = newTest();
    const s = await setup(t);
    const { versionId } = await s.staffForm();
    const missing = await record(t, s, { versionId, answers: { note: "hi" } });
    expect(missing).toMatchObject({ ok: true, outcome: "form_invalid", message: expect.stringContaining("Fit for work?") });
    const wrongConsent = await record(t, s, { versionId, answers: { ...GOOD, declare: { accepted: true, text: "other" } } });
    expect(wrongConsent).toMatchObject({ outcome: "form_invalid" });
    const unknown = await record(t, s, { versionId, answers: { ...GOOD, extra: "x" } });
    expect(unknown).toMatchObject({ outcome: "form_invalid" });
    // File answers are impossible: there is no upload path for staff forms.
    const file = await record(t, s, { versionId, answers: { ...GOOD, note: { fileId: "abc" } } });
    expect(file).toMatchObject({ outcome: "form_invalid" });
    expect(await events(t)).toHaveLength(0);
    expect(await responses(t)).toHaveLength(0);
  });

  test("a stale version is refused", async () => {
    const t = newTest();
    const s = await setup(t);
    const { formId, versionId } = await s.staffForm();
    await s.owner.as.mutation(api.forms.publish, { ...s.orgArg, formId });
    expect(await record(t, s, { versionId, answers: GOOD })).toMatchObject({ outcome: "form_stale" });
    expect(await events(t)).toHaveLength(0);
  });

  test("valid answers record the clock-in and a response tied to the person, the event and the version", async () => {
    const t = newTest();
    const s = await setup(t);
    const { formId, versionId } = await s.staffForm();
    expect(await record(t, s, { versionId, answers: GOOD })).toMatchObject({ ok: true, outcome: "recorded" });
    const [event] = await events(t);
    const [response] = await responses(t);
    expect(event).toMatchObject({ type: "clock_in", source: "kiosk", userId: s.staff.userId });
    expect(response).toMatchObject({
      formId,
      formVersionId: versionId,
      userId: s.staff.userId,
      attendanceEventId: event!._id,
      siteId: s.siteId,
    });
    expect(response!.visitId).toBeUndefined();
    expect(response!.answers).toMatchObject({ fit: true, note: "All good", symptoms: ["None"] });
    // Audited against the device, never the PIN.
    const log = (await t.run((ctx) => ctx.db.query("auditLogs").collect())).find((a) => a.action === "form_response.created");
    expect(log).toMatchObject({ kioskDeviceId: s.deviceId, resourceId: response!._id });
    expect(JSON.stringify(log)).not.toContain(PIN);
  });

  test("clock-out and already-in cases never ask for the form", async () => {
    const t = newTest();
    const s = await setup(t);
    const { versionId } = await s.staffForm();
    await record(t, s, { versionId, answers: GOOD });
    expect(await record(t, s, {})).toMatchObject({ outcome: "already_in" });
    expect(await record(t, s, {}, "clock_out")).toMatchObject({ outcome: "recorded" });
    expect(await responses(t)).toHaveLength(1);
  });

  test("the PIN is checked on every call, so a form cannot be submitted without it", async () => {
    const t = newTest();
    const s = await setup(t);
    const { versionId } = await s.staffForm();
    const res = await t.mutation(api.kioskAttendance.record, {
      ...s.k,
      staffNumber: NUMBER,
      pin: "1357",
      type: "clock_in",
      versionId,
      answers: GOOD,
    } as never);
    expect(res).toEqual({ ok: false });
    expect(await events(t)).toHaveLength(0);
    expect(await responses(t)).toHaveLength(0);
    // The wrong guesses still count towards the lockout, and a locked person gets the same generic result.
    for (let i = 1; i < PIN_MAX_FAILURES; i++) {
      await t.mutation(api.kioskAttendance.record, {
        ...s.k,
        staffNumber: NUMBER,
        pin: "1357",
        type: "clock_in",
        versionId,
        answers: GOOD,
      } as never);
    }
    expect(await record(t, s, { versionId, answers: GOOD })).toEqual({ ok: false });
    expect(await events(t)).toHaveLength(0);
  });

  test("a device token is required", async () => {
    const t = newTest();
    const s = await setup(t);
    const { versionId } = await s.staffForm();
    await expectCode(
      t.mutation(api.kioskAttendance.record, { slug: "acme", token: "wk_nope", ...cred, type: "clock_in", versionId, answers: GOOD } as never),
      "NOT_FOUND",
    );
  });

  test("a form for another site does not apply; the site-specific form beats an org-wide one", async () => {
    const t = newTest();
    const s = await setup(t);
    const branch = await s.owner.as.mutation(api.sites.create, { ...s.orgArg, name: "Branch", timeZone: "Africa/Nairobi" });
    await s.staffForm(undefined, { siteId: branch, name: "Branch declaration" });
    expect(await record(t, s)).toMatchObject({ outcome: "recorded" });
    await record(t, s, {}, "clock_out");

    const here = await s.staffForm(undefined, { siteId: s.siteId, name: "Here" });
    const id = await t.mutation(api.kioskAttendance.identify, { ...s.k, ...cred });
    if (!id.ok) throw new Error("identify failed");
    expect(id.form).toMatchObject({ versionId: here.versionId, name: "Here" });
  });
});

describe("signed-in clock-in with a staff form", () => {
  test("activeStaffForm shows the form for the site; none when nothing is published", async () => {
    const t = newTest();
    const s = await setup(t);
    const args = { ...s.orgArg, siteId: s.siteId };
    expect(await s.staff.as.query(api.attendance.activeStaffForm, args)).toBeNull();
    const { versionId } = await s.staffForm();
    expect(await s.staff.as.query(api.attendance.activeStaffForm, args)).toMatchObject({ versionId, name: "Daily declaration" });
  });

  test("clock-in needs the answers when a form is published, and stores them with the event", async () => {
    const t = newTest();
    const s = await setup(t);
    const { versionId } = await s.staffForm();
    const args = { ...s.orgArg, siteId: s.siteId };
    await expectCode(s.staff.as.mutation(api.attendance.clockIn, args), "VALIDATION");
    await expectCode(
      s.staff.as.mutation(api.attendance.clockIn, { ...args, form: { versionId, answers: { note: "x" } } }),
      "VALIDATION",
    );
    expect(await events(t)).toHaveLength(0);
    const eventId = await s.staff.as.mutation(api.attendance.clockIn, { ...args, form: { versionId, answers: GOOD } });
    const [response] = await responses(t);
    expect(response).toMatchObject({ userId: s.staff.userId, attendanceEventId: eventId, formVersionId: versionId });
    expect((await events(t))[0]).toMatchObject({ source: "app", type: "clock_in" });
    // Audited as the person.
    const log = (await t.run((ctx) => ctx.db.query("auditLogs").collect())).find((a) => a.action === "form_response.created");
    expect(log).toMatchObject({ actorUserId: s.staff.userId });
  });

  test("a stale version or a form sent when none exists is a CONFLICT", async () => {
    const t = newTest();
    const s = await setup(t);
    const args = { ...s.orgArg, siteId: s.siteId };
    const { formId, versionId } = await s.staffForm();
    await s.owner.as.mutation(api.forms.publish, { ...s.orgArg, formId });
    await expectCode(s.staff.as.mutation(api.attendance.clockIn, { ...args, form: { versionId, answers: GOOD } }), "CONFLICT");
    await s.owner.as.mutation(api.forms.archive, { ...s.orgArg, formId });
    await expectCode(s.staff.as.mutation(api.attendance.clockIn, { ...args, form: { versionId, answers: GOOD } }), "CONFLICT");
    // With nothing published, plain clock-in still works.
    await s.staff.as.mutation(api.attendance.clockIn, args);
    expect(await events(t)).toHaveLength(1);
  });

  test("a double clock-in is refused before any form is stored", async () => {
    const t = newTest();
    const s = await setup(t);
    const { versionId } = await s.staffForm();
    const args = { ...s.orgArg, siteId: s.siteId, form: { versionId, answers: GOOD } };
    await s.staff.as.mutation(api.attendance.clockIn, args);
    await expectCode(s.staff.as.mutation(api.attendance.clockIn, args), "CONFLICT");
    expect(await responses(t)).toHaveLength(1);
  });

  test("clocking in on behalf of someone is not blocked by the form (it is the person's own declaration)", async () => {
    const t = newTest();
    const s = await setup(t);
    await s.staffForm();
    await s.reception.as.mutation(api.attendance.recordOnBehalf, {
      ...s.orgArg,
      siteId: s.siteId,
      userId: s.staff.userId,
      type: "clock_in",
    } as never);
    expect(await events(t)).toHaveLength(1);
    expect(await responses(t)).toHaveLength(0);
  });
});

describe("reading staff responses", () => {
  async function withResponse(t: T) {
    const s = await setup(t);
    const { versionId } = await s.staffForm();
    await record(t, s, { versionId, answers: GOOD });
    const [response] = await responses(t);
    return { s, responseId: response!._id };
  }
  const seeFor = (s: Setup, who: "owner" | "admin" | "reception" | "staff" | "host") => s[who].as;

  test("the person and managers can list them; sensitive values are withheld", async () => {
    const t = newTest();
    const { s } = await withResponse(t);
    for (const who of ["owner", "admin", "reception"] as const) {
      const list = await seeFor(s, who).query(api.forms.staffResponses, { ...s.orgArg, userId: s.staff.userId });
      expect(list, who).toHaveLength(1);
      expect(list[0]).toMatchObject({ formName: "Daily declaration", version: 1 });
      const items = Object.fromEntries(list[0]!.items.map((i) => [i.id, i]));
      expect(items.fit).toMatchObject({ value: "Yes", sensitive: false });
      expect(items.symptoms).toEqual({ id: "symptoms", label: "Symptoms", type: "multi_choice", sensitive: true });
      expect(JSON.stringify(list)).not.toContain("Cough");
      expect(JSON.stringify(list)).not.toContain("None");
    }
    const own = await s.staff.as.query(api.forms.staffResponses, { ...s.orgArg, userId: s.staff.userId });
    expect(own).toHaveLength(1);
  });

  test("other staff and hosts cannot read someone else's responses", async () => {
    const t = newTest();
    const { s } = await withResponse(t);
    const other = await addMember(t, s.organizationId, "acme-sue", "staff");
    await expectCode(other.as.query(api.forms.staffResponses, { ...s.orgArg, userId: s.staff.userId }), "FORBIDDEN");
    await expectCode(s.host.as.query(api.forms.staffResponses, { ...s.orgArg, userId: s.staff.userId }), "FORBIDDEN");
    // A manager with access to a different site only sees nothing from this one.
    const branch = await s.owner.as.mutation(api.sites.create, { ...s.orgArg, name: "Branch", timeZone: "Africa/Nairobi" });
    const regional = await addMember(t, s.organizationId, "acme-ray", "admin", [branch]);
    expect(await regional.as.query(api.forms.staffResponses, { ...s.orgArg, userId: s.staff.userId })).toEqual([]);
  });

  test("sensitive answers need forms:read_sensitive, and every reveal is audited", async () => {
    const t = newTest();
    const { s, responseId } = await withResponse(t);
    // Reception may see the list but not the sensitive values.
    await expectCode(s.reception.as.mutation(api.forms.revealSensitive, { ...s.orgArg, responseId }), "FORBIDDEN");
    const items = await s.admin.as.mutation(api.forms.revealSensitive, { ...s.orgArg, responseId });
    expect(items).toEqual([{ id: "symptoms", label: "Symptoms", type: "multi_choice", value: "None" }]);
    const reads = (await t.run((ctx) => ctx.db.query("auditLogs").collect())).filter((a) => a.action === "form_response.sensitive_read");
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ actorUserId: s.admin.userId, resourceId: responseId, metadata: { fields: "symptoms", count: 1 } });
    expect(JSON.stringify(reads[0])).not.toContain("None");
  });

  test("another organization cannot read or reveal them", async () => {
    const t = newTest();
    const { s, responseId } = await withResponse(t);
    const other = await formsSetup(t, "beta");
    await expectCode(
      other.owner.as.mutation(api.forms.revealSensitive, { organizationId: other.organizationId, responseId }),
      "NOT_FOUND",
    );
    const list = await other.owner.as.query(api.forms.staffResponses, { organizationId: other.organizationId, userId: s.staff.userId });
    expect(list).toEqual([]);
  });
});

export type { FormsSetup };
