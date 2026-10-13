import { stubIdReader } from "./stub";
import type { IdReader } from "./types";

export type { IdFieldKey, IdReadResult, IdReader } from "./types";
export { stubIdReader } from "./stub";

/** The configured reader. Swap the return value when an OCR provider is chosen. */
export function getIdReader(): IdReader {
  return stubIdReader;
}
