/**
 * Per-person attendance report maths. Pure: takes the person's counted
 * (non-superseded) events and returns hours per local day, late/absent
 * counts and exceptions. Day boundaries use each session's site time zone.
 */
import {
  dateKey,
  deriveSessions,
  hoursByDay,
  isStaleOpen,
  type AttendanceEventLike,
} from "../attendance/sessions";
import { eachDate, minutesOfDay, weekdayOf } from "./math";

/** Default "late" threshold: first clock-in after 09:00 local on a weekday. */
export const DEFAULT_LATE_AFTER_MINUTES = 9 * 60;

export type PersonAttendance = {
  days: { date: string; ms: number; firstInAt: number | null; late: boolean }[];
  totalMs: number;
  daysWorked: number;
  lateCount: number;
  absentDates: string[];
  exceptions: { unclosed: number; orphanClockOuts: number; staleOpen: boolean; stillIn: boolean };
};

export function summariseAttendance(input: {
  /** Counted events only (corrections already applied). May start before `from` so sessions pair up. */
  events: readonly AttendanceEventLike[];
  siteTz: (siteId: string) => string;
  siteAllowed: (siteId: string) => boolean;
  fromDate: string;
  toDate: string;
  from: number;
  to: number;
  lateAfterMinutes?: number;
  /** Local date of "today" in the organization zone; absence is judged only before it. */
  today: string;
  /** First local date the person could have been expected (their membership start). */
  expectedFrom?: string;
  now: number;
}): PersonAttendance {
  const late = input.lateAfterMinutes ?? DEFAULT_LATE_AFTER_MINUTES;
  const { sessions, open, orphanOutIds } = deriveSessions(input.events);
  const all = open ? [...sessions, open] : sessions;

  const ms = new Map<string, number>();
  const firstIn = new Map<string, { at: number; tz: string }>();
  let unclosed = 0;
  for (const s of all) {
    if (!input.siteAllowed(s.siteId)) continue;
    const tz = input.siteTz(s.siteId);
    const startDate = dateKey(s.start, tz);
    if (startDate >= input.fromDate && startDate <= input.toDate) {
      const cur = firstIn.get(startDate);
      if (!cur || s.start < cur.at) firstIn.set(startDate, { at: s.start, tz });
      if (s.unclosed) unclosed++;
    }
    for (const [date, d] of hoursByDay([s], tz)) {
      if (date >= input.fromDate && date <= input.toDate) ms.set(date, (ms.get(date) ?? 0) + d);
    }
  }

  const dates = new Set<string>([...ms.keys(), ...firstIn.keys()]);
  const days = [...dates]
    .sort()
    .map((date) => {
      const fi = firstIn.get(date);
      const weekday = weekdayOf(date);
      const isLate = !!fi && weekday >= 1 && weekday <= 5 && minutesOfDay(fi.at, fi.tz) > late;
      return { date, ms: ms.get(date) ?? 0, firstInAt: fi?.at ?? null, late: isLate };
    });

  const lastJudged = input.toDate < input.today ? input.toDate : addDayBack(input.today);
  const absentDates = eachDate(input.expectedFrom && input.expectedFrom > input.fromDate ? input.expectedFrom : input.fromDate, lastJudged).filter((date) => {
    const wd = weekdayOf(date);
    return wd >= 1 && wd <= 5 && !dates.has(date);
  });

  const orphanClockOuts = input.events.filter(
    (e) => orphanOutIds.includes(e._id) && e.at >= input.from && e.at < input.to && input.siteAllowed(e.siteId),
  ).length;

  return {
    days,
    totalMs: days.reduce((n, d) => n + d.ms, 0),
    daysWorked: days.length,
    lateCount: days.filter((d) => d.late).length,
    absentDates,
    exceptions: {
      unclosed,
      orphanClockOuts,
      staleOpen: !!open && isStaleOpen(open.start, input.now),
      stillIn: !!open && !isStaleOpen(open.start, input.now),
    },
  };
}

function addDayBack(key: string): string {
  const t = new Date(`${key}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}
