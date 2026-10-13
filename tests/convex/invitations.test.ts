import { describe, expect, test } from "vitest";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { registerUpload } from "../../convex/lib/files";
import { CONSENT, formsSetup, type FormsSetup } from "./formsSetup";
import { addMember, expectCode, newTest } from "./setup";

const HOUR = 60 * 60 * 1000;
const DETAILS = { name: "Ivy Invitee", phone: "+254722333444", email: "ivy@example.com" };
const UNAVAILABLE = { status: "unavailable" };

async function invite(s: FormsSetup, who: "owner" | "reception" | "host" = "reception", over: object = {}) {
  const res = await s[who].as.mutation(api.invitations.create, {
    ...s.orgArg,
    siteId: s.siteId,
    hostUserId: s.host.userId,
    visitorName: "Ivy",
    purpose: "Project kickoff",
    scheduledStart: Date.now() + 60_000,
    scheduledEnd: Date.now() + HOUR,
    ...over,
  });
  return res;
}

describe("creating invitations", () => {
  test("needs appointments:create; hosts invite for themselves only; the link carries the token once", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const guard = await addMember(t, s.organizationId, "acme-gus", "guard");
    await expectCode(
      guard.as.mutation(api.invitations.create, {
        ...s.orgArg,
        siteId: s.siteId,
        hostUserId: s.host.userId,
        purpose: "x1",
        scheduledStart: Date.now() + 1000,
        scheduledEnd: Date.now() + HOUR,
      }),
      "FORBIDDEN",
    );
    const mine = await invite(s, "host");
    expect(mine.path).toBe(`/invite/${mine.token}`);
    expect(mine.token.startsWith("wi_")).toBe(true);
    const other = await addMember(t, s.organizationId, "acme-hugh", "host");
    await expectCode(
      other.as.mutation(api.invitations.create, {
        ...s.orgArg,
        siteId: s.siteId,
        hostUserId: s.host.userId,
        purpose: "Not mine",
        scheduledStart: Date.now() + 1000,
        scheduledEnd: Date.now() + HOUR,
      }),
      "FORBIDDEN",
    );
    // Reception can invite on behalf of a host.
    await invite(s, "reception");
  });

  test("only a hash is stored; list never returns it; past times are refused", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const { token } = await invite(s);
    const rows = await t.run(async (ctx) => ctx.db.query("invitations").collect());
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    const list = await s.reception.as.query(api.invitations.list, s.orgArg);
    expect(JSON.stringify(list)).not.toContain("tokenHash");
    expect(JSON.stringify(list)).not.toContain(token);
    expect(list[0]).toMatchObject({ status: "pending", purpose: "Project kickoff" });
    await expectCode(
      s.reception.as.mutation(api.invitations.create, {
        ...s.orgArg,
        siteId: s.siteId,
        hostUserId: s.host.userId,
        purpose: "Past",
        scheduledStart: Date.now() - 2 * HOUR,
        scheduledEnd: Date.now() - HOUR,
      }),
      "VALIDATION",
    );
  });

  test("tenant isolation: another organization's site and host are refused; lists are separate", async () => {
    const t = newTest();
    const a = await formsSetup(t, "acme");
    const b = await formsSetup(t, "beta");
    await expectCode(
      b.owner.as.mutation(api.invitations.create, {
        ...b.orgArg,
        siteId: a.siteId,
        hostUserId: b.host.userId,
        purpose: "Cross tenant",
        scheduledStart: Date.now() + 1000,
        scheduledEnd: Date.now() + HOUR,
      }),
      "NOT_FOUND",
    );
    await expectCode(
      b.owner.as.mutation(api.invitations.create, {
        ...b.orgArg,
        siteId: b.siteId,
        hostUserId: a.host.userId,
        purpose: "Foreign host",
        scheduledStart: Date.now() + 1000,
        scheduledEnd: Date.now() + HOUR,
      }),
      "VALIDATION",
    );
    await invite(a);
    expect(await b.owner.as.query(api.invitations.list, b.orgArg)).toEqual([]);
    const { invitationId } = await invite(a);
    await expectCode(b.owner.as.mutation(api.invitations.cancel, { ...b.orgArg, invitationId }), "NOT_FOUND");
  });
});

describe("public invitation page", () => {
  test("a valid token shows the invitation; every kind of failure looks the same", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const { token, invitationId } = await invite(s);
    const view = await t.query(api.invitations.lookup, { token });
    expect(view).toMatchObject({ status: "ok", hostName: "acme-hana", purpose: "Project kickoff", form: null });
    // The public view never includes ids of other records or the token hash.
    expect(JSON.stringify(view)).not.toContain("tokenHash");

    const expired = await invite(s);
    await t.run(async (ctx) => ctx.db.patch(expired.invitationId, { expiresAt: Date.now() - 1 }));
    await s.reception.as.mutation(api.invitations.cancel, { ...s.orgArg, invitationId });
    for (const bad of ["", "nope", "wi_", "wi_" + "A".repeat(43), "wi_" + "A".repeat(500), expired.token, token]) {
      expect(await t.query(api.invitations.lookup, { token: bad })).toEqual(UNAVAILABLE);
    }
  });

  test("submitting creates the appointment pending approval; the link cannot be replayed", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const { token, invitationId } = await invite(s);
    const res = await t.mutation(api.invitations.submit, { token, details: DETAILS, answers: {} });
    expect(res).toMatchObject({ status: "ok", approval: "pending", hostName: "acme-hana" });
    const inv = await t.run(async (ctx) => ctx.db.get(invitationId));
    expect(inv).toMatchObject({ status: "submitted" });
    const appt = await t.run(async (ctx) => ctx.db.get(inv!.appointmentId!));
    expect(appt).toMatchObject({ status: "pending_approval", purpose: "Project kickoff", hostUserId: s.host.userId });
    const visitor = await t.run(async (ctx) => ctx.db.get(appt!.visitorId));
    expect(visitor).toMatchObject({ name: "Ivy Invitee", phone: "+254722333444" });

    // Replay and tampering: same generic answer, nothing new created.
    expect(await t.mutation(api.invitations.submit, { token, details: DETAILS, answers: {} })).toEqual(UNAVAILABLE);
    expect(await t.query(api.invitations.lookup, { token })).toEqual(UNAVAILABLE);
    expect(await t.mutation(api.invitations.submit, { token: token + "x", details: DETAILS, answers: {} })).toEqual(UNAVAILABLE);
    expect(await t.mutation(api.invitations.submit, { token: "wi_wrong", details: DETAILS, answers: {} })).toEqual(UNAVAILABLE);
    expect(await t.run(async (ctx) => ctx.db.query("appointments").collect())).toHaveLength(1);
    const audit = (await t.run(async (ctx) => ctx.db.query("auditLogs").collect())).map((a) => a.action);
    expect(audit).toContain("invitation.submitted");
  });

  test("the approval policy decides the appointment status", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    await s.owner.as.mutation(api.policies.updateOrganization, { ...s.orgArg, faceCaptureEnabled: false, requireApproval: false });
    const a = await invite(s);
    expect(await t.mutation(api.invitations.submit, { token: a.token, details: DETAILS, answers: {} })).toMatchObject({ approval: "approved" });
    // A site override wins over the organization setting.
    await s.owner.as.mutation(api.policies.updateSite, { ...s.orgArg, siteId: s.siteId, requireApproval: true });
    const b = await invite(s);
    expect(await t.mutation(api.invitations.submit, { token: b.token, details: { ...DETAILS, phone: "+254733000111" }, answers: {} })).toMatchObject({ approval: "pending" });
    const appts = await t.run(async (ctx) => ctx.db.query("appointments").collect());
    expect(appts.map((x) => x.status).sort()).toEqual(["approved", "pending_approval"]);
  });

  test("an expired link cannot be used and is closed", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const { token, invitationId } = await invite(s);
    await t.run(async (ctx) => ctx.db.patch(invitationId, { expiresAt: Date.now() - 1 }));
    expect(await t.mutation(api.invitations.submit, { token, details: DETAILS, answers: {} })).toEqual(UNAVAILABLE);
    expect((await t.run(async (ctx) => ctx.db.get(invitationId)))!.status).toBe("expired");
    expect(await t.run(async (ctx) => ctx.db.query("appointments").collect())).toHaveLength(0);
  });

  test("a cancelled link, or one for a suspended organization or inactive site, is unavailable", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const a = await invite(s);
    await s.reception.as.mutation(api.invitations.cancel, { ...s.orgArg, invitationId: a.invitationId });
    expect(await t.mutation(api.invitations.submit, { token: a.token, details: DETAILS, answers: {} })).toEqual(UNAVAILABLE);
    const b = await invite(s);
    await t.run(async (ctx) => ctx.db.patch(s.organizationId, { status: "suspended" }));
    expect(await t.query(api.invitations.lookup, { token: b.token })).toEqual(UNAVAILABLE);
    await t.run(async (ctx) => ctx.db.patch(s.organizationId, { status: "active" }));
    await t.run(async (ctx) => ctx.db.patch(s.siteId, { status: "inactive" }));
    expect(await t.query(api.invitations.lookup, { token: b.token })).toEqual(UNAVAILABLE);
  });

  test("invalid confirmed details are rejected and the link stays usable", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const { token } = await invite(s);
    await expectCode(t.mutation(api.invitations.submit, { token, details: { name: "I", phone: "12" }, answers: {} }), "VALIDATION");
    expect((await t.query(api.invitations.lookup, { token })).status).toBe("ok");
    expect(await t.mutation(api.invitations.submit, { token, details: DETAILS, answers: {} })).toMatchObject({ status: "ok" });
  });

  test("global submission limit protects the database", async () => {
    const t = newTest();
    let limited = false;
    for (let i = 0; i < 125 && !limited; i++) {
      try {
        await t.mutation(api.invitations.submit, { token: "wi_nope", details: DETAILS, answers: {} });
      } catch (e) {
        limited = (e as { data?: { code?: string } }).data?.code === "RATE_LIMITED";
      }
    }
    expect(limited).toBe(true);
  });
});

describe("invitations with a published form", () => {
  async function withForm() {
    const t = newTest();
    const s = await formsSetup(t);
    const form = await s.publishedForm();
    const inv = await invite(s);
    return { t, s, ...form, inv };
  }
  const answers = { consent: { accepted: true, text: CONSENT } };

  test("the public view serves the published form; name, phone and purpose come from the confirmed details", async () => {
    const { t, versionId, inv } = await withForm();
    const view = await t.query(api.invitations.lookup, { token: inv.token });
    if (view.status !== "ok") throw new Error("expected ok");
    expect(view.form?.versionId).toBe(versionId);
    const res = await t.mutation(api.invitations.submit, { token: inv.token, details: DETAILS, versionId, answers });
    expect(res.status).toBe("ok");
    const [response] = await t.run(async (ctx) => ctx.db.query("formResponses").collect());
    expect(response).toMatchObject({ formVersionId: versionId });
    expect(response!.appointmentId).toBeDefined();
    expect(response!.answers).toMatchObject({ name: "Ivy Invitee", phone: "+254722333444", purpose: "Project kickoff" });
  });

  test("answers are validated; a failed submit leaves the link usable and stores nothing", async () => {
    const { t, versionId, inv } = await withForm();
    await expectCode(t.mutation(api.invitations.submit, { token: inv.token, details: DETAILS, versionId, answers: {} }), "VALIDATION");
    await expectCode(
      t.mutation(api.invitations.submit, { token: inv.token, details: DETAILS, versionId, answers: { consent: { accepted: true, text: "other" } } }),
      "VALIDATION",
    );
    await expectCode(
      t.mutation(api.invitations.submit, { token: inv.token, details: DETAILS, versionId, answers: { ...answers, contact: "Smoke signal" } }),
      "VALIDATION",
    );
    expect(await t.run(async (ctx) => ctx.db.query("formResponses").collect())).toHaveLength(0);
    expect(await t.run(async (ctx) => ctx.db.query("appointments").collect())).toHaveLength(0);
    expect((await t.query(api.invitations.lookup, { token: inv.token })).status).toBe("ok");
  });

  test("a stale form version asks the visitor to reload", async () => {
    const { t, s, formId, versionId, inv } = await withForm();
    await s.owner.as.mutation(api.forms.publish, { ...s.orgArg, formId });
    await expectCode(
      t.mutation(api.invitations.submit, { token: inv.token, details: DETAILS, versionId, answers }),
      "CONFLICT",
    );
    const view = await t.query(api.invitations.lookup, { token: inv.token });
    if (view.status !== "ok" || !view.form) throw new Error("expected a form");
    expect(view.form.versionId).not.toBe(versionId);
    expect(await t.mutation(api.invitations.submit, { token: inv.token, details: DETAILS, versionId: view.form.versionId, answers })).toMatchObject({ status: "ok" });
  });

  test("uploads need a live token, are capped, and can only be claimed by their own invitation", async () => {
    const { t, s, versionId, inv } = await withForm();
    expect(await t.mutation(api.invitations.generateUploadUrl, { token: "wi_nope", kind: "signature" })).toEqual(UNAVAILABLE);
    const ok = await t.mutation(api.invitations.generateUploadUrl, { token: inv.token, kind: "signature" });
    expect(ok.status).toBe("ok");
    // Bytes uploaded for a dead link are discarded.
    const stray = await t.run(async (ctx) => ctx.storage.store(new Blob(["x"], { type: "image/png" })));
    expect(await t.mutation(api.invitations.registerUploaded, { token: "wi_nope", storageId: stray, kind: "signature" })).toEqual(UNAVAILABLE);
    expect(await t.run(async (ctx) => ctx.storage.getUrl(stray))).toBeNull();

    // Register a signature for this invitation, and one for another invitation.
    const other = await invite(s);
    const register = async (invitationId: Id<"invitations">) => {
      const storageId = await t.run(async (ctx) => ctx.storage.store(new Blob([new Uint8Array(50)], { type: "image/png" })));
      const res = await t.run(async (ctx) =>
        registerUpload(
          ctx,
          { organizationId: s.organizationId, siteId: s.siteId, storageId, kind: "signature", uploader: { invitationId } },
          async (c, id) => ({ size: (await c.db.system.get(id))!.size, contentType: "image/png" }),
        ),
      );
      if (res.status !== "ok") throw new Error("upload failed");
      return res.fileId;
    };
    const mine = await register(inv.invitationId);
    const theirs = await register(other.invitationId);
    await expectCode(
      t.mutation(api.invitations.submit, { token: inv.token, details: DETAILS, versionId, answers: { ...answers, signature: { fileId: theirs } } }),
      "VALIDATION",
    );
    // A kiosk device's upload cannot be claimed through an invitation either.
    const kioskUp = await s.upload("signature", "image/png");
    if (kioskUp.res.status !== "ok") throw new Error("upload failed");
    await expectCode(
      t.mutation(api.invitations.submit, { token: inv.token, details: DETAILS, versionId, answers: { ...answers, signature: { fileId: kioskUp.res.fileId } } }),
      "VALIDATION",
    );
    await t.mutation(api.invitations.submit, { token: inv.token, details: DETAILS, versionId, answers: { ...answers, signature: { fileId: mine } } });
    expect((await t.run(async (ctx) => ctx.db.get(mine)))!.status).toBe("attached");
  });

  test("uploads per invitation are capped", async () => {
    const { t, inv } = await withForm();
    let capped = false;
    for (let i = 0; i < 12; i++) {
      try {
        await t.mutation(api.invitations.generateUploadUrl, { token: inv.token, kind: "photo" });
      } catch (e) {
        capped = (e as { data?: { code?: string } }).data?.code === "RATE_LIMITED";
      }
    }
    expect(capped).toBe(true);
  });

  test("after approval and kiosk check-in, the visit shows the invitation's answers", async () => {
    const { t, s, versionId, inv } = await withForm();
    await t.mutation(api.invitations.submit, { token: inv.token, details: DETAILS, versionId, answers });
    const [appt] = await t.run(async (ctx) => ctx.db.query("appointments").collect());
    await s.host.as.mutation(api.appointments.decide, { ...s.orgArg, appointmentId: appt!._id, decision: "approved" });
    const found = await t.mutation(api.kioskVisitor.findAppointments, { ...s.k, phone: DETAILS.phone });
    expect(found.status).toBe("found");
    await t.mutation(api.kioskVisitor.checkInAppointment, { ...s.k, appointmentId: appt!._id, phone: DETAILS.phone });
    const [visit] = await t.run(async (ctx) => ctx.db.query("visits").collect());
    const res = await s.reception.as.query(api.forms.visitResponses, { ...s.orgArg, visitId: visit!._id });
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ version: 1, formName: "Visitor registration" });
  });
});

describe("notification hook", () => {
  test("creating an invitation schedules one notification job with the link, never storing the token", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const { token } = await invite(s, "reception", { visitorEmail: "ivy@example.com" });
    const scheduled = await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled).toHaveLength(1);
    expect(JSON.stringify(scheduled[0]!.args)).toContain(token);
    expect(JSON.stringify(scheduled[0]!.args)).toContain("invite:");
    const rows = await t.run(async (ctx) => ctx.db.query("invitations").collect());
    expect(JSON.stringify(rows)).not.toContain(token);
  });
});
