import type { z } from "zod";
import { appError } from "./errors";

/** Parse with a shared Zod schema, converting failures to a safe VALIDATION error. */
export function parseOrThrow<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const first = result.error.issues[0];
    const field = first?.path.join(".");
    throw appError("VALIDATION", first ? `${field ? `${field}: ` : ""}${first.message}` : undefined);
  }
  return result.data;
}

/** Largest page a client may ask for (H1: `numItems` is client-controlled). */
export const MAX_PAGE_SIZE = 100;

/** Cap a client-supplied page size so one call cannot read an unbounded slice of a table. */
export function clampPagination<T extends { numItems: number }>(opts: T): T {
  const n = Number.isFinite(opts.numItems) ? Math.floor(opts.numItems) : MAX_PAGE_SIZE;
  return { ...opts, numItems: Math.min(MAX_PAGE_SIZE, Math.max(1, n)) };
}
