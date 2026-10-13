import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { FILE_LIMITS, PENDING_FILE_TTL_MS, type FileKind } from "../../lib/validation/forms";
import { writeAudit } from "./audit";
import { appError } from "./errors";

/**
 * File storage rules. Files are private Convex storage objects. Nothing here
 * ever returns a URL: URLs are minted only by permission-checked mutations in
 * convex/forms.ts (and audited). Uploads go through these steps:
 *   1. an authorised mutation returns an upload URL (kiosk token, or a valid
 *      invitation token) and records an `uploadIntents` row;
 *   2. after the browser POSTs the bytes, `registerUpload` checks size and
 *      declared content type from Convex's storage metadata, records a
 *      `pending` file, clears the intent and schedules content verification;
 *   3. `internal.filesVerify.verify` (an action, the only place bytes can be
 *      read) checks the magic bytes against the declared type. Only then is
 *      the file `verified` and openable; otherwise the bytes are deleted.
 * Pending files are deleted after `PENDING_FILE_TTL_MS` unless a response
 * claims them (`attached`). Every file has `deleteAfter`. Blobs that were
 * uploaded but never registered are removed by `sweepOrphanUploads`.
 */

/** An unregistered upload is an orphan once its URL's intent has expired. */
export const UPLOAD_INTENT_TTL_MS = PENDING_FILE_TTL_MS;
/** Blobs are only judged orphaned this long after their intent could have expired. */
export const ORPHAN_GRACE_MS = 2 * 60 * 60 * 1000;
/** Upload URLs one uploader may hold at the same time. */
export const MAX_OPEN_INTENTS = 20;
const WATERMARK_KEY = "orphan_scan_watermark";

/**
 * Size and content type of an uploaded object. Convex fills `contentType`
 * from the Content-Type header the uploader sent, so it is CLIENT-DECLARED:
 * a missing or disallowed value is rejected here, and the bytes are checked
 * afterwards by the verification action (mutations cannot read blobs).
 */
export type StorageMeta = { size: number; contentType?: string };

export async function readStorageMeta(ctx: MutationCtx, storageId: Id<"_storage">): Promise<StorageMeta | null> {
  return await ctx.db.system.get(storageId);
}

/** Remove a stored blob if it is still there (removing a missing one throws). */
export async function deleteBlob(ctx: MutationCtx, storageId: Id<"_storage">): Promise<void> {
  if (await ctx.db.system.get(storageId)) await ctx.storage.delete(storageId);
}

export type Uploader =
  | { kioskDeviceId: Id<"kioskDevices"> }
  | { invitationId: Id<"invitations"> };

export type RegisterResult =
  | { status: "ok"; fileId: Id<"files"> }
  | { status: "rejected"; reason: "too_large" | "bad_type" | "missing" };

// ---------- Upload intents ----------

/**
 * Record that `uploader` was handed an upload URL. Refuses (RATE_LIMITED)
 * when the uploader already holds too many unexpired, unregistered URLs.
 */
export async function openUploadIntent(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  uploader: Uploader,
  kind: FileKind,
): Promise<void> {
  const now = Date.now();
  const rows =
    "kioskDeviceId" in uploader
      ? await ctx.db
          .query("uploadIntents")
          .withIndex("by_device", (q) => q.eq("kioskDeviceId", uploader.kioskDeviceId))
          .order("desc")
          .take(MAX_OPEN_INTENTS)
      : await ctx.db
          .query("uploadIntents")
          .withIndex("by_invitation", (q) => q.eq("invitationId", uploader.invitationId))
          .order("desc")
          .take(MAX_OPEN_INTENTS);
  if (rows.filter((r) => r.expiresAt > now).length >= MAX_OPEN_INTENTS) throw appError("RATE_LIMITED");
  await ctx.db.insert("uploadIntents", {
    organizationId,
    kioskDeviceId: "kioskDeviceId" in uploader ? uploader.kioskDeviceId : undefined,
    invitationId: "invitationId" in uploader ? uploader.invitationId : undefined,
    kind,
    createdAt: now,
    expiresAt: now + UPLOAD_INTENT_TTL_MS,
  });
}

/** An upload was registered: remove the oldest open intent of that uploader and kind. */
async function clearUploadIntent(ctx: MutationCtx, uploader: Uploader, kind: FileKind): Promise<void> {
  const rows =
    "kioskDeviceId" in uploader
      ? await ctx.db
          .query("uploadIntents")
          .withIndex("by_device", (q) => q.eq("kioskDeviceId", uploader.kioskDeviceId))
          .take(MAX_OPEN_INTENTS + 5)
      : await ctx.db
          .query("uploadIntents")
          .withIndex("by_invitation", (q) => q.eq("invitationId", uploader.invitationId))
          .take(MAX_OPEN_INTENTS + 5);
  const hit = rows.find((r) => r.kind === kind);
  if (hit) await ctx.db.delete(hit._id);
}

// ---------- Registration ----------

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
    /** Tests that register fake bytes pass `false` so no verification runs. */
    verify?: boolean;
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
    await clearUploadIntent(ctx, input.uploader, input.kind);
    return { status: "rejected", reason: "too_large" };
  }
  const contentType = (meta.contentType ?? "").toLowerCase();
  if (!limits.types.includes(contentType)) {
    await ctx.storage.delete(input.storageId);
    await clearUploadIntent(ctx, input.uploader, input.kind);
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
    verifyStatus: "pending",
    uploadedByDeviceId: "kioskDeviceId" in input.uploader ? input.uploader.kioskDeviceId : undefined,
    uploadedByInvitationId: "invitationId" in input.uploader ? input.uploader.invitationId : undefined,
    deleteAfter: now + PENDING_FILE_TTL_MS,
    createdAt: now,
  });
  await clearUploadIntent(ctx, input.uploader, input.kind);
  if (input.verify !== false) await ctx.scheduler.runAfter(0, internal.filesVerify.verify, { fileId });
  return { status: "ok", fileId };
}

/** True when `file` was uploaded by `uploader` (and so may be attached by them). */
export function uploadedBy(file: Doc<"files">, uploader: Uploader): boolean {
  if ("kioskDeviceId" in uploader) return file.uploadedByDeviceId === uploader.kioskDeviceId;
  return file.uploadedByInvitationId === uploader.invitationId;
}

// ---------- Retention and sweeps ----------

/**
 * Delete bytes of files past `deleteAfter` (and pending uploads nobody
 * claimed). The `files` row stays with status "deleted" so an answer can say
 * the file was removed. Returns how many were deleted.
 */
export async function deleteExpiredFiles(
  ctx: MutationCtx,
  now: number,
  batch = 100,
  statuses: readonly ("pending" | "attached")[] = ["pending", "attached"],
): Promise<number> {
  let deleted = 0;
  for (const status of statuses) {
    const expired = await ctx.db
      .query("files")
      .withIndex("by_status_delete_after", (q) => q.eq("status", status).lt("deleteAfter", now))
      .take(batch);
    for (const file of expired) {
      if (file.storageId) await deleteBlob(ctx, file.storageId);
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

export type OrphanSweepResult = {
  expiredIntents: number;
  pendingFiles: number;
  orphanBlobs: number;
  hasMore: boolean;
};

/**
 * Remove upload leftovers, in bounded batches:
 *  - expired `uploadIntents` (an upload URL that was never followed by a
 *    registration);
 *  - registered-but-unclaimed (`pending`) files past their TTL, bytes included;
 *  - blobs in Convex storage with no `files` row. These are found by walking
 *    the storage table in creation order from a persisted watermark up to
 *    `now - ORPHAN_GRACE_MS`, so each blob is judged once, after the window in
 *    which its uploader could still register it.
 *
 * Assumption: every blob in this deployment's storage comes from the upload
 * flows above. Anything else stored here without a `files` row would be
 * deleted by this sweep.
 */
export async function sweepOrphanUploads(ctx: MutationCtx, now: number, batch: number): Promise<OrphanSweepResult> {
  const intents = await ctx.db
    .query("uploadIntents")
    .withIndex("by_expires", (q) => q.lt("expiresAt", now))
    .take(batch);
  for (const row of intents) await ctx.db.delete(row._id);

  const pendingFiles = await deleteExpiredFiles(ctx, now, batch, ["pending"]);

  const state = await ctx.db
    .query("sweepState")
    .withIndex("by_key", (q) => q.eq("key", WATERMARK_KEY))
    .unique();
  const from = state?.value ?? 0;
  const cutoff = now - ORPHAN_GRACE_MS;
  const blobs = await ctx.db.system
    .query("_storage")
    .withIndex("by_creation_time", (q) => q.gt("_creationTime", from).lt("_creationTime", cutoff))
    .take(batch);
  let orphanBlobs = 0;
  for (const blob of blobs) {
    const row = await ctx.db
      .query("files")
      .withIndex("by_storage", (q) => q.eq("storageId", blob._id))
      .first();
    if (!row) {
      await ctx.storage.delete(blob._id);
      orphanBlobs++;
    }
  }
  const last = blobs[blobs.length - 1];
  if (last) {
    if (state) await ctx.db.patch(state._id, { value: last._creationTime });
    else await ctx.db.insert("sweepState", { key: WATERMARK_KEY, value: last._creationTime });
  }
  return {
    expiredIntents: intents.length,
    pendingFiles,
    orphanBlobs,
    hasMore: intents.length >= batch || blobs.length >= batch || pendingFiles >= batch,
  };
}
