import type { IdReader } from "./types";

/**
 * Placeholder reader: returns NO fields. It exists so the whole ID-scan flow
 * (capture, preview, suggest, confirm, discard) works end to end while the OCR
 * provider is undecided. With this reader the visitor simply types their
 * details. It never sends the image anywhere.
 *
 * To integrate a real engine, implement `IdReader` and return it from
 * `getIdReader()` in `lib/ocr/index.ts`. Do that only after a privacy review:
 * a cloud engine means the ID image leaves the device.
 */
export const stubIdReader: IdReader = {
  async read() {
    return { fields: {} };
  },
};
