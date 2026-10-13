import { v } from "convex/values";
import { kioskMutation } from "./lib/kiosk";
import { openUploadIntent, registerUpload } from "./lib/files";
import { takePublicLimit } from "./lib/publicLimit";
import { vFileKind } from "./validators";

/**
 * File uploads from a paired kiosk. Both functions are `kioskMutation`s, so a
 * missing/revoked device token gets the generic NOT_FOUND and nothing is
 * stored. The kiosk can only upload; it can never read a file back.
 */

const UPLOADS_PER_WINDOW = 30;
const UPLOAD_WINDOW_MS = 5 * 60_000;

/** Step 1: a one-shot upload URL. */
export const generateUploadUrl = kioskMutation({
  args: { kind: vFileKind },
  handler: async (ctx, { kind }) => {
    await takePublicLimit(ctx, `upload:${ctx.kiosk.device._id}`, UPLOADS_PER_WINDOW, UPLOAD_WINDOW_MS);
    await openUploadIntent(ctx, ctx.kiosk.org._id, { kioskDeviceId: ctx.kiosk.device._id }, kind);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Step 2: after the browser POSTed the bytes, record the file. Size and type
 * come from Convex's own metadata, not from the client. A violation deletes
 * the bytes and returns `{ status: "rejected" }`.
 */
export const registerUploaded = kioskMutation({
  args: { storageId: v.id("_storage"), kind: vFileKind },
  handler: async (ctx, { storageId, kind }) => {
    const { org, site, device } = ctx.kiosk;
    return await registerUpload(ctx, {
      organizationId: org._id,
      siteId: site._id,
      storageId,
      kind,
      uploader: { kioskDeviceId: device._id },
    });
  },
});
