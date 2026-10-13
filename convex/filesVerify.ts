import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { SNIFF_BYTES, verifyBlobBytes } from "../lib/files/magic";
import { writeAudit } from "./lib/audit";
import { deleteBlob } from "./lib/files";

/**
 * Content verification for uploads. Mutations cannot read blobs, so this runs
 * as an action scheduled by `registerUpload`:
 *
 *   verify (action)  -> reads the blob, checks magic bytes, declared type and size
 *   apply  (mutation)-> marks the file `verified`, or deletes the bytes and
 *                       marks it `rejected` (the answer then shows "rejected")
 *
 * Until a file is `verified` it cannot be opened (`forms.openFile`). A file
 * may be attached to a response while verification is still running; if it is
 * then rejected, its bytes are gone and the answer says so.
 */

export const load = internalQuery({
  args: { fileId: v.id("files") },
  handler: async (ctx, { fileId }) => await ctx.db.get(fileId),
});

export type VerifyOutcome =
  | { status: "skipped" }
  | { status: "verified" }
  | { status: "rejected"; reason: string };

export const verify = internalAction({
  args: { fileId: v.id("files") },
  handler: async (ctx, { fileId }): Promise<VerifyOutcome> => {
    const file = await ctx.runQuery(internal.filesVerify.load, { fileId });
    if (!file || file.status === "deleted" || !file.storageId || file.verifyStatus !== "pending") {
      return { status: "skipped" };
    }
    const blob = await ctx.storage.get(file.storageId);
    let reason: string | null;
    if (!blob) {
      reason = "missing";
    } else {
      const head = new Uint8Array(await blob.slice(0, SNIFF_BYTES).arrayBuffer());
      const res = verifyBlobBytes({
        kind: file.kind,
        declaredType: file.contentType,
        recordedSize: file.size,
        actualSize: blob.size,
        head,
      });
      reason = res.ok ? null : res.reason;
    }
    return await ctx.runMutation(internal.filesVerify.apply, { fileId, reason: reason ?? undefined });
  },
});

export const apply = internalMutation({
  args: { fileId: v.id("files"), reason: v.optional(v.string()) },
  handler: async (ctx, { fileId, reason }): Promise<VerifyOutcome> => {
    const file = await ctx.db.get(fileId);
    if (!file || file.status === "deleted" || file.verifyStatus !== "pending") return { status: "skipped" };
    if (!reason) {
      await ctx.db.patch(fileId, { verifyStatus: "verified", verifiedAt: Date.now() });
      return { status: "verified" };
    }
    if (file.storageId) await deleteBlob(ctx, file.storageId);
    await ctx.db.patch(fileId, {
      status: "deleted",
      storageId: undefined,
      verifyStatus: "rejected",
      rejectedReason: reason,
    });
    await writeAudit(ctx, {
      organizationId: file.organizationId,
      action: "file.rejected",
      resourceType: "file",
      resourceId: fileId,
      metadata: { kind: file.kind, reason, attached: file.responseId !== undefined },
    });
    return { status: "rejected", reason };
  },
});

/**
 * Files stored before verification existed have no `verifyStatus` and cannot
 * be opened. Run once (dashboard or `npx convex run filesVerify:requeueLegacy`)
 * to queue them; repeat while it reports a full batch.
 */
export const requeueLegacy = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const rows = await ctx.db
      .query("files")
      .withIndex("by_status_delete_after", (q) => q.eq("status", "attached"))
      .take(200);
    let queued = 0;
    for (const f of rows) {
      if (f.verifyStatus !== undefined) continue;
      await ctx.db.patch(f._id, { verifyStatus: "pending" });
      await ctx.scheduler.runAfter(0, internal.filesVerify.verify, { fileId: f._id });
      queued++;
    }
    return queued;
  },
});
