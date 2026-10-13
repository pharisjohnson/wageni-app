import { describe, expect, test } from "vitest";
import { effectivePermissions } from "@/lib/permissions";
import { summariseAttendance } from "@/lib/reports/attendance";
import {
  appointmentOutcome,
  hourOfDay,
  resolveRange,
  summariseVisits,
  visitDurationMs,
  wasOnSiteAt,
  type VisitRow,
} from "@/lib/reports/math";
import { DEFAULT_RETENTION, MIN_RETENTION, resolveRetention, retentionSchema } from "@/lib/retention";

const MIN = 60_000;
const NY = "America/New_York";

function visit(over: Partial<VisitRow>): VisitRow {
  return {
    id: String(Math.random()),
    siteId: "s1",
    visitorName: "V",
    purpose: "Meeting",
    status: "checked_out",
    createdAt: 0,
    ...over,
  };
}

describe("visitDurationMs", () => {
  test("uses host confirmation when present, otherwise check-out", () => {
    expect(visitDurationMs({ checkedInAt: 1000, checkedOutAt: 1000 + 60 * MIN })).toBe(60 * MIN);
    expect(visitDurationMs({ checkedInAt: 1000, meetingEndedAt: 1000 + 30 * MIN, checkedOutAt: 1000 + 60 * MIN })).toBe(30 * MIN);
  });
  test("null when not ended, not checked in, or inconsistent", () => {
    expect(visitDurationMs({ checkedInAt: 1000 })).toBeNull();
    expect(visitDurationMs({ checkedOutAt: 5000 })).toBeNull();
    expect(visitDurationMs({ checkedInAt: 5000, checkedOutAt: 1000 })).toBeNull();
  });
});

describe("summariseVisits", () => {
  const tz = () => "Africa/Nairobi";
  const name = (id: string) => `Site ${id}`;
  test("averages, walk-in vs appointment, host confirmations, groupings", () => {
    const rows = [
      visit({ checkedInAt: 0, checkedOutAt: 60 * MIN, appointmentId: "a1", hostUserId: "h1", hostName: "Hana", purpose: "Interview" }),
      visit({ checkedInAt: 0, meetingEndedAt: 30 * MIN, checkedOutAt: 90 * MIN, hostUserId: "h1", hostName: "Hana", purpose: "interview" }),
      visit({ status: "on_site", checkedInAt: 10 * MIN, purpose: "Delivery" }),
      visit({ status: "expected", purpose: "Delivery" }),
    ];
    const r = summariseVisits(rows, tz, name);
    expect(r.summary).toMatchObject({ total: 4, arrived: 3, expected: 1, onSite: 1, checkedOut: 2, walkIns: 3, byAppointment: 1, hostConfirmed: 1 });
    expect(r.summary.avgDurationMs).toBe(45 * MIN);
    expect(r.byPurpose.find((p) => p.key === "interview")?.count).toBe(2);
    expect(r.byHost[0]).toMatchObject({ label: "Hana", count: 2, avgDurationMs: 45 * MIN });
    expect(r.bySite).toEqual([expect.objectContaining({ label: "Site s1", count: 4 })]);
  });

  test("busiest hours use each visit's own time zone", () => {
    // 2026-06-01T07:30Z is 10:30 in Nairobi (UTC+3) and 03:30 in New York (EDT).
    const at = Date.UTC(2026, 5, 1, 7, 30);
    const rows = [visit({ siteId: "nbo", checkedInAt: at }), visit({ siteId: "ny", checkedInAt: at })];
    const r = summariseVisits(rows, (id) => (id === "nbo" ? "Africa/Nairobi" : NY), name);
    expect(r.byHour[10]!.count).toBe(1);
    expect(r.byHour[3]!.count).toBe(1);
    expect(r.byDay).toEqual([{ date: "2026-06-01", count: 2 }]);
  });

  test("DST spring-forward: 01:30 and 03:30 local are one real hour apart", () => {
    // New York 2026-03-08: 02:00 EST jumps to 03:00 EDT.
    const before = Date.UTC(2026, 2, 8, 6, 30); // 01:30 EST
    const after = Date.UTC(2026, 2, 8, 7, 30); // 03:30 EDT
    expect(hourOfDay(before, NY)).toBe(1);
    expect(hourOfDay(after, NY)).toBe(3);
    const r = summariseVisits([visit({ checkedInAt: before }), visit({ checkedInAt: after })], () => NY, name);
    expect(r.byDay).toEqual([{ date: "2026-03-08", count: 2 }]);
  });

  test("DST fall-back: the repeated 01:xx hour lands in one bucket", () => {
    // 2026-11-01: 02:00 EDT falls back to 01:00 EST, so 01:30 happens twice.
    expect(hourOfDay(Date.UTC(2026, 10, 1, 5, 30), NY)).toBe(1);
    expect(hourOfDay(Date.UTC(2026, 10, 1, 6, 30), NY)).toBe(1);
  });

  test("midnight is hour 0, never 24", () => {
    expect(hourOfDay(Date.UTC(2026, 5, 1, 0, 0), "UTC")).toBe(0);
  });
});

describe("wasOnSiteAt", () => {
  test("in before, out after", () => {
    expect(wasOnSiteAt({ checkedInAt: 100, checkedOutAt: 300 }, 200)).toBe(true);
    expect(wasOnSiteAt({ checkedInAt: 100, checkedOutAt: 300 }, 300)).toBe(false);
    expect(wasOnSiteAt({ checkedInAt: 100, checkedOutAt: 300 }, 50)).toBe(false);
    expect(wasOnSiteAt({ checkedInAt: 100 }, 5000)).toBe(true);
    expect(wasOnSiteAt({}, 5000)).toBe(false);
  });
});

describe("resolveRange", () => {
  test("converts inclusive local dates to [from, to) instants, DST aware", () => {
    const r = resolveRange("2026-03-08", "2026-03-08", NY);
    if ("error" in r) throw new Error(r.error);
    expect(r.to - r.from).toBe(23 * 60 * MIN); // the short day
    const fall = resolveRange("2026-11-01", "2026-11-01", NY);
    if ("error" in fall) throw new Error(fall.error);
    expect(fall.to - fall.from).toBe(25 * 60 * MIN);
  });
  test("rejects bad, reversed and over-long ranges", () => {
    expect(resolveRange("nope", "2026-01-01", "UTC")).toHaveProperty("error");
    expect(resolveRange("2026-02-02", "2026-02-01", "UTC")).toHaveProperty("error");
    expect(resolveRange("2026-01-01", "2026-12-31", "UTC")).toHaveProperty("error");
    expect(resolveRange("2026-01-01", "2026-03-04", "UTC", 62)).toHaveProperty("error");
  });
});

describe("appointmentOutcome", () => {
  const now = 1000;
  test("no-show is approved and past its end", () => {
    expect(appointmentOutcome("approved", 500, now)).toBe("no_show");
    expect(appointmentOutcome("approved", 2000, now)).toBe("upcoming");
    expect(appointmentOutcome("completed", 500, now)).toBe("attended");
    expect(appointmentOutcome("checked_in", 500, now)).toBe("attended");
    expect(appointmentOutcome("pending_approval", 500, now)).toBe("lapsed");
    expect(appointmentOutcome("cancelled", 500, now)).toBe("cancelled");
  });
});

describe("summariseAttendance", () => {
  const base = {
    siteTz: () => "UTC",
    siteAllowed: () => true,
    now: Date.UTC(2026, 5, 30),
    today: "2026-06-30",
  };
  const ev = (id: string, type: "clock_in" | "clock_out", at: number) => ({ _id: id, type, at, siteId: "s1" });
  const range = (fromDate: string, toDate: string) => ({
    fromDate,
    toDate,
    from: Date.parse(`${fromDate}T00:00:00Z`),
    to: Date.parse(`${toDate}T00:00:00Z`) + 86_400_000,
  });

  test("hours, lateness and absence over a week", () => {
    // Mon 2026-06-01 .. Fri 2026-06-05. Mon on time, Tue late, Wed absent, Thu on time, Fri absent.
    const d = (day: number, h: number, m = 0) => Date.UTC(2026, 5, day, h, m);
    const events = [
      ev("1", "clock_in", d(1, 8, 55)),
      ev("2", "clock_out", d(1, 17)),
      ev("3", "clock_in", d(2, 9, 20)),
      ev("4", "clock_out", d(2, 17)),
      ev("5", "clock_in", d(4, 9)),
      ev("6", "clock_out", d(4, 13)),
    ];
    const r = summariseAttendance({ ...base, events, ...range("2026-06-01", "2026-06-05") });
    expect(r.daysWorked).toBe(3);
    expect(r.lateCount).toBe(1);
    expect(r.days.find((x) => x.date === "2026-06-02")?.late).toBe(true);
    expect(r.absentDates).toEqual(["2026-06-03", "2026-06-05"]);
    expect(r.totalMs).toBe((8 * 60 + 5) * MIN + (7 * 60 + 40) * MIN + 4 * 60 * MIN);
  });

  test("a session across midnight splits over days; a session starting before the range is clipped", () => {
    const d = (day: number, h: number) => Date.UTC(2026, 5, day, h);
    const events = [ev("1", "clock_in", d(1, 22)), ev("2", "clock_out", d(2, 6))];
    const r = summariseAttendance({ ...base, events, ...range("2026-06-02", "2026-06-02") });
    expect(r.days).toEqual([expect.objectContaining({ date: "2026-06-02", ms: 6 * 60 * MIN })]);
  });

  test("hours across a DST change count real elapsed time", () => {
    // 22:00 EST Sat to 06:00 EDT Sun on 2026-03-08 is 7 real hours.
    const events = [ev("1", "clock_in", Date.UTC(2026, 2, 8, 3)), ev("2", "clock_out", Date.UTC(2026, 2, 8, 10))];
    const r = summariseAttendance({
      ...base,
      siteTz: () => NY,
      events,
      today: "2026-06-30",
      fromDate: "2026-03-07",
      toDate: "2026-03-08",
      from: Date.UTC(2026, 2, 7, 5),
      to: Date.UTC(2026, 2, 9, 4),
    });
    expect(r.totalMs).toBe(7 * 60 * MIN);
    expect(r.days.map((x) => x.date)).toEqual(["2026-03-07", "2026-03-08"]);
  });

  test("exceptions: unclosed sessions, orphan clock-outs, stale open", () => {
    const d = (day: number, h: number) => Date.UTC(2026, 5, day, h);
    const events = [
      ev("1", "clock_in", d(1, 9)),
      ev("2", "clock_in", d(2, 9)), // day 1 never closed
      ev("3", "clock_out", d(2, 17)),
      ev("4", "clock_out", d(3, 9)), // orphan
      ev("5", "clock_in", d(4, 9)), // still open and old by `now`
    ];
    const r = summariseAttendance({ ...base, events, ...range("2026-06-01", "2026-06-05") });
    expect(r.exceptions.unclosed).toBe(1);
    expect(r.exceptions.orphanClockOuts).toBe(1);
    expect(r.exceptions.staleOpen).toBe(true);
  });

  test("absence is not judged for today, before the member joined, or on weekends", () => {
    const r = summariseAttendance({
      ...base,
      events: [],
      today: "2026-06-03",
      expectedFrom: "2026-06-02",
      ...range("2026-06-01", "2026-06-07"),
    });
    expect(r.absentDates).toEqual(["2026-06-02"]);
  });
});

describe("retention settings", () => {
  test("defaults and clamping to minimums", () => {
    expect(resolveRetention()).toEqual(DEFAULT_RETENTION);
    const r = resolveRetention({ auditLogDays: 1, attendanceDays: 10, visitRecordsDays: 5 });
    expect(r).toEqual({ ...MIN_RETENTION });
    expect(resolveRetention({ visitRecordsDays: 100_000 }).visitRecordsDays).toBe(3650);
  });
  test("schema rejects below-minimum values", () => {
    expect(retentionSchema.safeParse({ ...DEFAULT_RETENTION, auditLogDays: 100 }).success).toBe(false);
    expect(retentionSchema.safeParse({ ...DEFAULT_RETENTION, attendanceDays: 364 }).success).toBe(false);
    expect(retentionSchema.safeParse({ ...DEFAULT_RETENTION, visitRecordsDays: 30.5 }).success).toBe(false);
    expect(retentionSchema.safeParse({ ...DEFAULT_RETENTION, visitRecordsDays: 30 }).success).toBe(true);
  });
});

// --- P1: reports:export / audit:read role matrix
describe("P1 permissions", () => {
  test("reports:export and audit:read are admin-level; reports:read reaches reception", () => {
    expect(effectivePermissions("owner").has("reports:export")).toBe(true);
    expect(effectivePermissions("admin").has("reports:export")).toBe(true);
    expect(effectivePermissions("admin").has("audit:read")).toBe(true);
    for (const role of ["receptionist", "guard", "host", "staff"] as const) {
      const p = effectivePermissions(role);
      expect(p.has("reports:export"), role).toBe(false);
      expect(p.has("audit:read"), role).toBe(false);
    }
    expect(effectivePermissions("receptionist").has("reports:read")).toBe(true);
    expect(effectivePermissions("guard").has("reports:read")).toBe(false);
  });
});
// --- end P1
