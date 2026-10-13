import { FILE_LIMITS, type FileKind } from "../validation/forms";

/**
 * Content verification by magic bytes. Uploaded files carry a content type
 * the CLIENT declared; this module checks the actual bytes against it. Pure
 * functions so they can be unit-tested and run inside a Convex action.
 */

export type SniffedType = "image/jpeg" | "image/png" | "image/webp" | "application/pdf";

/** How many leading bytes `sniffContentType` needs. */
export const SNIFF_BYTES = 16;

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0) =>
  b.length >= at + sig.length && sig.every((x, i) => b[at + i] === x);

/** The type the bytes really are, or null when they match no allowed format. */
export function sniffContentType(head: Uint8Array): SniffedType | null {
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  // RIFF....WEBP
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  // %PDF-
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  return null;
}

export type VerifyResult =
  | { ok: true; contentType: SniffedType }
  | { ok: false; reason: "too_large" | "empty" | "unrecognised" | "type_mismatch" | "not_allowed" | "size_mismatch" };

/**
 * Check a stored blob: its real type must be one this `kind` allows AND equal
 * the type declared at upload; its size must match what was recorded and stay
 * within the limit. Signatures are PNG only (FILE_LIMITS).
 */
export function verifyBlobBytes(input: {
  kind: FileKind;
  declaredType: string;
  recordedSize: number;
  actualSize: number;
  head: Uint8Array;
}): VerifyResult {
  const limits = FILE_LIMITS[input.kind];
  if (input.actualSize <= 0) return { ok: false, reason: "empty" };
  if (input.actualSize > limits.maxBytes) return { ok: false, reason: "too_large" };
  if (input.actualSize !== input.recordedSize) return { ok: false, reason: "size_mismatch" };
  const real = sniffContentType(input.head);
  if (!real) return { ok: false, reason: "unrecognised" };
  if (!limits.types.includes(real)) return { ok: false, reason: "not_allowed" };
  if (real !== input.declaredType.toLowerCase()) return { ok: false, reason: "type_mismatch" };
  return { ok: true, contentType: real };
}
