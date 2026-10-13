import { answerRetentionDays, DAY_MS, type Retention } from "./retention";
import { FILE_TYPES, isRedactedAnswer, type FormField } from "./validation/forms";

/**
 * Pure planning for per-field answer retention (the Convex job in
 * convex/formRetention.ts applies the plan). Kept free of database types so it
 * is unit-testable.
 */

/** Far future: nothing left to redact on this response. */
export const NO_REDACTION_DUE = 8_640_000_000_000_000;
/** A response is looked at again at least this often, so shortened org settings catch up. */
export const REDACTION_RECHECK_MS = 30 * DAY_MS;

type Audience = "visitor" | "staff";

/** When this field's answer must be gone, given when the response was made. */
export function answerDeadline(
  createdAt: number,
  field: Pick<FormField, "retentionDays"> | undefined,
  audience: Audience,
  retention?: Partial<Retention> | null,
): number {
  return createdAt + answerRetentionDays(field?.retentionDays, audience, retention) * DAY_MS;
}

/** Answers this job may redact: everything except file references (those follow the file's own deletion) and tombstones. */
function redactable(fields: readonly FormField[], answers: Record<string, unknown>) {
  const byId = new Map(fields.map((f) => [f.id, f]));
  return Object.keys(answers).flatMap((id) => {
    const value = answers[id];
    if (isRedactedAnswer(value)) return [];
    if (typeof value === "object" && value !== null && !Array.isArray(value) && "fileId" in value) return [];
    const field = byId.get(id);
    if (field && FILE_TYPES.includes(field.type) && typeof value === "object") return [];
    return [{ id, field }];
  });
}

export type RedactionPlan = {
  /** Answer keys to replace with a tombstone now. */
  redact: string[];
  /** How many of those belong to sensitive fields (counts only, for the audit entry). */
  sensitive: number;
  /** When to look at this response again. */
  nextCheck: number;
};

export function planRedaction(input: {
  fields: readonly FormField[];
  answers: Record<string, unknown>;
  createdAt: number;
  audience: Audience;
  retention?: Partial<Retention> | null;
  now: number;
}): RedactionPlan {
  const redact: string[] = [];
  let sensitive = 0;
  let nextDeadline = NO_REDACTION_DUE;
  for (const { id, field } of redactable(input.fields, input.answers)) {
    const deadline = answerDeadline(input.createdAt, field, input.audience, input.retention);
    if (deadline <= input.now) {
      redact.push(id);
      if (field?.sensitive) sensitive++;
    } else {
      nextDeadline = Math.min(nextDeadline, deadline);
    }
  }
  // Nothing left that could ever be redacted: park the row.
  const nextCheck =
    nextDeadline === NO_REDACTION_DUE ? NO_REDACTION_DUE : Math.min(nextDeadline, input.now + REDACTION_RECHECK_MS);
  return { redact, sensitive, nextCheck };
}

/** The first check time for a brand-new response (used when it is stored). */
export function initialRedactionCheck(input: {
  fields: readonly FormField[];
  answers: Record<string, unknown>;
  createdAt: number;
  audience: Audience;
  retention?: Partial<Retention> | null;
}): number {
  return planRedaction({ ...input, now: input.createdAt }).nextCheck;
}
