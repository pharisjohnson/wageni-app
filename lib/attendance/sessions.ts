/**
 * Pure attendance maths shared by Convex (authoritative) and the UI.
 * Events are append-only; everything here is derived from them.
 */

export type AttendanceEventLike = {
  _id: string;
  type: "clock_in" | "clock_out";
  at: number;
  siteId: string;
};

export type Session = {
  start: number;
  /** null while still clocked in, or when a later clock-in arrived with no clock-out. */
  end: number | null;
  siteId: string;
  startEventId: string;
  endEventId: string | null;
  /** A newer clock-in arrived before this session was closed: hours are not counted. */
  unclosed: boolean;
};

export type DeriveResult = {
  sessions: Session[];
  /** The session that is open right now (last event is a clock-in), if any. */
  open: Session | null;
  /** Clock-outs that had no matching clock-in. */
  orphanOutIds: string[];
};

/**
 * Pair clock-ins with clock-outs. `events` must already exclude events that a
 * correction has superseded. Ties in `at` keep input order (insert order).
 */
export function deriveSessions(events: readonly AttendanceEventLike[]): DeriveResult {
  const sorted = events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.at - b.e.at || a.i - b.i)
    .map((x) => x.e);
  const sessions: Session[] = [];
  const orphanOutIds: string[] = [];
  let open: Session | null = null;
  for (const ev of sorted) {
    if (ev.type === "clock_in") {
      if (open) sessions.push({ ...open, unclosed: true });
      open = {
        start: ev.at,
        end: null,
        siteId: ev.siteId,
        startEventId: ev._id,
        endEventId: null,
        unclosed: false,
      };
    } else if (open) {
      sessions.push({ ...open, end: Math.max(ev.at, open.start), endEventId: ev._id });
      open = null;
    } else {
      orphanOutIds.push(ev._id);
    }
  }
  return { sessions, open, orphanOutIds };
}

// --- Time zones ------------------------------------------------------------

type Parts = { y: number; m: number; d: number; h: number; mi: number; s: number };

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

function zonedParts(ts: number, timeZone: string): Parts {
  const out: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(ts))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return { y: out.year!, m: out.month!, d: out.day!, h: out.hour!, mi: out.minute!, s: out.second! };
}

/** Offset (ms) of `timeZone` from UTC at instant `ts`. */
function offsetAt(ts: number, timeZone: string) {
  const p = zonedParts(ts, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ts / 1000) * 1000;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The calendar date (YYYY-MM-DD) of an instant in `timeZone`. */
export function dateKey(ts: number, timeZone: string): string {
  const p = zonedParts(ts, timeZone);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

export function isDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export function addDays(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** The instant that local midnight of `key` occurs in `timeZone`. */
export function startOfLocalDay(key: string, timeZone: string): number {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d);
  // Two passes settle the offset across a DST change.
  const first = wall - offsetAt(wall, timeZone);
  return wall - offsetAt(first, timeZone);
}

export type DaySlice = { date: string; ms: number };

/** Split a closed [start, end] interval at local midnights in `timeZone`. */
export function splitByLocalDay(start: number, end: number, timeZone: string): DaySlice[] {
  const slices: DaySlice[] = [];
  let cursor = start;
  let guard = 0;
  while (cursor < end && guard++ < 400) {
    const key = dateKey(cursor, timeZone);
    const nextMidnight = startOfLocalDay(addDays(key, 1), timeZone);
    const sliceEnd = Math.min(end, nextMidnight);
    slices.push({ date: key, ms: sliceEnd - cursor });
    cursor = sliceEnd;
  }
  return slices;
}

/** Total counted ms per local date for closed sessions. */
export function hoursByDay(
  sessions: readonly Pick<Session, "start" | "end" | "unclosed">[],
  timeZone: string,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const s of sessions) {
    if (s.end === null || s.unclosed) continue;
    for (const slice of splitByLocalDay(s.start, s.end, timeZone)) {
      totals.set(slice.date, (totals.get(slice.date) ?? 0) + slice.ms);
    }
  }
  return totals;
}

/** "7h 05m" style duration. */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}h ${pad(m)}m`;
}

/**
 * A clock-in is refused while the person is already in, unless the open
 * session is so old that it is almost certainly a forgotten clock-out (which
 * is then fixed by a correction rather than blocking the next shift).
 */
export const STALE_OPEN_MS = 18 * 60 * 60 * 1000;

export function isStaleOpen(openStart: number, now: number) {
  return now - openStart > STALE_OPEN_MS;
}

/** Validation shared by UI and Convex. */
export const PIN_PATTERN = /^\d{4,6}$/;
export const STAFF_NUMBER_PATTERN = /^[A-Z0-9-]{2,12}$/;

export function normalizeStaffNumber(raw: string) {
  return raw.trim().toUpperCase();
}

/** Reject trivially guessable PINs: one repeated digit, or a straight run. */
export function isWeakPin(pin: string) {
  if (/^(\d)\1+$/.test(pin)) return true;
  const digits = [...pin].map(Number);
  const step = digits[1]! - digits[0]!;
  if (Math.abs(step) === 1) {
    return digits.every((d, i) => i === 0 || d - digits[i - 1]! === step);
  }
  return false;
}
