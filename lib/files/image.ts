/**
 * Shrink a phone photo before upload: long side at most `maxDim` px, JPEG.
 * Falls back to the original blob if the browser cannot decode it.
 */
export async function downscaleImage(blob: Blob, maxDim = 1600, quality = 0.82): Promise<Blob> {
  if (typeof createImageBitmap !== "function") return blob;
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return blob;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b ?? blob), "image/jpeg", quality));
  } catch {
    return blob;
  }
}

/** POST bytes to a Convex upload URL and return the storage id. */
export async function postBlob(uploadUrl: string, blob: Blob): Promise<string> {
  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": blob.type || "application/octet-stream" },
    body: blob,
  });
  if (!res.ok) throw new Error("Upload failed.");
  const json = (await res.json()) as { storageId?: unknown };
  if (typeof json.storageId !== "string") throw new Error("Upload failed.");
  return json.storageId;
}

export const UPLOAD_REJECTED_MESSAGES = {
  too_large: "That file is too large. Please try a smaller one.",
  bad_type: "That file type is not allowed.",
  missing: "The upload did not complete. Please try again.",
} as const;
