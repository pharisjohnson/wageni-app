"use client";

import { useMemo } from "react";
import type { FileUploader } from "@/components/forms-builder/capture-field";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { postBlob, UPLOAD_REJECTED_MESSAGES } from "@/lib/files/image";
import type { useKioskApi } from "./use-kiosk-api";

/**
 * Uploads from a kiosk form go straight to private storage with a one-shot URL
 * from `filesKiosk`; the form answer only keeps the registered file id. The
 * server checks size and type at registration and the bytes afterwards.
 */
export function useKioskUploader(kiosk: ReturnType<typeof useKioskApi>): FileUploader {
  return useMemo<FileUploader>(
    () => async (kind, blob) => {
      try {
        const url = await kiosk.mutation(api.filesKiosk.generateUploadUrl, { kind });
        const storageId = (await postBlob(url, blob)) as Id<"_storage">;
        const res = await kiosk.mutation(api.filesKiosk.registerUploaded, { storageId, kind });
        if (res.status !== "ok") throw new Error(UPLOAD_REJECTED_MESSAGES[res.reason]);
        return res.fileId;
      } catch (e) {
        throw new Error(e instanceof Error && e.message ? e.message : "Upload failed. Please try again.");
      }
    },
    [kiosk],
  );
}
