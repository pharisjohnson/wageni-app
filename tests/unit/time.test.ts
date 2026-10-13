import { describe, expect, test } from "vitest";
import { dayBoundsInZone } from "../../convex/lib/time";
import { kioskCheckOutSchema, kioskPhoneSchema, kioskWalkInSchema } from "../../lib/validation/visits";

describe("dayBoundsInZone", () => {
  test("Nairobi (UTC+3): local midnight is 21:00 UTC the day before", () => {
    const now = Date.UTC(2026, 5, 10, 22, 30); // 01:30 on 11 June in Nairobi
    const { start, end } = dayBoundsInZone(now, "Africa/Nairobi");
    expect(new Date(start).toISOString()).toBe("2026-06-10T21:00:00.000Z");
    expect(new Date(end).toISOString()).toBe("2026-06-11T21:00:00.000Z");
  });

  test("UTC and an invalid zone fall back sensibly", () => {
    const now = Date.UTC(2026, 0, 5, 12);
    expect(new Date(dayBoundsInZone(now, "UTC").start).toISOString()).toBe("2026-01-05T00:00:00.000Z");
    expect(new Date(dayBoundsInZone(now, "Not/AZone").start).toISOString()).toBe("2026-01-05T00:00:00.000Z");
  });

  test("a zone behind UTC", () => {
    const now = Date.UTC(2026, 0, 5, 2); // 21:00 on 4 Jan in New York
    expect(new Date(dayBoundsInZone(now, "America/New_York").start).toISOString()).toBe("2026-01-04T05:00:00.000Z");
  });
});

describe("kiosk schemas", () => {
  test("phone needs real digits", () => {
    expect(kioskPhoneSchema.safeParse("+254 700 111 222").success).toBe(true);
    expect(kioskPhoneSchema.safeParse("-------").success).toBe(false);
    expect(kioskPhoneSchema.safeParse("12345").success).toBe(false);
  });
  test("walk-in requires phone, name and purpose", () => {
    const ok = { name: "Walt Walker", phone: "0700111222", purpose: "Delivery" };
    expect(kioskWalkInSchema.safeParse(ok).success).toBe(true);
    expect(kioskWalkInSchema.safeParse({ ...ok, phone: "" }).success).toBe(false);
    expect(kioskWalkInSchema.safeParse({ ...ok, purpose: "x" }).success).toBe(false);
  });
  test("check-out requires 6 + 4 digits", () => {
    expect(kioskCheckOutSchema.safeParse({ badgeCode: "123456", phoneLast4: "1222" }).success).toBe(true);
    expect(kioskCheckOutSchema.safeParse({ badgeCode: "12345", phoneLast4: "1222" }).success).toBe(false);
    expect(kioskCheckOutSchema.safeParse({ badgeCode: "123456", phoneLast4: "12a2" }).success).toBe(false);
  });
});
