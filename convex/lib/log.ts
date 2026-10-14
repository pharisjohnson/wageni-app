/**
 * Structured, PII-free logging for Convex functions (H1).
 *
 * One JSON line per event on stdout, so the Convex dashboard Logs page, a log
 * stream/drain (Axiom, Datadog, ...) and `npx convex logs` can all filter on
 * the same fields:
 *
 *   {"app":"wageni","level":"warn","event":"rate_limited","fn":"kiosk.meter",
 *    "outcome":"rejected","org":"<organization id>","code":"RATE_LIMITED"}
 *
 * Rules, enforced in code, not by convention:
 *  - Only the fields below can be logged. There is no free-form message and
 *    no way to pass a name, phone, email, token, answer or badge code.
 *  - Values are ids, enums, numbers and booleans. Any string longer than 64
 *    characters, or that looks like an email, phone number or token, is
 *    replaced with "[redacted]" as a second line of defence.
 *  - Logging can never throw into business code.
 *
 * Alert names and thresholds that rely on these events are listed in
 * docs/deployment.md (Runbook).
 */
export type LogLevel = "info" | "warn" | "error";

export type LogFields = {
  /** Stable machine-readable event name, snake_case: "rate_limited", "webhook_rejected". */
  event: string;
  /** Function or module that emitted it, e.g. "kioskVisitor.checkOut". */
  fn: string;
  outcome?: "ok" | "rejected" | "failed" | "locked" | "skipped";
  /** Organization id (an opaque Convex id, not a name). */
  org?: string;
  /** AppErrorCode or short provider/HTTP status code. */
  code?: string;
  /** Small numeric facts: counts, durations, attempt number, lock level. */
  count?: number;
  durationMs?: number;
  /** Correlation id supplied by the caller (never derived from user input). */
  requestId?: string;
};

const MAX_STRING = 64;
const SUSPICIOUS = /@|\+?\d[\d\s().-]{6,}\d|^(wk_|sk_|pk_|whsec_|eyJ)|[A-Za-z0-9_-]{40,}/;

function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length > MAX_STRING || SUSPICIOUS.test(value)) return "[redacted]";
  return value;
}

/** The exact JSON line that would be written (exported for tests). */
export function formatLog(level: LogLevel, fields: LogFields): string {
  const out: Record<string, unknown> = {
    app: "wageni",
    level,
    event: clean(fields.event),
    fn: clean(fields.fn),
    outcome: fields.outcome,
    // Convex ids look like long opaque strings; they are allowed through by shape, not by length.
    org: typeof fields.org === "string" && /^[a-z0-9]{20,40}$/.test(fields.org) ? fields.org : undefined,
    code: clean(fields.code),
    count: typeof fields.count === "number" && Number.isFinite(fields.count) ? fields.count : undefined,
    durationMs: typeof fields.durationMs === "number" && Number.isFinite(fields.durationMs) ? Math.round(fields.durationMs) : undefined,
    requestId: clean(fields.requestId),
  };
  return JSON.stringify(out);
}

export function logEvent(level: LogLevel, fields: LogFields): void {
  try {
    const line = formatLog(level, fields);
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  } catch {
    // Logging must never break a request.
  }
}
