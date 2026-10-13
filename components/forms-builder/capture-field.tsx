"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { downscaleImage } from "@/lib/files/image";
import { getIdReader, type IdReadResult, type IdReader } from "@/lib/ocr";
import { fileKindForField, type FileKind, type FormField } from "@/lib/validation/forms";
import { SignaturePad } from "./signature-pad";

/** Uploads a blob and returns the id of the stored file record. Throws with a safe message. */
export type FileUploader = (kind: FileKind, blob: Blob) => Promise<string>;

type Props = {
  field: FormField;
  value: unknown;
  onChange: (value: unknown) => void;
  uploader: FileUploader;
  large?: boolean;
  /** id_scan only: receives what the reader found, to pre-fill mapped fields as suggestions. */
  onIdRead?: (result: IdReadResult) => void;
  idReader?: IdReader;
  invalid?: boolean;
  describedBy?: string;
};

/**
 * Camera / file / signature / ID capture. The picked file is downscaled,
 * previewed, then uploaded (or, for an ID scan without `storeImage`, read and
 * discarded: only `{ scanned: true }` is kept).
 */
export function CaptureField({ field, value, onChange, uploader, large, onIdRead, idReader, invalid, describedBy }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const kind = fileKindForField(field.type)!;
  const done = Boolean(value);

  // Free the object URL when it changes or the field unmounts.
  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  async function upload(blob: Blob) {
    setBusy(true);
    setError(null);
    try {
      onChange({ fileId: await uploader(kind, blob) });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function picked(file: File | undefined) {
    if (!file) return;
    setError(null);
    setNote(null);
    const isImage = field.type !== "file_upload" || file.type.startsWith("image/");
    const blob = isImage && file.type.startsWith("image/") ? await downscaleImage(file) : file;
    if (isImage) setPreview(URL.createObjectURL(blob));
    if (field.type === "id_scan") {
      setBusy(true);
      try {
        const result = await (idReader ?? getIdReader()).read(blob);
        onIdRead?.(result);
        const found = Object.keys(result.fields).length;
        setNote(
          found > 0
            ? "We filled in some details from your ID. Please check each one."
            : "We could not read your ID automatically. Please type your details.",
        );
      } catch {
        setNote("We could not read your ID automatically. Please type your details.");
      } finally {
        setBusy(false);
      }
      if (field.storeImage) {
        await upload(blob);
      } else {
        // Read and discard: the image is never uploaded or kept.
        setPreview(null);
        onChange({ scanned: true });
      }
      return;
    }
    await upload(blob);
  }

  function remove() {
    setPreview(null);
    setNote(null);
    setError(null);
    onChange(undefined);
    if (input.current) input.current.value = "";
  }

  const size = large ? "lg" : "default";
  const accept = field.type === "file_upload" ? "application/pdf,image/jpeg,image/png" : "image/*";
  // Front camera for faces, rear camera for documents.
  const capture = field.type === "face_photo" ? "user" : field.type === "file_upload" ? undefined : "environment";
  const verb =
    field.type === "id_scan" ? "Scan your ID" : field.type === "file_upload" ? "Choose a file" : "Take a photo";

  return (
    <div className="space-y-3" aria-describedby={describedBy} aria-invalid={invalid || undefined}>
      {field.type === "signature" ? (
        done ? (
          <p className="text-sm text-muted-foreground">Signature saved.</p>
        ) : (
          <SignaturePad large={large} disabled={busy} onSave={upload} />
        )
      ) : (
        <>
          <input
            ref={input}
            type="file"
            accept={accept}
            capture={capture}
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => void picked(e.target.files?.[0])}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size={size} variant={done ? "outline" : "default"} disabled={busy} onClick={() => input.current?.click()}>
              {busy ? "Working…" : done ? "Replace" : verb}
            </Button>
          </div>
          {preview && (
            // eslint-disable-next-line @next/next/no-img-element -- local object URL preview
            <img src={preview} alt="Preview of the image you took" className="max-h-56 rounded-lg border" />
          )}
          {field.type === "id_scan" && done && !field.storeImage && (
            <p className="text-sm text-muted-foreground">Your ID image was read and not kept.</p>
          )}
        </>
      )}
      {done && field.type !== "id_scan" && field.type !== "signature" && (
        <p className="text-sm text-muted-foreground">Added.</p>
      )}
      {done && (
        <Button type="button" variant="ghost" size={size} onClick={remove} disabled={busy}>
          {field.type === "signature" ? "Sign again" : "Remove"}
        </Button>
      )}
      {note && <p role="status" className="text-sm text-muted-foreground">{note}</p>}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
