import { describe, expect, test } from "vitest";
import {
  addDays,
  dateKey,
  deriveSessions,
  formatDuration,
  hoursByDay,
  isStaleOpen,
  isWeakPin,
  PIN_PATTERN,
  splitByLocalDay,
  startOfLocalDay,
} from "@/lib/attendance/sessions";
import { effectivePermissions } from "@/lib/permissions";

const H = 3_600_000;
const ev = (id: string, type: "clock_in" | "clock_out", iso: string, siteId = "s1") => ({
  _id: id,
  type,
  at: Date.parse(iso),
  siteId,
});

describe("deriveSessions", () => {
  test("pairs in/out and leaves an open session", () => {
    const r = deriveSessions([
      ev("a", "clock_in", "2026-01-12T05:00:00Z"),
      ev("b", "clock_out", "2026-01-12T09:00:00Z"),
      ev("c", "clock_in", "2026-01-12T10:00:00Z"),
    ]);
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0]).toMatchObject({ startEventId: "a", endEventId: "b", unclosed: false });
    expect(r.open?.startEventId).toBe("c");
  });

  test("input order does not matter; a second clock-in marks the first unclosed", () => {
    const r = deriveSessions([
      ev("c", "clock_in", "2026-01-13T05:00:00Z"),
      ev("a", "clock_in", "2026-01-12T05:00:00Z"),
      ev("d", "clock_out", "2026-01-13T09:00:00Z"),
    ]);
    expect(r.sessions.map((s) => [s.startEventId, s.unclosed])).toEqual([
      ["a", true],
      ["c", false],
    ]);
    expect(r.open).toBeNull();
  });

  test("a clock-out with no clock-in is reported, not counted", () => {
    const r = deriveSessions([ev("x", "clock_out", "2026-01-12T05:00:00Z")]);
    expect(r.orphanOutIds).toEqual(["x"]);
    expect(r.sessions).toHaveLength(0);
  });
});

describe("time zones", () => {
  test("a night shift is split at the site's local midnight", () => {
    // 22:00 to 02:00 in Nairobi (UTC+3) = 19:00Z to 23:00Z.
    const s = Date.parse("2026-01-12T19:00:00Z");
    const e = Date.parse("2026-01-12T23:00:00Z");
    expect(splitByLocalDay(s, e, "Africa/Nairobi")).toEqual([
      { date: "2026-01-12", ms: 2 * H },
      { date: "2026-01-13", ms: 2 * H },
    ]);
    // The same instants are a single UTC day.
    expect(splitByLocalDay(s, e, "UTC")).toEqual([{ date: "2026-01-12", ms: 4 * H }]);
  });

  test("the date key depends on the zone", () => {
    const t = Date.parse("2026-01-12T22:30:00Z");
    expect(dateKey(t, "UTC")).toBe("2026-01-12");
    expect(dateKey(t, "Africa/Nairobi")).toBe("2026-01-13");
    expect(dateKey(t, "America/New_York")).toBe("2026-01-12");
  });

  test("daylight saving days are 23 and 25 hours long", () => {
    const tz = "America/New_York";
    const len = (d: string) => startOfLocalDay(addDays(d, 1), tz) - startOfLocalDay(d, tz);
    expect(len("2026-03-08")).toBe(23 * H);
    expect(len("2026-11-01")).toBe(25 * H);
    expect(len("2026-06-01")).toBe(24 * H);
  });

  test("hoursByDay ignores open and unclosed sessions", () => {
    const base = Date.parse("2026-01-12T05:00:00Z");
    const totals = hoursByDay(
      [
        { start: base, end: base + 8 * H, unclosed: false },
        { start: base, end: null, unclosed: false },
        { start: base, end: base + 3 * H, unclosed: true },
      ],
      "Africa/Nairobi",
    );
    expect([...totals]).toEqual([["2026-01-12", 8 * H]]);
  });
});

describe("helpers", () => {
  test("formatDuration", () => {
    expect(formatDuration(7 * H + 5 * 60_000)).toBe("7h 05m");
    expect(formatDuration(0)).toBe("0h 00m");
  });

  test("stale open sessions", () => {
    expect(isStaleOpen(0, 17 * H)).toBe(false);
    expect(isStaleOpen(0, 19 * H)).toBe(true);
  });

  test("PIN rules", () => {
    for (const ok of ["4829", "7351", "906142"]) {
      expect(PIN_PATTERN.test(ok) && !isWeakPin(ok), ok).toBe(true);
    }
    for (const bad of ["123", "1234567", "12a4", "", "abcd"]) expect(PIN_PATTERN.test(bad), bad).toBe(false);
    for (const weak of ["0000", "1111", "1234", "4321", "123456", "98765"]) expect(isWeakPin(weak), weak).toBe(true);
  });
});

describe("attendance role matrix", () => {
  test("who can do what", () => {
    const p = (r: Parameters<typeof effectivePermissions>[0]) => effectivePermissions(r);
    for (const role of ["owner", "admin", "receptionist", "guard", "host", "staff"] as const) {
      expect(p(role).has("staff_attendance:create"), role).toBe(true);
      expect(p(role).has("staff_attendance:read_own"), role).toBe(true);
    }
    expect(p("owner").has("staff_attendance:manage_pins")).toBe(true);
    expect(p("admin").has("staff_attendance:manage_pins")).toBe(true);
    expect(p("admin").has("staff_attendance:correct")).toBe(true);
    expect(p("admin").has("staff_attendance:record_on_behalf")).toBe(true);
    // Reception sees the roster and records on behalf, but neither approves nor manages PINs.
    expect(p("receptionist").has("staff_attendance:read_site")).toBe(true);
    expect(p("receptionist").has("staff_attendance:record_on_behalf")).toBe(true);
    expect(p("receptionist").has("staff_attendance:correct")).toBe(false);
    expect(p("receptionist").has("staff_attendance:manage_pins")).toBe(false);
    for (const role of ["guard", "host", "staff"] as const) {
      for (const perm of [
        "staff_attendance:read_site",
        "staff_attendance:correct",
        "staff_attendance:record_on_behalf",
        "staff_attendance:manage_pins",
      ] as const) {
        expect(p(role).has(perm), `${role} ${perm}`).toBe(false);
      }
    }
  });
});
