import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { MAX_OPEN_INTENTS, ORPHAN_GRACE_MS } from "../../convex/lib/files";
import { GOOD_ANSWERS, formsSetup, type FormsSetup } from "./formsSetup";
import { expectCode, newTest, type T } from "./setup";

const HOUR = 60 * 60 * 1000;
const bytes = (...b: number[]) => Uint8Array.from(b);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 1, 2, 3, 4);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 2, 3, 4);
const HTML = Uint8Array.from("<html><script>alert(1)</script></html>".split("").map((c) => c.charCodeAt(0)));

// Scheduled functions (content verification, self-rescheduling sweeps) only run when a test asks.
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const files = (t: T) => t.run(async (ctx) => ctx.db.query("files").collect());
const intents = (t: T) => t.run(async (ctx) => ctx.db.query("uploadIntents").collect());
const audit = async (t: T, action: string) =>
  (await t.run(async (ctx) => ctx.db.query("auditLogs").collect())).filter((a) => a.action === action);

describe("upload intents", () => {
  test("handing out an upload URL records an intent; registering the upload clears it", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    await t.mutation(api.filesKiosk.generateUploadUrl, { ...s.k, kind: "signature" });
    const [row] = await intents(t);
    expect(row).toMatchObject({ kind: "signature", kioskDeviceId: s.deviceId, organizationId: s.organizationId });
    expect(row!.expiresAt).toBeGreaterThan(Date.now());
    const up = await s.upload("signature", "image/png", PNG);
    expect(up.res.status).toBe("ok");
    expect(await intents(t)).toHaveLength(0);
  });

  test("a rejected upload also clears its intent", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    await t.mutation(api.filesKiosk.generateUploadUrl, { ...s.k, kind: "signature" });
    const up = await s.upload("signature", "text/html", PNG);
    expect(up.res.status).toBe("rejected");
    expect(await intents(t)).toHaveLength(0);
  });

  test("one uploader cannot hold more than the open-URL cap", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    for (let i = 0; i < MAX_OPEN_INTENTS; i++) {
      await t.mutation(api.filesKiosk.generateUploadUrl, { ...s.k, kind: "photo" });
    }
    await expectCode(t.mutation(api.filesKiosk.generateUploadUrl, { ...s.k, kind: "photo" }), "RATE_LIMITED");
    expect(await intents(t)).toHaveLength(MAX_OPEN_INTENTS);
  });
});

describe("sweeping abandoned uploads", () => {
  const store = (t: T, data: Uint8Array = PNG, type = "image/png") =>
    t.run(async (ctx) => ctx.storage.store(new Blob([data as unknown as BlobPart], { type })));
  const exists = (t: T, id: Id<"_storage">) => t.run(async (ctx) => (await ctx.storage.getUrl(id)) !== null);
  const later = Date.now() + ORPHAN_GRACE_MS + HOUR;

  test("blobs that were never registered are deleted; registered ones are kept", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const kept = await s.upload("signature", "image/png", PNG);
    // Claimed by a response, so not "pending" any more.
    if (kept.res.status !== "ok") throw new Error("upload failed");
    const keptId = kept.res.fileId;
    await t.run(async (ctx) => ctx.db.patch(keptId, { status: "attached", deleteAfter: Date.now() + 30 * HOUR }));
    const orphanA = await store(t);
    const orphanB = await store(t, JPEG, "image/jpeg");
    const res = await t.mutation(internal.files.sweepOrphans, { now: later });
    expect(res).toMatchObject({ orphanBlobs: 2, hasMore: false });
    expect(await exists(t, orphanA)).toBe(false);
    expect(await exists(t, orphanB)).toBe(false);
    expect(await exists(t, kept.storageId)).toBe(true);
    expect(await files(t)).toHaveLength(1);
  });

  test("a blob younger than the grace period is left alone (its uploader may still register it)", async () => {
    const t = newTest();
    const fresh = await store(t);
    const res = await t.mutation(internal.files.sweepOrphans, { now: Date.now() + HOUR });
    expect(res.orphanBlobs).toBe(0);
    expect(await exists(t, fresh)).toBe(true);
    // ...and is swept once the grace period has passed.
    expect((await t.mutation(internal.files.sweepOrphans, { now: later })).orphanBlobs).toBe(1);
  });

  test("each blob is judged once: a second run finds nothing to scan", async () => {
    const t = newTest();
    await store(t);
    expect((await t.mutation(internal.files.sweepOrphans, { now: later })).orphanBlobs).toBe(1);
    const again = await t.mutation(internal.files.sweepOrphans, { now: later });
    expect(again).toEqual({ expiredIntents: 0, pendingFiles: 0, orphanBlobs: 0, hasMore: false });
  });

  test("work is bounded per run and continues on the next one", async () => {
    const t = newTest();
    const ids = [await store(t), await store(t), await store(t)];
    const first = await t.mutation(internal.files.sweepOrphans, { now: later, batchSize: 2 });
    expect(first).toMatchObject({ orphanBlobs: 2, hasMore: true });
    const second = await t.mutation(internal.files.sweepOrphans, { now: later, batchSize: 2 });
    expect(second).toMatchObject({ orphanBlobs: 1, hasMore: false });
    for (const id of ids) expect(await exists(t, id)).toBe(false);
  });

  test("a full batch schedules the next run", async () => {
    const t = newTest();
    await store(t);
    await store(t);
    await t.mutation(internal.files.sweepOrphans, { now: later, batchSize: 1 });
    const scheduled = await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.some((f) => f.name.includes("sweepOrphans"))).toBe(true);
  });

  test("expired upload intents are removed, live ones kept", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    await t.mutation(api.filesKiosk.generateUploadUrl, { ...s.k, kind: "photo" });
    await t.mutation(api.filesKiosk.generateUploadUrl, { ...s.k, kind: "photo" });
    const [old] = await intents(t);
    await t.run(async (ctx) => ctx.db.patch(old!._id, { expiresAt: Date.now() - 1 }));
    const res = await t.mutation(internal.files.sweepOrphans, { now: Date.now() });
    expect(res.expiredIntents).toBe(1);
    expect(await intents(t)).toHaveLength(1);
  });

  test("registered-but-unclaimed files past their TTL are deleted; attached files are not", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const pending = await s.upload("photo", "image/png", PNG);
    const attached = await s.upload("photo", "image/png", PNG);
    if (pending.res.status !== "ok" || attached.res.status !== "ok") throw new Error("upload failed");
    const attachedId = attached.res.fileId;
    const pendingId = pending.res.fileId;
    await t.run(async (ctx) => {
      await ctx.db.patch(attachedId, { status: "attached", deleteAfter: Date.now() - 1 });
    });
    const res = await t.mutation(internal.files.sweepOrphans, { now: Date.now() + 2 * HOUR });
    expect(res.pendingFiles).toBe(1);
    expect(await exists(t, pending.storageId)).toBe(false);
    expect(await exists(t, attached.storageId)).toBe(true);
    const rows = await files(t);
    expect(rows.find((f) => f._id === pendingId)).toMatchObject({ status: "deleted" });
    expect(rows.find((f) => f._id === attachedId)).toMatchObject({ status: "attached" });
  });

  test("is registered in the cron table", async () => {
    const crons = (await import("../../convex/crons")).default;
    expect(Object.keys(crons.crons)).toContain("abandoned upload sweep");
  });
});

describe("content verification", () => {
  async function registered(s: FormsSetup, kind: "signature" | "photo" | "file" | "id_scan", type: string, data: Uint8Array) {
    const up = await s.upload(kind, type, data);
    if (up.res.status !== "ok") throw new Error("upload failed");
    return { fileId: up.res.fileId, storageId: up.storageId };
  }
  const verify = (t: T, fileId: Id<"files">) => t.action(internal.filesVerify.verify, { fileId });
  const exists = (t: T, id: Id<"_storage">) => t.run(async (ctx) => (await ctx.storage.getUrl(id)) !== null);

  test("an upload is pending until its bytes are checked, then verified", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const { fileId } = await registered(s, "signature", "image/png", PNG);
    expect((await files(t))[0]).toMatchObject({ verifyStatus: "pending" });
    expect(await verify(t, fileId)).toEqual({ status: "verified" });
    expect((await files(t))[0]).toMatchObject({ verifyStatus: "verified", status: "pending" });
    // Running it again does nothing.
    expect(await verify(t, fileId)).toEqual({ status: "skipped" });
  });

  test("bytes that do not match the declared type are deleted and the file is rejected and audited", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const { fileId, storageId } = await registered(s, "photo", "image/png", HTML);
    expect(await verify(t, fileId)).toEqual({ status: "rejected", reason: "unrecognised" });
    expect(await exists(t, storageId)).toBe(false);
    expect((await files(t))[0]).toMatchObject({
      status: "deleted",
      verifyStatus: "rejected",
      rejectedReason: "unrecognised",
    });
    expect((await files(t))[0]!.storageId).toBeUndefined();
    const [entry] = await audit(t, "file.rejected");
    expect(entry).toMatchObject({ resourceId: fileId, metadata: { kind: "photo", reason: "unrecognised", attached: false } });
  });

  test("a real image declared as another type is rejected", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const a = await registered(s, "photo", "image/png", JPEG);
    expect(await verify(t, a.fileId)).toEqual({ status: "rejected", reason: "type_mismatch" });
    // A genuine JPEG declared honestly is fine for a photo.
    const b = await registered(s, "photo", "image/jpeg", JPEG);
    expect(await verify(t, b.fileId)).toEqual({ status: "verified" });
  });

  test("a file whose size changed since registration is rejected", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const { fileId } = await registered(s, "photo", "image/png", PNG);
    await t.run(async (ctx) => ctx.db.patch(fileId, { size: 999 }));
    expect(await verify(t, fileId)).toEqual({ status: "rejected", reason: "size_mismatch" });
  });

  test("a missing blob is rejected rather than left pending", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const { fileId, storageId } = await registered(s, "photo", "image/png", PNG);
    await t.run(async (ctx) => ctx.storage.delete(storageId));
    expect(await verify(t, fileId)).toEqual({ status: "rejected", reason: "missing" });
  });

  test("the whole flow runs from registration: the scheduled action verifies the file", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    // registerUpload (shared by kiosk and invite) with verification switched on; convex-test
    // cannot expose a blob's content type, so the declared type is injected.
    const a = await s.upload("photo", "image/jpeg", JPEG, { verify: true });
    const b = await s.upload("photo", "image/jpeg", HTML, { verify: true });
    const good = a.storageId;
    const bad = b.storageId;
    expect(a.res.status).toBe("ok");
    expect(b.res.status).toBe("ok");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const rows = await files(t);
    expect(rows.find((f) => f.storageId === good)).toMatchObject({ verifyStatus: "verified" });
    expect(rows.find((f) => f.size === HTML.length)).toMatchObject({ verifyStatus: "rejected", status: "deleted" });
    expect(await exists(t, bad)).toBe(false);
  });

  describe("on the form flow", () => {
    async function withAttachedSignature(data: Uint8Array) {
      const t = newTest();
      const s = await formsSetup(t);
      const { versionId } = await s.publishedForm();
      const sig = await registered(s, "signature", "image/png", data);
      await t.mutation(api.kioskForms.submitWalkIn, {
        ...s.k,
        hostUserId: s.host.userId,
        versionId,
        answers: { ...GOOD_ANSWERS, signature: { fileId: sig.fileId } } as never,
      });
      const [visit] = await t.run(async (ctx) => ctx.db.query("visits").collect());
      return { t, s, sig, visitId: visit!._id };
    }

    test("an unverified file cannot be opened; a verified one can", async () => {
      const { t, s, sig } = await withAttachedSignature(PNG);
      await expectCode(s.reception.as.mutation(api.forms.openFile, { ...s.orgArg, fileId: sig.fileId }), "CONFLICT");
      expect(await audit(t, "file.read")).toHaveLength(0);
      await verify(t, sig.fileId);
      const opened = await s.reception.as.mutation(api.forms.openFile, { ...s.orgArg, fileId: sig.fileId });
      expect(opened.url).toBeTruthy();
      expect(await audit(t, "file.read")).toHaveLength(1);
    });

    test("a file rejected after it was attached is flagged on the response and cannot be opened", async () => {
      const { t, s, sig, visitId } = await withAttachedSignature(HTML);
      expect(await verify(t, sig.fileId)).toMatchObject({ status: "rejected" });
      const [response] = await s.reception.as.query(api.forms.visitResponses, { ...s.orgArg, visitId });
      const item = response!.items.find((i) => i.id === "signature");
      expect(item).toMatchObject({ file: { deleted: true, rejected: true, verified: false } });
      await expectCode(s.reception.as.mutation(api.forms.openFile, { ...s.orgArg, fileId: sig.fileId }), "NOT_FOUND");
      expect((await audit(t, "file.rejected"))[0]!.metadata).toMatchObject({ attached: true });
    });

    test("a rejected upload cannot be claimed by a later submission", async () => {
      const t = newTest();
      const s = await formsSetup(t);
      const { versionId } = await s.publishedForm();
      const sig = await registered(s, "signature", "image/png", HTML);
      await verify(t, sig.fileId);
      await expectCode(
        t.mutation(api.kioskForms.submitWalkIn, {
          ...s.k,
          hostUserId: s.host.userId,
          versionId,
          answers: { ...GOOD_ANSWERS, signature: { fileId: sig.fileId } } as never,
        }),
        "VALIDATION",
      );
      expect(await t.run(async (ctx) => ctx.db.query("visits").collect())).toHaveLength(0);
    });

    test("files stored before verification existed can be queued", async () => {
      const t = newTest();
      const s = await formsSetup(t);
      const { fileId } = await registered(s, "signature", "image/png", PNG);
      await t.run(async (ctx) => ctx.db.patch(fileId, { status: "attached", verifyStatus: undefined }));
      expect(await t.mutation(internal.filesVerify.requeueLegacy, {})).toBe(1);
      expect((await files(t))[0]).toMatchObject({ verifyStatus: "pending" });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect((await files(t))[0]).toMatchObject({ verifyStatus: "verified" });
    });
  });
});
