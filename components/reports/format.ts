import { addDays, dateKey, formatDuration } from "@/lib/attendance/sessions";
import { resolveRange } from "@/lib/reports/math";

export const fmtDuration = (ms: number | null | undefined) => (ms === null || ms === undefined ? "–" : formatDuration(ms));

export function fmtDateTime(ts: number | null | undefined, timeZone: string) {
  if (ts === null || ts === undefined) return "–";
  return new Intl.DateTimeFormat("en-GB", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(new Date(ts));
}

export function fmtTime(ts: number | null | undefined, timeZone: string) {
  if (ts === null || ts === undefined) return "–";
  return new Intl.DateTimeFormat("en-GB", { timeZone, timeStyle: "short" }).format(new Date(ts));
}

export function fmtDate(key: string) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", dateStyle: "medium" }).format(new Date(`${key}T00:00:00Z`));
}

export const PRESETS = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last7", label: "Last 7 days" },
  { value: "last30", label: "Last 30 days" },
  { value: "thisMonth", label: "This month" },
  { value: "lastMonth", label: "Last month" },
  { value: "custom", label: "Custom range" },
] as const;

export type Preset = (typeof PRESETS)[number]["value"];

/** Inclusive local dates for a preset, in the organization's time zone. */
export function presetRange(preset: Exclude<Preset, "custom">, timeZone: string, now = Date.now()) {
  const today = dateKey(now, timeZone);
  switch (preset) {
    case "today":
      return { fromDate: today, toDate: today };
    case "yesterday": {
      const y = addDays(today, -1);
      return { fromDate: y, toDate: y };
    }
    case "last7":
      return { fromDate: addDays(today, -6), toDate: today };
    case "last30":
      return { fromDate: addDays(today, -29), toDate: today };
    case "thisMonth":
      return { fromDate: `${today.slice(0, 7)}-01`, toDate: today };
    case "lastMonth": {
      const firstThis = `${today.slice(0, 7)}-01`;
      const lastPrev = addDays(firstThis, -1);
      return { fromDate: `${lastPrev.slice(0, 7)}-01`, toDate: lastPrev };
    }
  }
}

/** Client-side check so an invalid range never reaches a query (which would throw). */
export function rangeProblem(fromDate: string, toDate: string, maxDays: number): string | null {
  const r = resolveRange(fromDate, toDate, "UTC", maxDays);
  return "error" in r ? r.error : null;
}

export const OUTCOME_LABELS: Record<string, string> = {
  attended: "Attended",
  no_show: "No-show",
  upcoming: "Upcoming",
  pending: "Awaiting approval",
  lapsed: "Never approved",
  declined: "Declined",
  cancelled: "Cancelled",
};

export const STATUS_LABELS: Record<string, string> = {
  expected: "Expected",
  on_site: "On site",
  checked_out: "Checked out",
};

export const METHOD_LABELS: Record<string, string> = {
  host: "Host",
  gate: "Gate",
  reception: "Reception",
  kiosk: "Kiosk",
};
