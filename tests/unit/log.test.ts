import { afterEach, describe, expect, test, vi } from "vitest";
import { formatLog, logEvent } from "../../convex/lib/log";

afterEach(() => vi.restoreAllMocks());

describe("structured logging", () => {
  test("emits one JSON line with only the allowed fields", () => {
    const line = JSON.parse(
      formatLog("warn", {
        event: "rate_limited",
        fn: "kioskVisitor.checkOut",
        outcome: "rejected",
        org: "k57abc123def456ghi789jkl012mn",
        code: "RATE_LIMITED",
        count: 3,
        durationMs: 12.4,
      }),
    );
    expect(line).toEqual({
      app: "wageni",
      level: "warn",
      event: "rate_limited",
      fn: "kioskVisitor.checkOut",
      outcome: "rejected",
      org: "k57abc123def456ghi789jkl012mn",
      code: "RATE_LIMITED",
      count: 3,
      durationMs: 12,
    });
  });

  test("personal data and secrets that slip into string fields are redacted", () => {
    const hostile = [
      "jane@example.com",
      "+254 700 111 222",
      "0700111222",
      "wk_" + "a".repeat(43),
      "whsec_abcdef",
      "eyJhbGciOi.payload.sig",
      "x".repeat(65),
    ];
    for (const value of hostile) {
      const out = formatLog("info", { event: value, fn: value, code: value, requestId: value });
      expect(out).not.toContain(value);
      expect(JSON.parse(out).event).toBe("[redacted]");
    }
  });

  test("an organization field that is not an id is dropped, not logged", () => {
    expect(JSON.parse(formatLog("info", { event: "x", fn: "y", org: "Acme Ltd, Nairobi" })).org).toBeUndefined();
  });

  test("routes by level and never throws", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    logEvent("info", { event: "a", fn: "b" });
    logEvent("warn", { event: "a", fn: "b" });
    logEvent("error", { event: "a", fn: "b" });
    expect([log, warn, error].map((m) => m.mock.calls.length)).toEqual([1, 1, 1]);
    error.mockImplementation(() => {
      throw new Error("sink down");
    });
    expect(() => logEvent("error", { event: "a", fn: "b" })).not.toThrow();
  });
});
