/**
 * Pure report maths, shared by Convex (authoritative) and unit tests. All
 * functions take plain rows so they can be tested without a database.
 */
import { addDays, dateKey, isDateKey, startOfLocalDay } from "../attendance/sessions";

export type VisitRow = {
  id: string;
  siteId: string;
  visitorName: string;
  company?: string;
  phone?: string;
  email?: string;
  hostUserId?: string;
  hostName?: string;
  purpose: string;
  status: "expected" | "on_site" | "checked_out";
  /** Present for appointment visits; absent for walk-ins. */
  appointmentId?: string;
  createdAt: number;
  checkedInAt?: number;
  checkedOutAt?: number;
  checkedOutMethod?: string;
  /** Host confirmation (`meeting_ended` event) time and who confirmed it. */
  meetingEndedAt?: number;
  meetingConfirmedBy?: string;
};

/** The moment the visitor arrived (admitted); undefined while only registered. */
export const arrivalAt = (r: Pick<VisitRow, "checkedInAt">) => r.checkedInAt;

/**
 * Time on site / in the meeting: check-in to the host's `meeting_ended`
 * confirmation if there is one, otherwise to check-out. Null when the visit
 * has not ended or the timestamps are inconsistent.
 */
export function visitDurationMs(
  r: Pick<VisitRow, "checkedInAt" | "checkedOutAt" | "meetingEndedAt">,
): number | null {
  const end = r.meetingEndedAt ?? r.checkedOutAt;
  if (r.checkedInAt === undefined || end === undefined) return null;
  return end >= r.checkedInAt ? end - r.checkedInAt : null;
}

const hourFormatters = new Map<string, Intl.DateTimeFormat>();
/** Hour of day (0-23) of an instant in `timeZone`. */
export function hourOfDay(ts: number, timeZone: string): number {
  let f = hourFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "numeric" });
    hourFormatters.set(timeZone, f);
  }
  const part = f.formatToParts(new Date(ts)).find((p) => p.type === "hour");
  return Number(part?.value ?? 0) % 24;
}

export function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

export type Counted = { key: string; label: string; count: number; avgDurationMs: number | null };

function group(
  rows: readonly VisitRow[],
  keyOf: (r: VisitRow) => { key: string; label: string },
  limit = 20,
): Counted[] {
  const map = new Map<string, { label: string; count: number; durations: number[] }>();
  for (const r of rows) {
    const { key, label } = keyOf(r);
    let g = map.get(key);
    if (!g) {
      g = { label, count: 0, durations: [] };
      map.set(key, g);
    }
    g.count++;
    const d = visitDurationMs(r);
    if (d !== null) g.durations.push(d);
  }
  const all = [...map.entries()]
    .map(([key, g]) => ({ key, label: g.label, count: g.count, avgDurationMs: average(g.durations) }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  if (all.length <= limit) return all;
  const rest = all.slice(limit);
  return [
    ...all.slice(0, limit),
    { key: "__other", label: "Other", count: rest.reduce((n, g) => n + g.count, 0), avgDurationMs: null },
  ];
}

export type VisitsSummary = {
  total: number;
  arrived: number;
  expected: number;
  onSite: number;
  checkedOut: number;
  walkIns: number;
  byAppointment: number;
  hostConfirmed: number;
  avgDurationMs: number | null;
  medianDurationMs: number | null;
};

export function summariseVisits(
  rows: readonly VisitRow[],
  tzOfSite: (siteId: string) => string,
  siteName: (siteId: string) => string,
) {
  const durations = rows.map(visitDurationMs).filter((d): d is number => d !== null);
  const summary: VisitsSummary = {
    total: rows.length,
    arrived: rows.filter((r) => r.checkedInAt !== undefined).length,
    expected: rows.filter((r) => r.status === "expected").length,
    onSite: rows.filter((r) => r.status === "on_site").length,
    checkedOut: rows.filter((r) => r.status === "checked_out").length,
    walkIns: rows.filter((r) => !r.appointmentId).length,
    byAppointment: rows.filter((r) => r.appointmentId).length,
    hostConfirmed: rows.filter((r) => r.meetingEndedAt !== undefined).length,
    avgDurationMs: average(durations),
    medianDurationMs: median(durations),
  };

  // Days and hours are bucketed in each visit's own site time zone.
  const dayCounts = new Map<string, number>();
  const hours = new Array<number>(24).fill(0);
  for (const r of rows) {
    const at = arrivalAt(r);
    if (at === undefined) continue;
    const tz = tzOfSite(r.siteId);
    const day = dateKey(at, tz);
    dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
    hours[hourOfDay(at, tz)]!++;
  }
  const byDay = [...dayCounts.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  return {
    summary,
    byDay,
    byHour: hours.map((count, hour) => ({ hour, count })),
    bySite: group(rows, (r) => ({ key: r.siteId, label: siteName(r.siteId) })),
    byHost: group(rows, (r) => ({ key: r.hostUserId ?? "__none", label: r.hostName ?? "No host" })),
    byPurpose: group(rows, (r) => {
      const label = r.purpose.trim() || "Not stated";
      return { key: label.toLowerCase(), label };
    }),
    byStatus: group(rows, (r) => ({ key: r.status, label: r.status })),
  };
}

/** Visits that were on site at instant `at` (historical register). */
export function wasOnSiteAt(
  r: Pick<VisitRow, "checkedInAt" | "checkedOutAt">,
  at: number,
): boolean {
  if (r.checkedInAt === undefined || r.checkedInAt > at) return false;
  return r.checkedOutAt === undefined || r.checkedOutAt > at;
}

// --- Date ranges -----------------------------------------------------------

export const MAX_RANGE_DAYS = 93;

export type DateRange = { fromDate: string; toDate: string; from: number; to: number };

/**
 * Convert inclusive local dates into a [from, to) instant range in
 * `timeZone`. Returns an error string for invalid or too-long ranges.
 */
export function resolveRange(
  fromDate: string,
  toDate: string,
  timeZone: string,
  maxDays = MAX_RANGE_DAYS,
): DateRange | { error: string } {
  if (!isDateKey(fromDate) || !isDateKey(toDate)) return { error: "Use dates in YYYY-MM-DD format." };
  if (toDate < fromDate) return { error: "The end date is before the start date." };
  const days = Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000) + 1;
  if (days > maxDays) return { error: `Choose a range of at most ${maxDays} days.` };
  return {
    fromDate,
    toDate,
    from: startOfLocalDay(fromDate, timeZone),
    to: startOfLocalDay(addDays(toDate, 1), timeZone),
  };
}

/** Local weekday (0 = Sunday) of a YYYY-MM-DD key. */
export function weekdayOf(key: string): number {
  return new Date(`${key}T00:00:00Z`).getUTCDay();
}

export function eachDate(fromDate: string, toDate: string): string[] {
  const out: string[] = [];
  for (let d = fromDate, i = 0; d <= toDate && i < 400; d = addDays(d, 1), i++) out.push(d);
  return out;
}

export function minutesOfDay(ts: number, timeZone: string): number {
  const f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "numeric", minute: "numeric" });
  const parts = f.formatToParts(new Date(ts));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

// --- Appointments ------------------------------------------------------------

export type AppointmentOutcome =
  | "attended"
  | "no_show"
  | "upcoming"
  | "pending"
  | "lapsed"
  | "declined"
  | "cancelled";

/**
 * What became of an appointment. A no-show is an approved appointment whose
 * end time has passed without the visitor ever being checked in (checking in
 * moves it to `checked_in` / `completed`).
 */
export function appointmentOutcome(
  status: "pending_approval" | "approved" | "declined" | "cancelled" | "checked_in" | "completed",
  scheduledEnd: number,
  now: number,
): AppointmentOutcome {
  switch (status) {
    case "checked_in":
    case "completed":
      return "attended";
    case "declined":
      return "declined";
    case "cancelled":
      return "cancelled";
    case "pending_approval":
      return scheduledEnd < now ? "lapsed" : "pending";
    case "approved":
      return scheduledEnd < now ? "no_show" : "upcoming";
  }
}

/** "2026-03-29 14:05" in `timeZone`. */
export function formatLocal(ts: number, timeZone: string): string {
  const mins = minutesOfDay(ts, timeZone);
  const h = String(Math.floor(mins / 60)).padStart(2, "0");
  const m = String(mins % 60).padStart(2, "0");
  return `${dateKey(ts, timeZone)} ${h}:${m}`;
}
