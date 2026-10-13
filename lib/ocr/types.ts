/**
 * ID reading is a swappable interface. The OCR vendor decision is pending, so
 * no real engine is integrated: see `stubIdReader`. Whatever implementation is
 * plugged in, its output is only a SUGGESTION: the visitor must confirm or
 * correct every pre-filled value, and it is never trusted blindly.
 */
export type IdFieldKey = "fullName" | "idNumber" | "dateOfBirth" | "expiry" | "documentType";

export type IdReadResult = {
  fields: Partial<Record<IdFieldKey, { value: string; confidence: number }>>;
};

export interface IdReader {
  read(image: Blob): Promise<IdReadResult>;
}
