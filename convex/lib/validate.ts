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
