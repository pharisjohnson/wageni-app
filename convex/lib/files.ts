import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { FILE_LIMITS, PENDING_FILE_TTL_MS, type FileKind } from "../../lib/validation/forms";
import { writeAudit } from "./audit";

/**
 * File storage rules. Files are private Convex storage objects. Nothing here
 * ever returns a URL: URLs are minted only by permission-checked mutations in
 * convex/forms.ts (and audited). Uploads go through two steps:
 *   1. an authorised mutation returns an upload URL (kiosk token, or a valid
 *      invitation token);
 *   2. after the browser POSTs the bytes, `registerUpload` checks size and
 *      content type from Convex's storage metadata and records a `pending`
 *      file.
 * Pending files are deleted after `PENDING_FILE_TTL_MS` unless a response
 * claims them (`attached`). Every file has `deleteAfter`.
 */

/**
 * Size and content type of an uploaded object. Convex fills `contentType`
 * from the Content-Type header the uploader sent, so it is CLIENT-DECLARED:
 * a missing or disallowed value is rejected, but the bytes are not inspected
 * (mutations cannot read blobs; magic-byte checks would need an action).
 * Files are therefore only ever shown as images or offered as downloads.
 */
export type StorageMeta = { size: number; contentType?: string };

export async function readStorageMeta(ctx: MutationCtx, storageId: Id<"_storage">): Promise<StorageMeta | null> {
  return await ctx.db.system.get(storageId);
}

export type Uploader =
  | { kioskDeviceId: Id<"kioskDevices"> }
  | { invitationId: Id<"invitations"> };

export type RegisterResult =
  | { status: "ok"; fileId: Id<"files"> }
  | { status: "rejected"; reason: "too_large" | "bad_type" | "missing" };

/**
 * Validate an uploaded blob against the limits for `kind` and record it.
 * On a violation the bytes are deleted and `{status:"rejected"}` is RETURNED
 * (a throw would roll the deletion back and leave the blob stored).
 */
export async function registerUpload(
  ctx: MutationCtx,
  input: {
    organizationId: Id<"organizations">;
    siteId?: Id<"sites">;
    storageId: Id<"_storage">;
    kind: FileKind;
    uploader: Uploader;
  },
  /** Injection point for tests (convex-test does not expose content types). */
  readMeta: typeof readStorageMeta = readStorageMeta,
): Promise<RegisterResult> {
  const meta = await readMeta(ctx, input.storageId);
  if (!meta) return { status: "rejected", reason: "missing" };
  // A storage id can be registered once, so one upload cannot back many records.
  const taken = await ctx.db
    .query("files")
    .withIndex("by_storage", (q) => q.eq("storageId", input.storageId))
    .first();
  if (taken) return { status: "rejected", reason: "missing" };
  const limits = FILE_LIMITS[input.kind];
  if (meta.size > limits.maxBytes) {
    await ctx.storage.delete(input.storageId);
    return { status: "rejected", reason: "too_large" };
  }
  const contentType = (meta.contentType ?? "").toLowerCase();
  if (!limits.types.includes(contentType)) {
    await ctx.storage.delete(input.storageId);
    return { status: "rejected", reason: "bad_type" };
  }
  const now = Date.now();
  const fileId = await ctx.db.insert("files", {
    organizationId: input.organizationId,
    siteId: input.siteId,
    storageId: input.storageId,
    kind: input.kind,
    contentType,
    size: meta.size,
    status: "pending",
    uploadedByDeviceId: "kioskDeviceId" in input.uploader ? input.uploader.kioskDeviceId : undefined,
    uploadedByInvitationId: "invitationId" in input.uploader ? input.uploader.invitationId : undefined,
    deleteAfter: now + PENDING_FILE_TTL_MS,
    createdAt: now,
  });
  return { status: "ok", fileId };
}

/** True when `file` was uploaded by `uploader` (and so may be attached by them). */
export function uploadedBy(file: Doc<"files">, uploader: Uploader): boolean {
  if ("kioskDeviceId" in uploader) return file.uploadedByDeviceId === uploader.kioskDeviceId;
  return file.uploadedByInvitationId === uploader.invitationId;
}

/**
 * Delete bytes of files past `deleteAfter` (and pending uploads nobody
 * claimed). The `files` row stays with status "deleted" so an answer can say
 * the file was removed. Returns how many were deleted.
 */
export async function deleteExpiredFiles(ctx: MutationCtx, now: number, batch = 100): Promise<number> {
  let deleted = 0;
  for (const status of ["pending", "attached"] as const) {
    const expired = await ctx.db
      .query("files")
      .withIndex("by_status_delete_after", (q) => q.eq("status", status).lt("deleteAfter", now))
      .take(batch);
    for (const file of expired) {
      if (file.storageId) await ctx.storage.delete(file.storageId);
      await ctx.db.patch(file._id, { status: "deleted", storageId: undefined });
      await writeAudit(ctx, {
        organizationId: file.organizationId,
        action: "file.deleted_retention",
        resourceType: "file",
        resourceId: file._id,
        metadata: { kind: file.kind, status },
      });
      deleted++;
    }
  }
  return deleted;
}
