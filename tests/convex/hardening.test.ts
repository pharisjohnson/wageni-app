import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { PIN_DEVICE_THROTTLE } from "../../convex/kioskAttendance";
import { KIOSK_CHECKOUT_MAX_AGE_MS, KIOSK_CHECKOUT_MAX_VISIT_FAILURES } from "../../convex/kioskVisitor";
import {
  LOOKUP_MAX_FAILURES,
  LOOKUP_THROTTLE,
  WALK_IN_MAX_PER_DEVICE_PER_DAY,
  WALK_IN_MAX_PER_PHONE_PER_DAY,
} from "../../convex/lib/kioskLookup";
import { lockDurationMs, recordFailure, throttleLocked, type ThrottleState } from "../../convex/lib/throttle";
import { addMember, createOrgWithOwner, expectCode, newTest, type T } from "./setup";

/** H1: abuse resistance of the public (kiosk) surface. */

const PHONE = "+254700111222";
const HOUR = 60 * 60 * 1000;

afterEach(() => {
  vi.useRealTimers();
});

async function setup(t: T, slug = "acme") {
  const org = await createOrgWithOwner(t, slug, slug);
  const host = await addMember(t, org.organizationId, `${slug}-hana`, "host");
  const gateId = await org.owner.as.mutation(api.gates.create, {
    organizationId: org.organizationId,
    siteId: org.siteId,
    name: "Front",
    type: "pedestrian",
  });
  const { token, deviceId } = await org.owner.as.mutation(api.kioskDevices.issue, {
    organizationId: org.organizationId,
    gateId,
    name: "Tablet",
  });
  return { ...org, host, gateId, token, deviceId, k: { slug, token } };
}
type S = Awaited<ReturnType<typeof setup>>;

/** An on-site visit with a known badge code and phone, inserted directly. */
async function onSiteVisit(t: T, s: S, opts: { badgeCode?: string; phone?: string; checkedInAt?: number } = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const visitorId = await ctx.db.insert("visitors", {
      organizationId: s.organizationId,
      name: "Jane Visitor",
      phone: opts.phone ?? PHONE,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.insert("visits", {
      organizationId: s.organizationId,
      siteId: s.siteId,
      visitorId,
      hostUserId: s.host.userId,
      purpose: "Meeting",
      status: "on_site",
      badgeCode: opts.badgeCode ?? "246810",
      checkedInAt: opts.checkedInAt ?? now,
      checkedInGateId: s.gateId,
      createdAt: now,
      updatedAt: now,
    });
  });
}

describe("throttle maths", () => {
  test("locks double per repeat and cap; a quiet day resets the level", () => {
    const cfg = LOOKUP_THROTTLE;
    let state: ThrottleState = {};
    let now = 1_000_000;
    const levels: number[] = [];
    for (let round = 0; round < 6; round++) {
      let locked = false;
      for (let i = 0; i < cfg.maxFailures; i++) {
        const r = recordFailure(state, cfg, now);
        state = r.state;
        locked = r.locked;
      }
      expect(locked).toBe(true);
      expect(throttleLocked(state, now)).toBe(true);
      levels.push(state.level!);
      now = state.lockUntil! + 1;
      expect(throttleLocked(state, now)).toBe(false);
    }
    expect(levels).toEqual([1, 2, 3, 4, 5, 6]);
    expect(lockDurationMs(1, cfg)).toBe(5 * 60_000);
    expect(lockDurationMs(2, cfg)).toBe(10 * 60_000);
    expect(lockDurationMs(6, cfg)).toBe(cfg.maxLockMs);
    now += cfg.levelDecayMs + 1;
    for (let i = 0; i < cfg.maxFailures; i++) state = recordFailure(state, cfg, now).state;
    expect(state.level).toBe(1);
  });
});

describe("kiosk check-out secret", () => {
  test("5 wrong phone-digit tries lock that visit at the kiosk, even for the right digits; staff can still check out", async () => {
    const t = newTest();
    const s = await setup(t);
    const visitId = await onSiteVisit(t, s);
    for (let i = 0; i < KIOSK_CHECKOUT_MAX_VISIT_FAILURES; i++) {
      expect(await t.mutation(api.kioskVisitor.checkOut, { ...s.k, badgeCode: "246810", phoneLast4: `000${i}` })).toEqual({
        status: "no_match",
      });
    }
    expect(KIOSK_CHECKOUT_MAX_VISIT_FAILURES).toBeLessThan(LOOKUP_MAX_FAILURES);
    expect(await t.mutation(api.kioskVisitor.checkOut, { ...s.k, badgeCode: "246810", phoneLast4: "1222" })).toEqual({
      status: "no_match",
    });
    expect((await t.run((ctx) => ctx.db.get(visitId)))?.status).toBe("on_site");
    const audit = await t.run(async (ctx) => (await ctx.db.query("auditLogs").collect()).map((a) => a.action));
    expect(audit.filter((a) => a === "visit.kiosk_checkout_locked")).toHaveLength(1);
    await s.owner.as.mutation(api.visits.checkOut, { organizationId: s.organizationId, visitId, gateId: s.gateId });
    expect((await t.run((ctx) => ctx.db.get(visitId)))?.status).toBe("checked_out");
  });

  test("wrong digits on one visit do not lock another visit with a different code", async () => {
    const t = newTest();
    const s = await setup(t);
    await onSiteVisit(t, s, { badgeCode: "111111" });
    const other = await onSiteVisit(t, s, { badgeCode: "222222", phone: "+254799888777" });
    for (let i = 0; i < 4; i++) {
      await t.mutation(api.kioskVisitor.checkOut, { ...s.k, badgeCode: "111111", phoneLast4: "0000" });
    }
    expect(await t.mutation(api.kioskVisitor.checkOut, { ...s.k, badgeCode: "222222", phoneLast4: "8777" })).toMatchObject({
      status: "ok",
    });
    expect((await t.run((ctx) => ctx.db.get(other)))?.status).toBe("checked_out");
  });

  test("a badge code older than a day no longer works at the kiosk", async () => {
    const t = newTest();
    const s = await setup(t);
    const visitId = await onSiteVisit(t, s, { checkedInAt: Date.now() - KIOSK_CHECKOUT_MAX_AGE_MS - 60_000 });
    expect(await t.mutation(api.kioskVisitor.checkOut, { ...s.k, badgeCode: "246810", phoneLast4: "1222" })).toEqual({
      status: "no_match",
    });
    expect((await t.run((ctx) => ctx.db.get(visitId)))?.status).toBe("on_site");
    const fresh = await onSiteVisit(t, s, { badgeCode: "135790" });
    expect(await t.mutation(api.kioskVisitor.checkOut, { ...s.k, badgeCode: "135790", phoneLast4: "1222" })).toMatchObject({
      status: "ok",
    });
    expect((await t.run((ctx) => ctx.db.get(fresh)))?.status).toBe("checked_out");
  });

  test("issued badge codes are 6 digits and unique among visitors on site", async () => {
    const t = newTest();
    const s = await setup(t);
    const codes = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const visitId = await s.owner.as.mutation(api.visits.registerWalkIn, {
        organizationId: s.organizationId,
        siteId: s.siteId,
        visitor: { name: `Walker ${i}`, phone: `+2547000000${String(i).padStart(2, "0")}` },
        purpose: "Delivery",
        hostUserId: s.host.userId,
        gateId: s.gateId,
      });
      const v = await t.run((ctx) => ctx.db.get(visitId as Id<"visits">));
      expect(v?.badgeCode).toMatch(/^[1-9]\d{5}$/);
      codes.add(v!.badgeCode!);
    }
    expect(codes.size).toBe(25);
  });
});

describe("escalating lookup lock", () => {
  test("a second lock within a day lasts twice as long", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-02T10:00:00Z"));
    const t = newTest();
    const s = await setup(t);
    const fail = (i: number) =>
      t.mutation(api.kioskVisitor.findAppointments, { ...s.k, phone: `+25471000${String(i).padStart(4, "0")}` });
    for (let i = 0; i < LOOKUP_MAX_FAILURES; i++) await fail(i);
    expect(await fail(99)).toEqual({ status: "locked" });
    let device = await t.run((ctx) => ctx.db.get(s.deviceId));
    expect(device?.lookupLockLevel).toBe(1);
    expect(device!.lookupLockUntil! - Date.now()).toBe(5 * 60_000);
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    for (let i = 0; i < LOOKUP_MAX_FAILURES; i++) await fail(i);
    device = await t.run((ctx) => ctx.db.get(s.deviceId));
    expect(device?.lookupLockLevel).toBe(2);
    expect(device!.lookupLockUntil! - Date.now()).toBe(10 * 60_000);
    // Five minutes on it is still locked (it would not be at level 1).
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    expect(await fail(99)).toEqual({ status: "locked" });
  });
});

describe("walk-in spam budgets", () => {
  const walkIn = (s: S, phone: string, name = "Walt Walker") =>
    ({
      ...s.k,
      visitor: { name, phone },
      purpose: "Deliver parcel",
      hostUserId: s.host.userId,
    }) as const;

  test("one phone number can register only a few times a day, in any format, with a friendly message", async () => {
    const t = newTest();
    const s = await setup(t);
    const formats = ["+254733000111", "0733 000 111", "254733000111"];
    for (let i = 0; i < WALK_IN_MAX_PER_PHONE_PER_DAY; i++) {
      await t.mutation(api.kioskVisitor.registerWalkIn, walkIn(s, formats[i % formats.length]!));
    }
    const err = await t.mutation(api.kioskVisitor.registerWalkIn, walkIn(s, "0733-000-111")).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as { data: { code: string } }).data.code).toBe("RATE_LIMITED");
    expect((err as { data: { message: string } }).data.message).toMatch(/phone number/i);
    expect(await t.run((ctx) => ctx.db.query("visits").collect())).toHaveLength(WALK_IN_MAX_PER_PHONE_PER_DAY);
    // Another number is unaffected, and the budget is per organization.
    await t.mutation(api.kioskVisitor.registerWalkIn, walkIn(s, "+254733000999"));
    const other = await setup(t, "globex");
    await t.mutation(api.kioskVisitor.registerWalkIn, walkIn(other, "+254733000111"));
    const keys = (await t.run((ctx) => ctx.db.query("publicRateLimits").collect())).map((r) => r.key).join(" ");
    expect(keys).not.toContain("733000111");
  });

  test("a device has a daily cap on walk-ins and the counter resets after a day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-02T10:00:00Z"));
    const t = newTest();
    const s = await setup(t);
    await t.run((ctx) =>
      ctx.db.insert("publicRateLimits", {
        key: `walkin_day:${s.deviceId}`,
        windowStart: Date.now() - HOUR,
        count: WALK_IN_MAX_PER_DEVICE_PER_DAY,
      }),
    );
    const err = await t.mutation(api.kioskVisitor.registerWalkIn, walkIn(s, "+254733000222")).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as { data: { code: string } }).data.code).toBe("RATE_LIMITED");
    expect((err as { data: { message: string } }).data.message).toMatch(/daily limit/i);
    vi.setSystemTime(Date.now() + 24 * HOUR);
    await t.mutation(api.kioskVisitor.registerWalkIn, walkIn(s, "+254733000222"));
  });

  test("the sweeper keeps 24 hour walk-in counters that are still live", async () => {
    const t = newTest();
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("publicRateLimits", { key: "walkin_day:live", windowStart: now - 20 * HOUR, count: 5 });
      await ctx.db.insert("publicRateLimits", { key: "walkin_day:dead", windowStart: now - 30 * HOUR, count: 5 });
    });
    await t.mutation(internal.publicLimits.sweepStale, { now });
    const keys = (await t.run((ctx) => ctx.db.query("publicRateLimits").collect())).map((r) => r.key);
    expect(keys).toEqual(["walkin_day:live"]);
  });
});

describe("staff PIN: device-wide failure budget", () => {
  async function ready(t: T) {
    const s = await setup(t);
    const staffers: { userId: Id<"users">; number: string }[] = [];
    for (const n of ["S1", "S2", "S3", "S4"]) {
      const m = await addMember(t, s.organizationId, `${s.k.slug}-${n}`, "staff");
      const membership = await t.run((ctx) =>
        ctx.db
          .query("memberships")
          .withIndex("by_org_user", (q) => q.eq("organizationId", s.organizationId).eq("userId", m.userId))
          .unique(),
      );
      await s.owner.as.mutation(api.attendancePins.setStaffNumber, {
        organizationId: s.organizationId,
        membershipId: membership!._id,
        staffNumber: n,
      });
      await m.as.mutation(api.attendancePins.setMyPin, { organizationId: s.organizationId, pin: "4829" });
      staffers.push({ userId: m.userId, number: n });
    }
    return { s, staffers };
  }

  test("one tablet can lock at most two people per window; then the device itself backs off", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-02T10:00:00Z"));
    const t = newTest();
    const { s, staffers } = await ready(t);
    const identify = (staffNumber: string, pin: string) =>
      t.mutation(api.kioskAttendance.identify, { ...s.k, staffNumber, pin });
    for (const p of staffers) for (let i = 0; i < 5; i++) await identify(p.number, "1111");
    const pins = await t.run((ctx) => ctx.db.query("staffPins").collect());
    expect(pins.filter((p) => (p.lockedUntil ?? 0) > Date.now())).toHaveLength(2);
    // The device is throttled: even a correct PIN is refused, and nothing more is counted.
    expect(await identify("S4", "4829")).toEqual({ ok: false, throttled: true });
    const before = await t.run((ctx) => ctx.db.query("staffPins").collect());
    for (let i = 0; i < 10; i++) await identify("S3", "1111");
    const after = await t.run((ctx) => ctx.db.query("staffPins").collect());
    expect(after.map((p) => p.failedAttempts)).toEqual(before.map((p) => p.failedAttempts));
    const actions = await t.run(async (ctx) => (await ctx.db.query("auditLogs").collect()).map((a) => a.action));
    expect(actions.filter((a) => a === "kiosk.pin_throttled")).toHaveLength(1);
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    expect(await identify("S4", "4829")).toMatchObject({ ok: true });
    expect(PIN_DEVICE_THROTTLE.maxFailures).toBeGreaterThan(5);
  });

  test("an honest typo does not trip the device budget", async () => {
    const t = newTest();
    const { s } = await ready(t);
    await t.mutation(api.kioskAttendance.identify, { ...s.k, staffNumber: "S1", pin: "0000" });
    expect(await t.mutation(api.kioskAttendance.identify, { ...s.k, staffNumber: "S1", pin: "4829" })).toMatchObject({ ok: true });
  });

  test("the budget is per device: another tablet is unaffected", async () => {
    const t = newTest();
    const { s } = await ready(t);
    for (let i = 0; i < PIN_DEVICE_THROTTLE.maxFailures; i++) {
      await t.mutation(api.kioskAttendance.identify, { ...s.k, staffNumber: `NOPE${i}`, pin: "1234" });
    }
    expect(await t.mutation(api.kioskAttendance.identify, { ...s.k, staffNumber: "S4", pin: "4829" })).toMatchObject({
      throttled: true,
    });
    const second = await s.owner.as.mutation(api.kioskDevices.issue, {
      organizationId: s.organizationId,
      gateId: s.gateId,
      name: "Second",
    });
    expect(
      await t.mutation(api.kioskAttendance.identify, { slug: s.k.slug, token: second.token, staffNumber: "S4", pin: "4829" }),
    ).toMatchObject({ ok: true });
  });
});

describe("organizations.getPublicBySlug", () => {
  test("serves branding only, never ids or status, and drops unsafe stored values", async () => {
    const t = newTest();
    const s = await setup(t);
    await t.run((ctx) =>
      ctx.db.patch(s.organizationId, {
        branding: { logoUrl: "javascript:alert(1)", primaryColor: "red; background:url(x)", welcomeText: "<b>Hi</b>" },
      }),
    );
    const pub = await t.query(api.organizations.getPublicBySlug, { slug: "ACME" });
    expect(pub).toEqual({
      name: "acme",
      slug: "acme",
      branding: { logoUrl: null, primaryColor: null, welcomeText: "<b>Hi</b>", privacyNotice: null },
    });
    expect(Object.keys(pub!).sort()).toEqual(["branding", "name", "slug"]);
  });

  test("slugs that cannot exist, and suspended or unknown organizations, are the same null", async () => {
    const t = newTest();
    const s = await setup(t);
    for (const slug of ["", "x", "a".repeat(5000), "has space", "platform", "../etc", "missing-org"]) {
      expect(await t.query(api.organizations.getPublicBySlug, { slug })).toBeNull();
    }
    await t.run((ctx) => ctx.db.patch(s.organizationId, { status: "suspended" }));
    expect(await t.query(api.organizations.getPublicBySlug, { slug: "acme" })).toBeNull();
  });
});

describe("sanity", () => {
  test("a bad token is still NOT_FOUND", async () => {
    const t = newTest();
    await expectCode(
      t.mutation(api.kioskVisitor.checkOut, { slug: "x", token: "wk_x", badgeCode: "123456", phoneLast4: "1234" }),
      "NOT_FOUND",
    );
  });
});
