import { describe, expect, test } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { CONSENT, formsSetup, GOOD_ANSWERS, visitorFields, type FormsSetup } from "./formsSetup";
import { addMember, createOrgWithOwner, expectCode, newTest, type T } from "./setup";

async function submit(t: T, s: FormsSetup, versionId: Id<"formVersions">, answers: Record<string, unknown>) {
  return await t.mutation(api.kioskForms.submitWalkIn, {
    ...s.k,
    hostUserId: s.host.userId,
    versionId,
    answers: answers as never,
  });
}

async function onlyVisit(t: T) {
  const visits = await t.run(async (ctx) => ctx.db.query("visits").collect());
  return visits;
}

async function auditActions(t: T) {
  const rows = await t.run(async (ctx) => ctx.db.query("auditLogs").collect());
  return rows.map((r) => r.action);
}

describe("form versions are immutable", () => {
  test("publishing creates a new version and never edits an old one", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const { formId, versionId: v1 } = await s.publishedForm();
    const before = await s.owner.as.query(api.forms.getVersion, { ...s.orgArg, versionId: v1 });

    // Edit the draft, publish again.
    const form = await s.owner.as.query(api.forms.get, { ...s.orgArg, formId });
    expect(form.hasUnpublishedChanges).toBe(false);
    const edited = visitorFields().filter((f) => f.id !== "company");
    await s.owner.as.mutation(api.forms.saveDraft, {
      ...s.orgArg,
      formId,
      name: "Renamed",
      fields: edited as never,
    });
    expect((await s.owner.as.query(api.forms.get, { ...s.orgArg, formId })).hasUnpublishedChanges).toBe(true);
    // Unpublished edits do not change what the kiosk serves.
    expect((await s.activeForm())?.versionId).toBe(v1);

    const v2 = await s.owner.as.mutation(api.forms.publish, { ...s.orgArg, formId });
    const after = await s.owner.as.query(api.forms.getVersion, { ...s.orgArg, versionId: v1 });
    expect(after).toEqual(before);
    expect(after.fields.some((f) => f.id === "company")).toBe(true);
    const second = await s.owner.as.query(api.forms.getVersion, { ...s.orgArg, versionId: v2 });
    expect(second.version).toBe(2);
    expect(second.name).toBe("Renamed");
    expect(second.fields.some((f) => f.id === "company")).toBe(false);
    const detail = await s.owner.as.query(api.forms.get, { ...s.orgArg, formId });
    expect(detail.history.map((h) => h.version)).toEqual([2, 1]);
  });

  test("a response keeps pointing at the version it was answered with", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const { formId, versionId: v1 } = await s.publishedForm();
    await submit(t, s, v1, GOOD_ANSWERS);
    await s.owner.as.mutation(api.forms.publish, { ...s.orgArg, formId });
    const responses = await t.run(async (ctx) => ctx.db.query("formResponses").collect());
    expect(responses).toHaveLength(1);
    expect(responses[0]!.formVersionId).toBe(v1);
    // A kiosk screen still on v1 must reload rather than post to a stale form.
    await expectCode(submit(t, s, v1, GOOD_ANSWERS), "CONFLICT");
  });

  test("archived forms cannot be edited or published and stop being served", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const { formId } = await s.publishedForm();
    await s.owner.as.mutation(api.forms.archive, { ...s.orgArg, formId });
    expect(await s.activeForm()).toBeNull();
    await expectCode(s.owner.as.mutation(api.forms.publish, { ...s.orgArg, formId }), "CONFLICT");
    await expectCode(
      s.owner.as.mutation(api.forms.saveDraft, { ...s.orgArg, formId, name: "x1", fields: visitorFields() as never }),
      "CONFLICT",
    );
    await s.owner.as.mutation(api.forms.restore, { ...s.orgArg, formId });
    await s.owner.as.mutation(api.forms.publish, { ...s.orgArg, formId });
    expect(await s.activeForm()).not.toBeNull();
  });

  test("publish refuses forms that break the rules", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    // No purpose mapping.
    const noPurpose = visitorFields().filter((f) => f.id !== "purpose");
    const a = await s.createForm(noPurpose);
    await expectCode(s.owner.as.mutation(api.forms.publish, { ...s.orgArg, formId: a }), "VALIDATION");
    // Face photo while face capture is off.
    const face = [
      ...visitorFields(),
      { id: "face", type: "face_photo", label: "Face", required: false, sensitive: true },
    ];
    const b = await s.createForm(face);
    await expectCode(s.owner.as.mutation(api.forms.publish, { ...s.orgArg, formId: b }), "VALIDATION");
    // Invalid field definitions are refused at save time.
    await expectCode(
      s.owner.as.mutation(api.forms.saveDraft, {
        ...s.orgArg,
        formId: a,
        name: "Form",
        fields: [{ id: "x", type: "dropdown", label: "x", required: false, sensitive: false }] as never,
      }),
      "VALIDATION",
    );
  });
});

describe("form management permissions and tenant isolation", () => {
  test("only forms:manage can build forms; other tenants see nothing", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const { formId, versionId } = await s.publishedForm();
    await expectCode(s.reception.as.query(api.forms.list, s.orgArg), "FORBIDDEN");
    await expectCode(
      s.host.as.mutation(api.forms.create, { ...s.orgArg, name: "Nope", audience: "visitor" }),
      "FORBIDDEN",
    );
    // The admin role includes forms:manage.
    expect(await s.admin.as.query(api.forms.list, s.orgArg)).toHaveLength(1);

    const other = await createOrgWithOwner(t, "Other", "other");
    const otherArg = { organizationId: other.organizationId };
    expect(await other.owner.as.query(api.forms.list, otherArg)).toEqual([]);
    await expectCode(other.owner.as.query(api.forms.get, { ...otherArg, formId }), "NOT_FOUND");
    await expectCode(other.owner.as.query(api.forms.getVersion, { ...otherArg, versionId }), "NOT_FOUND");
    await expectCode(other.owner.as.mutation(api.forms.publish, { ...otherArg, formId }), "NOT_FOUND");
    // Using org A's id with org B's membership does not work either.
    await expectCode(other.owner.as.query(api.forms.list, s.orgArg), "NOT_FOUND");
  });
});

describe("kiosk form rendering and submission", () => {
  test("no published form: the kiosk falls back (null); the token is required", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    expect(await s.activeForm()).toBeNull();
    await s.createForm(); // draft only
    expect(await s.activeForm()).toBeNull();
    await expectCode(t.query(api.kioskForms.activeVisitorForm, { slug: "acme", token: "wk_nope" }), "NOT_FOUND");
    await expectCode(t.query(api.kioskForms.activeVisitorForm, { slug: "acme", token: "" }), "NOT_FOUND");
  });

  test("a valid submission creates the visit and stores the version reference", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const { formId, versionId } = await s.publishedForm();
    const active = await s.activeForm();
    expect(active?.versionId).toBe(versionId);
    expect(active?.fields.map((f) => f.id)).toContain("consent");

    const res = await submit(t, s, versionId, {
      ...GOOD_ANSWERS,
      company: "Acme Ltd",
      id_number: "12345678",
      contact: "Phone",
      email_detail: "ignored@example.com", // hidden by showIf: dropped
    });
    expect(res).toMatchObject({ status: "ok", firstName: "Jane" });

    const visits = await onlyVisit(t);
    expect(visits).toHaveLength(1);
    expect(visits[0]).toMatchObject({ status: "expected", purpose: "Interview", hostUserId: s.host.userId });
    const visitor = await t.run(async (ctx) => ctx.db.get(visits[0]!.visitorId));
    expect(visitor).toMatchObject({ name: "Jane Visitor", phone: "+254700111222", company: "Acme Ltd" });
    // The ID number stays in the response only.
    expect(JSON.stringify(visitor)).not.toContain("12345678");

    const [response] = await t.run(async (ctx) => ctx.db.query("formResponses").collect());
    expect(response).toMatchObject({ visitId: visits[0]!._id, formId, formVersionId: versionId });
    expect(response!.answers.email_detail).toBeUndefined();
    expect(response!.answers.consent).toEqual({ accepted: true, text: CONSENT });
    expect(await auditActions(t)).toContain("form_response.created");
  });

  test("invalid answers are rejected and nothing is stored", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const { versionId } = await s.publishedForm();
    const bad: Record<string, unknown>[] = [
      { ...GOOD_ANSWERS, name: undefined },
      { ...GOOD_ANSWERS, phone: "abc" },
      { ...GOOD_ANSWERS, contact: "Carrier pigeon" },
      { ...GOOD_ANSWERS, contact: "Email" }, // showIf makes email_detail required
      { ...GOOD_ANSWERS, consent: { accepted: false, text: CONSENT } },
      { ...GOOD_ANSWERS, consent: { accepted: true, text: "different text" } },
      { ...GOOD_ANSWERS, injected: "x" },
      { ...GOOD_ANSWERS, purpose: "x".repeat(250) },
    ];
    for (const answers of bad) {
      await expectCode(submit(t, s, versionId, answers), "VALIDATION");
    }
    expect(await onlyVisit(t)).toHaveLength(0);
    expect(await t.run(async (ctx) => ctx.db.query("formResponses").collect())).toHaveLength(0);
    // A host from another site/org is refused as well.
    await expectCode(
      t.mutation(api.kioskForms.submitWalkIn, {
        ...s.k,
        hostUserId: (await createOrgWithOwner(t, "Elsewhere", "elsewhere")).owner.userId,
        versionId,
        answers: GOOD_ANSWERS as never,
      }),
      "VALIDATION",
    );
  });

  test("a showIf field is accepted when its condition holds", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const { versionId } = await s.publishedForm();
    await submit(t, s, versionId, { ...GOOD_ANSWERS, contact: "Email", email_detail: "jane@example.com" });
    const [response] = await t.run(async (ctx) => ctx.db.query("formResponses").collect());
    expect(response!.answers.email_detail).toBe("jane@example.com");
  });

  test("site isolation: a form for another site is never served; org-wide forms are, site forms win", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const site2 = await s.owner.as.mutation(api.sites.create, {
      ...s.orgArg,
      name: "Branch",
      timeZone: "Africa/Nairobi",
    });
    const branchOnly = await s.publishedForm(undefined, { siteId: site2, name: "Branch form" });
    expect(await s.activeForm()).toBeNull();
    const orgWide = await s.publishedForm(undefined, { name: "Org form" });
    expect((await s.activeForm())?.versionId).toBe(orgWide.versionId);
    const here = await s.publishedForm(undefined, { siteId: s.siteId, name: "Here form" });
    expect((await s.activeForm())?.versionId).toBe(here.versionId);
    // Posting to the branch form from this site's kiosk is refused.
    await expectCode(submit(t, s, branchOnly.versionId, GOOD_ANSWERS), "CONFLICT");
  });

  test("another organization's kiosk cannot post to this organization's form", async () => {
    const t = newTest();
    const a = await formsSetup(t, "acme");
    const b = await formsSetup(t, "beta");
    const { versionId } = await a.publishedForm();
    await expectCode(
      t.mutation(api.kioskForms.submitWalkIn, {
        ...b.k,
        hostUserId: b.host.userId,
        versionId,
        answers: GOOD_ANSWERS as never,
      }),
      "CONFLICT",
    );
  });

  test("face photo fields are hidden and ignored while face capture is off", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    await s.owner.as.mutation(api.policies.updateOrganization, {
      ...s.orgArg,
      faceCaptureEnabled: true,
      requireApproval: true,
    });
    const fields = [
      { id: "face_ok", type: "consent", label: "Face consent", required: true, sensitive: false, consentText: "Photo ok" },
      ...visitorFields().filter((f) => f.id !== "consent"),
      { id: "face", type: "face_photo", label: "Face", required: true, sensitive: true },
    ];
    const { versionId } = await s.publishedForm(fields);
    expect((await s.activeForm())?.fields.some((f) => f.type === "face_photo")).toBe(true);
    await s.owner.as.mutation(api.policies.updateOrganization, {
      ...s.orgArg,
      faceCaptureEnabled: false,
      requireApproval: true,
    });
    expect((await s.activeForm())?.fields.some((f) => f.type === "face_photo")).toBe(false);
    const { consent: _unused, ...rest } = GOOD_ANSWERS;
    void _unused;
    const res = await submit(t, s, versionId, { ...rest, face_ok: { accepted: true, text: "Photo ok" } });
    expect(res.status).toBe("ok");
  });
});

describe("sensitive answers", () => {
  async function withSensitiveVisit() {
    const t = newTest();
    const s = await formsSetup(t);
    const { versionId } = await s.publishedForm();
    await submit(t, s, versionId, { ...GOOD_ANSWERS, id_number: "99887766" });
    const [visit] = await onlyVisit(t);
    const [response] = await t.run(async (ctx) => ctx.db.query("formResponses").collect());
    return { t, s, visitId: visit!._id, responseId: response!._id };
  }

  test("the visit query withholds sensitive values from everyone, even permitted readers", async () => {
    const { s, visitId } = await withSensitiveVisit();
    for (const who of [s.reception, s.owner]) {
      const res = await who.as.query(api.forms.visitResponses, { ...s.orgArg, visitId });
      expect(JSON.stringify(res)).not.toContain("99887766");
      expect(res[0]!.items.find((i) => i.id === "id_number")).toMatchObject({ sensitive: true });
      expect(res[0]!.items.find((i) => i.id === "name")).toMatchObject({ value: "Jane Visitor" });
    }
    expect((await s.reception.as.query(api.forms.visitResponses, { ...s.orgArg, visitId }))[0]!.canRevealSensitive).toBe(false);
    expect((await s.owner.as.query(api.forms.visitResponses, { ...s.orgArg, visitId }))[0]!.canRevealSensitive).toBe(true);
  });

  test("revealing needs forms:read_sensitive and every read is audited", async () => {
    const { t, s, responseId } = await withSensitiveVisit();
    await expectCode(s.reception.as.mutation(api.forms.revealSensitive, { ...s.orgArg, responseId }), "FORBIDDEN");
    await expectCode(s.host.as.mutation(api.forms.revealSensitive, { ...s.orgArg, responseId }), "FORBIDDEN");
    expect(await auditActions(t)).not.toContain("form_response.sensitive_read");

    const items = await s.owner.as.mutation(api.forms.revealSensitive, { ...s.orgArg, responseId });
    expect(items.find((i) => i.id === "id_number")).toMatchObject({ value: "99887766" });
    await s.admin.as.mutation(api.forms.revealSensitive, { ...s.orgArg, responseId });
    const reads = (await t.run(async (ctx) => ctx.db.query("auditLogs").collect())).filter(
      (a) => a.action === "form_response.sensitive_read",
    );
    expect(reads).toHaveLength(2);
    expect(reads[0]).toMatchObject({ actorUserId: s.owner.userId, resourceId: responseId });
    // The audit entry names fields, never values.
    expect(JSON.stringify(reads)).not.toContain("99887766");
  });

  test("a permission override can grant or remove forms:read_sensitive", async () => {
    const { t, s, responseId } = await withSensitiveVisit();
    await t.run(async (ctx) => ctx.db.patch(s.reception.membershipId, { permissionOverrides: { grant: ["forms:read_sensitive"], revoke: [] } }));
    await s.reception.as.mutation(api.forms.revealSensitive, { ...s.orgArg, responseId });
    await t.run(async (ctx) => ctx.db.patch(s.admin.membershipId, { permissionOverrides: { grant: [], revoke: ["forms:read_sensitive"] } }));
    await expectCode(s.admin.as.mutation(api.forms.revealSensitive, { ...s.orgArg, responseId }), "FORBIDDEN");
  });

  test("another organization cannot read the response", async () => {
    const { t, s, visitId, responseId } = await withSensitiveVisit();
    const other = await createOrgWithOwner(t, "Other", "other");
    const arg = { organizationId: other.organizationId };
    await expectCode(other.owner.as.mutation(api.forms.revealSensitive, { ...arg, responseId }), "NOT_FOUND");
    await expectCode(other.owner.as.query(api.forms.visitResponses, { ...arg, visitId }), "NOT_FOUND");
  });
});

describe("files", () => {
  test("uploads need a valid device token", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    for (const k of [{ slug: "acme", token: "" }, { slug: "acme", token: "wk_nope" }]) {
      await expectCode(t.mutation(api.filesKiosk.generateUploadUrl, { ...k, kind: "signature" }), "NOT_FOUND");
    }
    const url = await t.mutation(api.filesKiosk.generateUploadUrl, { ...s.k, kind: "signature" });
    expect(typeof url).toBe("string");
    const storageId = await t.run(async (ctx) => ctx.storage.store(new Blob(["x"], { type: "image/png" })));
    await expectCode(
      t.mutation(api.filesKiosk.registerUploaded, { slug: "acme", token: "wk_nope", storageId, kind: "signature" }),
      "NOT_FOUND",
    );
    expect(await t.run(async (ctx) => ctx.db.query("files").collect())).toHaveLength(0);
  });

  test("size and type limits are enforced from storage metadata; rejected bytes are deleted", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const tooBig = await s.upload("signature", "image/png", 600_000);
    expect(tooBig.res).toEqual({ status: "rejected", reason: "too_large" });
    expect(await t.run(async (ctx) => ctx.storage.getUrl(tooBig.storageId))).toBeNull();

    const wrongType = await s.upload("signature", "text/html", 100);
    expect(wrongType.res).toEqual({ status: "rejected", reason: "bad_type" });
    const pdfAsPhoto = await s.upload("id_scan", "application/pdf", 100);
    expect(pdfAsPhoto.res).toEqual({ status: "rejected", reason: "bad_type" });
    expect((await s.upload("file", "application/pdf", 100)).res.status).toBe("ok");
    expect((await s.upload("id_scan", "image/jpeg", 2_000_000)).res.status).toBe("ok");
    expect(await t.run(async (ctx) => ctx.db.query("files").collect())).toHaveLength(2);
  });

  test("an upload with no declared content type is rejected through the public function", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const storageId = await t.run(async (ctx) => ctx.storage.store(new Blob([new Uint8Array(10)])));
    const res = await t.mutation(api.filesKiosk.registerUploaded, { ...s.k, storageId, kind: "signature" });
    expect(res).toEqual({ status: "rejected", reason: "bad_type" });
    expect(await t.run(async (ctx) => ctx.db.query("files").collect())).toHaveLength(0);
  });

  test("a storage object can be registered only once", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const first = await s.upload("signature", "image/png");
    expect(first.res.status).toBe("ok");
    const again = await t.mutation(api.filesKiosk.registerUploaded, { ...s.k, storageId: first.storageId, kind: "signature" });
    expect(again.status).toBe("rejected");
  });

  test("uploads are rate limited per device", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    let limited = false;
    for (let i = 0; i < 31; i++) {
      try {
        await t.mutation(api.filesKiosk.generateUploadUrl, { ...s.k, kind: "photo" });
      } catch (e) {
        limited = (e as { data?: { code?: string } }).data?.code === "RATE_LIMITED";
      }
    }
    expect(limited).toBe(true);
  });

  async function submitWithFiles() {
    const t = newTest();
    const s = await formsSetup(t);
    const { versionId } = await s.publishedForm();
    const sig = await s.upload("signature", "image/png");
    const scan = await s.upload("id_scan", "image/jpeg");
    if (sig.res.status !== "ok" || scan.res.status !== "ok") throw new Error("upload failed");
    await submit(t, s, versionId, {
      ...GOOD_ANSWERS,
      signature: { fileId: sig.res.fileId },
      id_scan: { fileId: scan.res.fileId },
    });
    const [visit] = await onlyVisit(t);
    return { t, s, versionId, sigId: sig.res.fileId, scanId: scan.res.fileId, visitId: visit!._id };
  }

  test("answers can only claim files the same device uploaded, once, of the right kind", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const { versionId } = await s.publishedForm();
    const other = await formsSetup(t, "beta");
    const foreign = await other.upload("signature", "image/png");
    if (foreign.res.status !== "ok") throw new Error("upload failed");
    await expectCode(submit(t, s, versionId, { ...GOOD_ANSWERS, signature: { fileId: foreign.res.fileId } }), "VALIDATION");
    const photo = await s.upload("photo", "image/png");
    if (photo.res.status !== "ok") throw new Error("upload failed");
    await expectCode(submit(t, s, versionId, { ...GOOD_ANSWERS, signature: { fileId: photo.res.fileId } }), "VALIDATION");
    await expectCode(submit(t, s, versionId, { ...GOOD_ANSWERS, signature: { fileId: "not-an-id" } }), "VALIDATION");
    const sig = await s.upload("signature", "image/png");
    if (sig.res.status !== "ok") throw new Error("upload failed");
    // Same file twice in one submission.
    await expectCode(
      submit(t, s, versionId, { ...GOOD_ANSWERS, signature: { fileId: sig.res.fileId }, id_scan: { fileId: sig.res.fileId } }),
      "VALIDATION",
    );
    expect(await onlyVisit(t)).toHaveLength(0);
    // Valid claim works, and a second claim of the same (now attached) file does not.
    await submit(t, s, versionId, { ...GOOD_ANSWERS, signature: { fileId: sig.res.fileId } });
    await expectCode(submit(t, s, versionId, { ...GOOD_ANSWERS, signature: { fileId: sig.res.fileId } }), "VALIDATION");
  });

  test("an ID scan image is stored only when the field says storeImage", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const noStore = visitorFields().map((f) => (f.id === "id_scan" ? { ...f, storeImage: false } : f));
    const { versionId } = await s.publishedForm(noStore);
    const scan = await s.upload("id_scan", "image/jpeg");
    if (scan.res.status !== "ok") throw new Error("upload failed");
    await expectCode(submit(t, s, versionId, { ...GOOD_ANSWERS, id_scan: { fileId: scan.res.fileId } }), "VALIDATION");
    // Read-and-discard: only the fact that a scan happened is stored.
    await submit(t, s, versionId, { ...GOOD_ANSWERS, id_scan: { scanned: true } });
    const [response] = await t.run(async (ctx) => ctx.db.query("formResponses").collect());
    expect(response!.answers.id_scan).toEqual({ scanned: true });
  });

  test("claimed files get their field's retention deadline", async () => {
    const { t, sigId, scanId } = await submitWithFiles();
    const [sig, scan] = await t.run(async (ctx) => [await ctx.db.get(sigId), await ctx.db.get(scanId)]);
    const day = 24 * 60 * 60 * 1000;
    expect(sig).toMatchObject({ status: "attached", fieldId: "signature" });
    expect(scan).toMatchObject({ status: "attached", fieldId: "id_scan" });
    expect(Math.abs(sig!.deleteAfter - (Date.now() + 30 * day))).toBeLessThan(60_000);
    expect(Math.abs(scan!.deleteAfter - (Date.now() + 7 * day))).toBeLessThan(60_000);
  });

  test("reading a file needs the right permission and is audited; sensitive files need forms:read_sensitive", async () => {
    const { t, s, sigId, scanId } = await submitWithFiles();
    // Signature is not sensitive: anyone who can see the visit may open it.
    const sig = await s.reception.as.mutation(api.forms.openFile, { ...s.orgArg, fileId: sigId });
    expect(sig.url).toBeTruthy();
    // The ID image is sensitive.
    await expectCode(s.reception.as.mutation(api.forms.openFile, { ...s.orgArg, fileId: scanId }), "FORBIDDEN");
    // The visit's own host sees non-sensitive items but not the ID image.
    await s.host.as.mutation(api.forms.openFile, { ...s.orgArg, fileId: sigId });
    await expectCode(s.host.as.mutation(api.forms.openFile, { ...s.orgArg, fileId: scanId }), "FORBIDDEN");
    // Staff with no visit access cannot tell the file exists.
    const staff = await addMember(t, s.organizationId, "acme-sam", "staff");
    await expectCode(staff.as.mutation(api.forms.openFile, { ...s.orgArg, fileId: sigId }), "NOT_FOUND");
    const scan = await s.owner.as.mutation(api.forms.openFile, { ...s.orgArg, fileId: scanId });
    expect(scan.contentType).toBe("image/jpeg");
    const reads = (await t.run(async (ctx) => ctx.db.query("auditLogs").collect())).filter((a) => a.action === "file.read");
    // reception + host read the signature; the owner read the scan (denied reads are not logged).
    expect(reads.map((r) => r.resourceId).sort()).toEqual([sigId, sigId, scanId].sort());
    // Nothing public exposes file URLs: the visit query returns ids only.
    const [{ items }] = await s.reception.as.query(api.forms.visitResponses, { ...s.orgArg, visitId: (await onlyVisit(t))[0]!._id });
    expect(JSON.stringify(items)).not.toContain("http");
    // Another tenant cannot open it.
    const other = await createOrgWithOwner(t, "Other", "other");
    await expectCode(other.owner.as.mutation(api.forms.openFile, { organizationId: other.organizationId, fileId: sigId }), "NOT_FOUND");
  });

  test("retention: expired files are deleted, others kept, and the answer says removed", async () => {
    const { t, s, sigId, scanId, visitId } = await submitWithFiles();
    // Scan is past its date; the signature is not.
    await t.run(async (ctx) => ctx.db.patch(scanId, { deleteAfter: Date.now() - 1000 }));
    const scanStorage = (await t.run(async (ctx) => ctx.db.get(scanId)))!.storageId!;
    const deleted = await t.mutation(internal.files.deleteExpired, {});
    expect(deleted).toBe(1);
    const [sig, scan] = await t.run(async (ctx) => [await ctx.db.get(sigId), await ctx.db.get(scanId)]);
    expect(sig!.status).toBe("attached");
    expect(sig!.storageId).toBeDefined();
    expect(scan).toMatchObject({ status: "deleted" });
    expect(scan!.storageId).toBeUndefined();
    expect(await t.run(async (ctx) => ctx.storage.getUrl(scanStorage))).toBeNull();
    await expectCode(s.owner.as.mutation(api.forms.openFile, { ...s.orgArg, fileId: scanId }), "NOT_FOUND");
    const revealed = await s.owner.as.mutation(api.forms.revealSensitive, {
      ...s.orgArg,
      responseId: (await t.run(async (ctx) => ctx.db.query("formResponses").collect()))[0]!._id,
    });
    expect(revealed.find((i) => i.id === "id_scan")).toMatchObject({ file: { deleted: true } });
    expect(visitId).toBeDefined();
    expect(await auditActions(t)).toContain("file.deleted_retention");
    // Running again is a no-op.
    expect(await t.mutation(internal.files.deleteExpired, {})).toBe(0);
  });

  test("retention: unclaimed uploads expire after an hour", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const up = await s.upload("signature", "image/png");
    if (up.res.status !== "ok") throw new Error("upload failed");
    expect(await t.mutation(internal.files.deleteExpired, {})).toBe(0);
    const row = await t.run(async (ctx) => ctx.db.get(up.res.status === "ok" ? up.res.fileId : ("" as Id<"files">)));
    expect(row!.deleteAfter - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000);
    await t.run(async (ctx) => ctx.db.patch(row!._id, { deleteAfter: Date.now() - 1 }));
    expect(await t.mutation(internal.files.deleteExpired, {})).toBe(1);
    expect(await t.run(async (ctx) => ctx.storage.getUrl(up.storageId))).toBeNull();
  });
});

describe("policies", () => {
  test("approval policy: organization default, site override; needs settings:manage", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const start = Date.now() + 3600_000;
    const book = async () => {
      const id = await s.reception.as.mutation(api.appointments.create, {
        ...s.orgArg,
        siteId: s.siteId,
        hostUserId: s.host.userId,
        visitor: { name: "Vee", phone: "+254711000111" },
        purpose: "Chat",
        scheduledStart: start,
        scheduledEnd: start + 3600_000,
      });
      return (await s.owner.as.query(api.appointments.get, { ...s.orgArg, appointmentId: id })).status;
    };
    expect(await book()).toBe("pending_approval");
    await expectCode(
      s.reception.as.mutation(api.policies.updateOrganization, { ...s.orgArg, faceCaptureEnabled: false, requireApproval: false }),
      "FORBIDDEN",
    );
    await s.owner.as.mutation(api.policies.updateOrganization, { ...s.orgArg, faceCaptureEnabled: false, requireApproval: false });
    expect(await book()).toBe("approved");
    await s.owner.as.mutation(api.policies.updateSite, { ...s.orgArg, siteId: s.siteId, requireApproval: true });
    expect(await book()).toBe("pending_approval");
    await s.owner.as.mutation(api.policies.updateSite, { ...s.orgArg, siteId: s.siteId, requireApproval: null });
    expect(await book()).toBe("approved");
    const policy = await s.owner.as.query(api.policies.get, s.orgArg);
    expect(policy).toMatchObject({ faceCaptureEnabled: false, requireApproval: false });
  });

  test("face capture is off by default", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    expect((await s.owner.as.query(api.policies.get, s.orgArg)).faceCaptureEnabled).toBe(false);
  });
});
