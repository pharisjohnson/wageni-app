import { z } from "zod";

/**
 * Retention periods (days). Defaults and minimums are enforced both when
 * saving (`retention.update`) and again when purging (`resolveRetention`
 * clamps whatever is stored), so a bad value can never shorten a period
 * below the floor.
 */
export type Retention = {
  visitRecordsDays: number;
  auditLogDays: number;
  attendanceDays: number;
};

export const DEFAULT_RETENTION: Retention = {
  visitRecordsDays: 365,
  auditLogDays: 730,
  attendanceDays: 2555, // about 7 years, a common employment-records period
};

export const MIN_RETENTION: Retention = {
  visitRecordsDays: 30,
  auditLogDays: 365,
  attendanceDays: 365,
};

export const MAX_RETENTION_DAYS = 3650;

export const RETENTION_LABELS: Record<keyof Retention, string> = {
  visitRecordsDays: "Visitor records",
  auditLogDays: "Audit log",
  attendanceDays: "Staff attendance",
};

export function resolveRetention(stored?: Partial<Retention> | null): Retention {
  const out = { ...DEFAULT_RETENTION };
  for (const key of Object.keys(out) as (keyof Retention)[]) {
    const value = stored?.[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION[key], Math.floor(value)));
    }
  }
  return out;
}

const days = (key: keyof Retention) =>
  z
    .number()
    .int("Use a whole number of days.")
    .min(MIN_RETENTION[key], `${RETENTION_LABELS[key]} must be kept for at least ${MIN_RETENTION[key]} days.`)
    .max(MAX_RETENTION_DAYS, `At most ${MAX_RETENTION_DAYS} days.`);

export const retentionSchema = z.object({
  visitRecordsDays: days("visitRecordsDays"),
  auditLogDays: days("auditLogDays"),
  attendanceDays: days("attendanceDays"),
});

export const DAY_MS = 24 * 60 * 60 * 1000;
