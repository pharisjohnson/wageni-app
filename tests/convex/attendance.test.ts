import { describe, expect, test } from "vitest";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { addMember, createOrgWithOwner, expectCode, newTest, type T } from "./setup";

const H = 3_600_000;

async function setup(t: T, slug = "acme") {
  const a = await createOrgWithOwner(t, "Acme", slug);
  const admin = await addMember(t, a.organizationId, `${slug}-admin`, "admin");
  const reception = await addMember(t, a.organizationId, `${slug}-recep`, "receptionist");
  const staff = await addMember(t, a.organizationId, `${slug}-staff`, "staff");
  const gateId = await a.owner.as.mutation(api.gates.create, {
    organizationId: a.organizationId,
    siteId: a.siteId,
    name: "Front",
    type: "pedestrian",
  });
  const { token } = await a.owner.as.mutation(api.kioskDevices.issue, {
    organizationId: a.organizationId,
    gateId,
    name: "Tablet",
  });
  return { ...a, admin, reception, staff, gateId, token, slug };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

/** Insert an event directly (as the backend would) at a chosen time. */
function seed(
  t: T,
  a: Ctx,
  userId: Id<"users">,
  type: "clock_in" | "clock_out",
  at: number,
  siteId: Id<"sites"> = a.siteId,
) {
  return t.run((ctx) =>
    ctx.db.insert("attendanceEvents", {
      organizationId: a.organizationId,
      siteId,
      userId,
      type,
      at,
      source: "app",
      createdAt: Date.now(),
    }),
  );
}

const range = (from: number, to: number) => ({ from, to });
const rangeOf = (a: Ctx, from: number, to: number) => ({ organizationId: a.organizationId, from, to });

describe("clock in and out", () => {
  test("clock in, then out; double clock-in and clock-out while out are CONFLICT", async () => {
    const t = newTest();
    const a = await setup(t);
    const org = { organizationId: a.organizationId };
    await expectCode(a.staff.as.mutation(api.attendance.clockOut, org), "CONFLICT");
    await a.staff.as.mutation(api.attendance.clockIn, { ...org, siteId: a.siteId });
    await expectCode(a.staff.as.mutation(api.attendance.clockIn, { ...org, siteId: a.siteId }), "CONFLICT");
    const status = await a.staff.as.query(api.attendance.myStatus, org);
    expect(status).toMatchObject({ status: "in", siteName: "Head Office" });
    await a.staff.as.mutation(api.attendance.clockOut, org);
    expect((await a.staff.as.query(api.attendance.myStatus, org)).status).toBe("out");
    const events = await t.run((ctx) => ctx.db.query("attendanceEvents").collect());
    expect(events.map((e) => [e.type, e.source])).toEqual([
      ["clock_in", "app"],
      ["clock_out", "app"],
    ]);
  });

  test("a forgotten clock-out from long ago does not block the next shift", async () => {
    const t = newTest();
    const a = await setup(t);
    const org = { organizationId: a.organizationId };
    await seed(t, a, a.staff.userId, "clock_in", Date.now() - 30 * H);
    await a.staff.as.mutation(api.attendance.clockIn, { ...org, siteId: a.siteId });
    const hist = await a.staff.as.query(api.attendance.myHistory, rangeOf(a, Date.now() - 3 * 24 * H, Date.now() + H));
    expect(hist.hasUnclosed).toBe(true);
  });

  test("the sign-in is required and an inactive or foreign site is rejected", async () => {
    const t = newTest();
    const a = await setup(t);
    const b = await setup(t, "globex");
    await expect(
      t.mutation(api.attendance.clockIn, { organizationId: a.organizationId, siteId: a.siteId }),
    ).rejects.toThrow();
    await expectCode(
      a.staff.as.mutation(api.attendance.clockIn, { organizationId: a.organizationId, siteId: b.siteId }),
      "NOT_FOUND",
    );
    await t.run((ctx) => ctx.db.patch(a.siteId, { status: "inactive" }));
    await expectCode(
      a.staff.as.mutation(api.attendance.clockIn, { organizationId: a.organizationId, siteId: a.siteId }),
      "NOT_FOUND",
    );
  });
});

describe("append-only history and corrections", () => {
  test("approving adds a new event and never edits or removes the original", async () => {
    const t = newTest();
    const a = await setup(t);
    const org = { organizationId: a.organizationId };
    const now = Date.now();
    const inId = await seed(t, a, a.staff.userId, "clock_in", now - 10 * H);
    const before = await t.run((ctx) => ctx.db.get(inId));

    const correctionId = await a.staff.as.mutation(api.attendance.requestCorrection, {
      ...org,
      siteId: a.siteId,
      proposedType: "clock_out",
      proposedAt: now - 2 * H,
      reason: "Forgot to clock out",
    });
    // Pending changes nothing.
    expect(await t.run((ctx) => ctx.db.query("attendanceEvents").collect())).toHaveLength(1);
    const pending = await a.admin.as.query(api.attendance.pendingCorrections, org);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ userName: "acme-staff", proposedType: "clock_out", requestedBySelf: true });

    await a.admin.as.mutation(api.attendance.decideCorrection, { ...org, correctionId, decision: "approved" });
    const events = await t.run((ctx) => ctx.db.query("attendanceEvents").collect());
    expect(events).toHaveLength(2);
    expect(await t.run((ctx) => ctx.db.get(inId))).toEqual(before);
    const added = events.find((e) => e._id !== inId)!;
    expect(added).toMatchObject({
      type: "clock_out",
      source: "correction",
      correctionId,
      recordedBy: a.admin.userId,
    });
    const hist = await a.staff.as.query(api.attendance.myHistory, rangeOf(a, now - 2 * 24 * H, now + H));
    expect(hist.days.reduce((n, d) => n + d.totalMs, 0)).toBe(8 * H);
    const c = await t.run((ctx) => ctx.db.get(correctionId));
    expect(c).toMatchObject({ status: "approved", decidedBy: a.admin.userId, resultEventId: added._id });
    await expectCode(
      a.admin.as.mutation(api.attendance.decideCorrection, { ...org, correctionId, decision: "rejected", note: "x" }),
      "CONFLICT",
    );
  });

  test("a wrong time is replaced: the original stays in history but is superseded", async () => {
    const t = newTest();
    const a = await setup(t);
    const org = { organizationId: a.organizationId };
    const now = Date.now();
    const inId = await seed(t, a, a.staff.userId, "clock_in", now - 9 * H);
    await seed(t, a, a.staff.userId, "clock_out", now - 1 * H);
    const correctionId = await a.staff.as.mutation(api.attendance.requestCorrection, {
      ...org,
      siteId: a.siteId,
      originalEventId: inId,
      proposedType: "clock_in",
      proposedAt: now - 10 * H,
      reason: "Arrived earlier",
    });
    await expectCode(
      a.staff.as.mutation(api.attendance.requestCorrection, {
        ...org,
        siteId: a.siteId,
        originalEventId: inId,
        proposedType: "clock_in",
        proposedAt: now - 11 * H,
        reason: "Again",
      }),
      "CONFLICT",
    );
    await a.admin.as.mutation(api.attendance.decideCorrection, { ...org, correctionId, decision: "approved" });
    const hist = await a.staff.as.query(api.attendance.myHistory, rangeOf(a, now - 2 * 24 * H, now + H));
    expect(hist.days.reduce((n, d) => n + d.totalMs, 0)).toBe(9 * H);
    const original = hist.events.find((e) => e._id === inId)!;
    expect(original.superseded).toBe(true);
    expect(hist.events.some((e) => e.isCorrection && e.correctsEventId === inId)).toBe(true);
    expect(hist.events).toHaveLength(3);
  });

  test("rejecting needs a reason, adds no event and can be asked again", async () => {
    const t = newTest();
    const a = await setup(t);
    const org = { organizationId: a.organizationId };
    const now = Date.now();
    const inId = await seed(t, a, a.staff.userId, "clock_in", now - 5 * H);
    const ask = () =>
      a.staff.as.mutation(api.attendance.requestCorrection, {
        ...org,
        siteId: a.siteId,
        originalEventId: inId,
        proposedType: "clock_in",
        proposedAt: now - 6 * H,
        reason: "Earlier start",
      });
    const id = await ask();
    await expectCode(
      a.admin.as.mutation(api.attendance.decideCorrection, { ...org, correctionId: id, decision: "rejected" }),
      "VALIDATION",
    );
    await a.admin.as.mutation(api.attendance.decideCorrection, {
      ...org,
      correctionId: id,
      decision: "rejected",
      note: "Badge log says 10:00",
    });
    expect(await t.run((ctx) => ctx.db.query("attendanceEvents").collect())).toHaveLength(1);
    await ask();
  });

  test("validation: no future times, no ancient times, reason required; nobody decides their own", async () => {
    const t = newTest();
    const a = await setup(t);
    const org = { organizationId: a.organizationId };
    const base = { ...org, siteId: a.siteId, proposedType: "clock_out" as const };
    const now = Date.now();
    await expectCode(
      a.staff.as.mutation(api.attendance.requestCorrection, { ...base, proposedAt: now + H, reason: "later" }),
      "VALIDATION",
    );
    await expectCode(
      a.staff.as.mutation(api.attendance.requestCorrection, { ...base, proposedAt: now - 100 * 24 * H, reason: "old" }),
      "VALIDATION",
    );
    await expectCode(
      a.staff.as.mutation(api.attendance.requestCorrection, { ...base, proposedAt: now - H, reason: " " }),
      "VALIDATION",
    );
    // A manager's own request cannot be approved by themselves.
    const own = await a.admin.as.mutation(api.attendance.requestCorrection, {
      ...base,
      proposedAt: now - H,
      reason: "my own",
    });
    await expectCode(
      a.admin.as.mutation(api.attendance.decideCorrection, { ...org, correctionId: own, decision: "approved" }),
      "FORBIDDEN",
    );
    await a.owner.as.mutation(api.attendance.decideCorrection, { ...org, correctionId: own, decision: "approved" });
  });

  test("a manager can request a correction for someone else, audited; staff cannot", async () => {
    const t = newTest();
    const a = await setup(t);
    const org = { organizationId: a.organizationId };
    const args = {
      ...org,
      siteId: a.siteId,
      userId: a.staff.userId,
      proposedType: "clock_in" as const,
      proposedAt: Date.now() - 3 * H,
      reason: "Guard log shows arrival",
    };
    await expectCode(a.reception.as.mutation(api.attendance.requestCorrection, args), "FORBIDDEN");
    const other = await addMember(t, a.organizationId, "other-staff", "staff");
    await expectCode(
      other.as.mutation(api.attendance.requestCorrection, { ...args, userId: a.staff.userId }),
      "FORBIDDEN",
    );
    const id = await a.admin.as.mutation(api.attendance.requestCorrection, args);
    const audit = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    expect(audit.some((l) => l.action === "attendance.correction_requested_for" && l.resourceId === id)).toBe(true);
    const mine = await a.staff.as.query(api.attendance.myHistory, rangeOf(a, Date.now() - 24 * H, Date.now() + H));
    expect(mine.corrections[0]).toMatchObject({ requestedBySelf: false, status: "pending" });
  });
});

describe("tenant, site and role isolation", () => {
  test("another organization sees nothing and cannot act on records", async () => {
    const t = newTest();
    const a = await setup(t);
    const b = await setup(t, "globex");
    const now = Date.now();
    const inId = await seed(t, a, a.staff.userId, "clock_in", now - 4 * H);
    const cId = await a.staff.as.mutation(api.attendance.requestCorrection, {
      organizationId: a.organizationId,
      siteId: a.siteId,
      originalEventId: inId,
      proposedType: "clock_in",
      proposedAt: now - 5 * H,
      reason: "earlier",
    });
    // B's owner is not a member of A.
    await expectCode(
      b.owner.as.query(api.attendance.pendingCorrections, { organizationId: a.organizationId }),
      "NOT_FOUND",
    );
    await expectCode(
      b.owner.as.mutation(api.attendance.decideCorrection, {
        organizationId: a.organizationId,
        correctionId: cId,
        decision: "approved",
      }),
      "NOT_FOUND",
    );
    // Passing A's ids with B's organization id finds nothing.
    await expectCode(
      b.owner.as.mutation(api.attendance.decideCorrection, {
        organizationId: b.organizationId,
        correctionId: cId,
        decision: "approved",
      }),
      "NOT_FOUND",
    );
    await expectCode(
      b.owner.as.query(api.attendance.personHistory, {
        organizationId: b.organizationId,
        userId: a.staff.userId,
        ...range(now - 24 * H, now),
      }),
      "NOT_FOUND",
    );
    await expectCode(
      b.owner.as.query(api.attendance.siteRoster, { organizationId: b.organizationId, siteId: a.siteId }),
      "NOT_FOUND",
    );
    const roster = await b.owner.as.query(api.attendance.siteRoster, {
      organizationId: b.organizationId,
      siteId: b.siteId,
    });
    expect(roster.rows.every((r) => r.status === "absent")).toBe(true);
  });

  test("site-restricted members only reach their sites", async () => {
    const t = newTest();
    const a = await setup(t);
    const secondId = await a.owner.as.mutation(api.sites.create, {
      organizationId: a.organizationId,
      name: "Branch",
      timeZone: "Africa/Nairobi",
    });
    const branchStaff = await addMember(t, a.organizationId, "branch-staff", "staff", [secondId]);
    await addMember(t, a.organizationId, "head-staff", "staff", [a.siteId]);
    const branchAdmin = await addMember(t, a.organizationId, "branch-admin", "admin", [secondId]);
    const org = { organizationId: a.organizationId };
    // Staff restricted to Branch cannot clock in at Head Office.
    await expectCode(branchStaff.as.mutation(api.attendance.clockIn, { ...org, siteId: a.siteId }), "NOT_FOUND");
    await branchStaff.as.mutation(api.attendance.clockIn, { ...org, siteId: secondId });
    // Branch admin cannot read Head Office, or record someone there.
    await expectCode(branchAdmin.as.query(api.attendance.siteRoster, { ...org, siteId: a.siteId }), "NOT_FOUND");
    await expectCode(
      branchAdmin.as.mutation(api.attendance.recordOnBehalf, {
        ...org,
        siteId: a.siteId,
        userId: a.staff.userId,
        type: "clock_in",
      }),
      "NOT_FOUND",
    );
    // ...and a person restricted elsewhere cannot be recorded at a site they cannot access.
    await expectCode(
      a.admin.as.mutation(api.attendance.recordOnBehalf, {
        ...org,
        siteId: a.siteId,
        userId: branchStaff.userId,
        type: "clock_in",
      }),
      "NOT_FOUND",
    );
    // The branch admin's roster contains only people with access to Branch.
    const roster = await branchAdmin.as.query(api.attendance.siteRoster, { ...org, siteId: secondId });
    const names = roster.rows.map((r) => r.name);
    expect(names).toContain("branch-staff");
    expect(names).not.toContain("head-staff");
    expect(roster.rows.find((r) => r.name === "branch-staff")?.status).toBe("in");
    // Their history of a Head Office event is invisible to the branch admin.
    await seed(t, a, a.staff.userId, "clock_in", Date.now() - H);
    const person = await branchAdmin.as.query(api.attendance.personHistory, {
      ...org,
      userId: a.staff.userId,
      ...range(Date.now() - 24 * H, Date.now() + H),
    });
    expect(person.events).toHaveLength(0);
  });

  test("roles: staff cannot read the site, decide, or record for others", async () => {
    const t = newTest();
    const a = await setup(t);
    const org = { organizationId: a.organizationId };
    const now = Date.now();
    await expectCode(a.staff.as.query(api.attendance.siteRoster, { ...org, siteId: a.siteId }), "FORBIDDEN");
    await expectCode(a.staff.as.query(api.attendance.pendingCorrections, org), "FORBIDDEN");
    await expectCode(
      a.staff.as.query(api.attendance.personHistory, { ...org, userId: a.admin.userId, ...range(now - H, now) }),
      "FORBIDDEN",
    );
    await expectCode(
      a.staff.as.mutation(api.attendance.recordOnBehalf, {
        ...org,
        siteId: a.siteId,
        userId: a.admin.userId,
        type: "clock_in",
      }),
      "FORBIDDEN",
    );
    // Reception reads the roster but cannot decide corrections or see the correction queue.
    await a.reception.as.query(api.attendance.siteRoster, { ...org, siteId: a.siteId });
    await expectCode(a.reception.as.query(api.attendance.pendingCorrections, org), "FORBIDDEN");
  });

  test("a member whose attendance permission was revoked cannot clock in", async () => {
    const t = newTest();
    const a = await setup(t);
    const org = { organizationId: a.organizationId };
    const m = await t.run((ctx) =>
      ctx.db.query("memberships").withIndex("by_org_user", (q) =>
        q.eq("organizationId", a.organizationId).eq("userId", a.staff.userId),
      ).unique(),
    );
    await a.owner.as.mutation(api.memberships.setOverrides, {
      ...org,
      membershipId: m!._id,
      overrides: { grant: [], revoke: ["staff_attendance:create"] },
    });
    await expectCode(a.staff.as.mutation(api.attendance.clockIn, { ...org, siteId: a.siteId }), "FORBIDDEN");
  });
});

describe("record on behalf and the site roster", () => {
  test("reception records for staff; audited; shows who is in now", async () => {
    const t = newTest();
    const a = await setup(t);
    const org = { organizationId: a.organizationId };
    await a.reception.as.mutation(api.attendance.recordOnBehalf, {
      ...org,
      siteId: a.siteId,
      userId: a.staff.userId,
      type: "clock_in",
      note: "Phone died",
    });
    await expectCode(
      a.reception.as.mutation(api.attendance.recordOnBehalf, {
        ...org,
        siteId: a.siteId,
        userId: a.staff.userId,
        type: "clock_in",
      }),
      "CONFLICT",
    );
    await expectCode(
      a.reception.as.mutation(api.attendance.recordOnBehalf, {
        ...org,
        siteId: a.siteId,
        userId: a.reception.userId,
        type: "clock_in",
      }),
      "FORBIDDEN",
    );
    const ev = (await t.run((ctx) => ctx.db.query("attendanceEvents").collect()))[0]!;
    expect(ev).toMatchObject({ source: "reception", recordedBy: a.reception.userId, userId: a.staff.userId });
    const audit = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    expect(audit.find((l) => l.action === "attendance.recorded_on_behalf")).toMatchObject({
      actorUserId: a.reception.userId,
      resourceId: ev._id,
    });
    const roster = await a.admin.as.query(api.attendance.siteRoster, { ...org, siteId: a.siteId });
    expect(roster.isToday).toBe(true);
    expect(roster.inNowCount).toBe(1);
    expect(roster.rows[0]).toMatchObject({ name: "acme-staff", status: "in" });
    await a.reception.as.mutation(api.attendance.recordOnBehalf, {
      ...org,
      siteId: a.siteId,
      userId: a.staff.userId,
      type: "clock_out",
    });
    expect((await a.admin.as.query(api.attendance.siteRoster, { ...org, siteId: a.siteId })).inNowCount).toBe(0);
    await expectCode(
      a.admin.as.query(api.attendance.siteRoster, { ...org, siteId: a.siteId, date: "2999-01-01" }),
      "VALIDATION",
    );
  });
});

describe("hours and time zones", () => {
  // Monday 22:00 to Tuesday 02:00 in Nairobi (UTC+3).
  const IN = Date.parse("2026-01-12T19:00:00Z");
  const OUT = Date.parse("2026-01-12T23:00:00Z");

  test("daily hours follow the site's time zone", async () => {
    const t = newTest();
    const a = await setup(t);
    const org = { organizationId: a.organizationId };
    await seed(t, a, a.staff.userId, "clock_in", IN);
    await seed(t, a, a.staff.userId, "clock_out", OUT);
    const window = range(Date.parse("2026-01-10T00:00:00Z"), Date.parse("2026-01-20T00:00:00Z"));
    const days = async () =>
      (await a.staff.as.query(api.attendance.myHistory, { ...org, ...window })).days.map(
        (d) => [d.date, d.totalMs / H] as const,
      );
    // Africa/Nairobi: split across Monday and Tuesday.
    expect((await days()).sort()).toEqual([
      ["2026-01-12", 2],
      ["2026-01-13", 2],
    ]);
    await t.run((ctx) => ctx.db.patch(a.siteId, { timeZone: "UTC" }));
    expect(await days()).toEqual([["2026-01-12", 4]]);
    await t.run((ctx) => ctx.db.patch(a.siteId, { timeZone: "Pacific/Auckland" }));
    // UTC+13 in January: 08:00 to 12:00 on Tuesday.
    expect(await days()).toEqual([["2026-01-13", 4]]);
  });

  test("the roster totals one local day and flags a missing clock-out", async () => {
    const t = newTest();
    const a = await setup(t);
    const org = { organizationId: a.organizationId };
    await seed(t, a, a.staff.userId, "clock_in", IN);
    await seed(t, a, a.staff.userId, "clock_out", OUT);
    const mon = await a.admin.as.query(api.attendance.siteRoster, { ...org, siteId: a.siteId, date: "2026-01-12" });
    const tue = await a.admin.as.query(api.attendance.siteRoster, { ...org, siteId: a.siteId, date: "2026-01-13" });
    const row = (r: typeof mon) => r.rows.find((x) => x.name === "acme-staff")!;
    expect(row(mon)).toMatchObject({ totalMs: 2 * H, status: "out" });
    expect(row(tue)).toMatchObject({ totalMs: 2 * H, status: "out" });
    expect(row(mon).needsAttention).toBe(false);
    expect(mon.timeZone).toBe("Africa/Nairobi");
    // A clock-in with no clock-out at the end of that day needs attention.
    await seed(t, a, a.reception.userId, "clock_in", Date.parse("2026-01-12T06:00:00Z"));
    const again = await a.admin.as.query(api.attendance.siteRoster, { ...org, siteId: a.siteId, date: "2026-01-12" });
    expect(again.rows.find((x) => x.name === "acme-recep")).toMatchObject({ status: "out", needsAttention: true });
  });

  test("ranges are bounded", async () => {
    const t = newTest();
    const a = await setup(t);
    await expectCode(
      a.staff.as.query(api.attendance.myHistory, { organizationId: a.organizationId, from: 0, to: 100 * 24 * H }),
      "VALIDATION",
    );
  });
});

describe("staff PINs", () => {
  async function withPin(t: T, a: Ctx, number = "S100", pin = "4829") {
    const membership = await t.run((ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q) => q.eq("organizationId", a.organizationId).eq("userId", a.staff.userId))
        .unique(),
    );
    await a.admin.as.mutation(api.attendancePins.setStaffNumber, {
      organizationId: a.organizationId,
      membershipId: membership!._id,
      staffNumber: number,
    });
    await a.staff.as.mutation(api.attendancePins.setMyPin, { organizationId: a.organizationId, pin });
    return membership!._id;
  }

  test("the PIN is hashed, salted, validated, and never returned", async () => {
    const t = newTest();
    const a = await setup(t);
    const org = { organizationId: a.organizationId };
    await expectCode(a.staff.as.mutation(api.attendancePins.setMyPin, { ...org, pin: "4829" }), "VALIDATION"); // no staff number yet
    await withPin(t, a);
    for (const bad of ["123", "1234567", "abcd", "1111", "1234"]) {
      await expectCode(a.staff.as.mutation(api.attendancePins.setMyPin, { ...org, pin: bad }), "VALIDATION");
    }
    const rows = await t.run((ctx) => ctx.db.query("staffPins").collect());
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain("4829");
    expect(rows[0]!.salt.length).toBeGreaterThan(10);
    const status = await a.staff.as.query(api.attendancePins.myPinStatus, org);
    expect(status).toMatchObject({ staffNumber: "S100", pinSet: true, locked: false });
    expect(JSON.stringify(status)).not.toMatch(/pinHash|salt/);
    // Same PIN, different user: different salt and hash.
    await a.staff.as.mutation(api.attendancePins.setMyPin, { ...org, pin: "4829" });
    const other = await addMember(t, a.organizationId, "second", "staff");
    const om = await t.run((ctx) =>
      ctx.db.query("memberships").withIndex("by_org_user", (q) =>
        q.eq("organizationId", a.organizationId).eq("userId", other.userId),
      ).unique(),
    );
    await a.admin.as.mutation(api.attendancePins.setStaffNumber, { ...org, membershipId: om!._id, staffNumber: "s101" });
    await other.as.mutation(api.attendancePins.setMyPin, { ...org, pin: "4829" });
    const [p1, p2] = await t.run((ctx) => ctx.db.query("staffPins").collect());
    expect(p1!.pinHash).not.toBe(p2!.pinHash);
    expect(p1!.salt).not.toBe(p2!.salt);
  });

  test("staff numbers are unique per organization and managed by authorised roles only", async () => {
    const t = newTest();
    const a = await setup(t);
    const b = await setup(t, "globex");
    const org = { organizationId: a.organizationId };
    const mId = await withPin(t, a, "S100");
    const other = await addMember(t, a.organizationId, "second", "staff");
    const om = await t.run((ctx) =>
      ctx.db.query("memberships").withIndex("by_org_user", (q) =>
        q.eq("organizationId", a.organizationId).eq("userId", other.userId),
      ).unique(),
    );
    await expectCode(
      a.admin.as.mutation(api.attendancePins.setStaffNumber, { ...org, membershipId: om!._id, staffNumber: "s100" }),
      "CONFLICT",
    );
    await expectCode(
      a.admin.as.mutation(api.attendancePins.setStaffNumber, { ...org, membershipId: om!._id, staffNumber: "x" }),
      "VALIDATION",
    );
    await expectCode(
      a.reception.as.mutation(api.attendancePins.setStaffNumber, { ...org, membershipId: om!._id, staffNumber: "S5" }),
      "FORBIDDEN",
    );
    await expectCode(a.staff.as.mutation(api.attendancePins.resetPin, { ...org, membershipId: mId }), "FORBIDDEN");
    // Another organization may reuse the number.
    const bStaff = await addMember(t, b.organizationId, "g-staff", "staff");
    const bm = await t.run((ctx) =>
      ctx.db.query("memberships").withIndex("by_org_user", (q) =>
        q.eq("organizationId", b.organizationId).eq("userId", bStaff.userId),
      ).unique(),
    );
    await b.owner.as.mutation(api.attendancePins.setStaffNumber, {
      organizationId: b.organizationId,
      membershipId: bm!._id,
      staffNumber: "S100",
    });
    // A manager cannot touch their own or a foreign membership.
    await expectCode(
      b.owner.as.mutation(api.attendancePins.resetPin, { organizationId: b.organizationId, membershipId: mId }),
      "NOT_FOUND",
    );
    await a.admin.as.mutation(api.attendancePins.resetPin, { ...org, membershipId: mId });
    expect(await t.run((ctx) => ctx.db.query("staffPins").collect())).toHaveLength(0);
    // Changing the number discards the old PIN.
    await withPin(t, a, "S200");
    await a.admin.as.mutation(api.attendancePins.setStaffNumber, { ...org, membershipId: mId, staffNumber: "S201" });
    expect(await t.run((ctx) => ctx.db.query("staffPins").collect())).toHaveLength(0);
  });
});

describe("kiosk staff attendance", () => {
  const kiosk = (a: Ctx) => ({ slug: a.slug, token: a.token });

  async function ready(t: T) {
    const a = await setup(t);
    const membership = await t.run((ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q) => q.eq("organizationId", a.organizationId).eq("userId", a.staff.userId))
        .unique(),
    );
    await a.admin.as.mutation(api.attendancePins.setStaffNumber, {
      organizationId: a.organizationId,
      membershipId: membership!._id,
      staffNumber: "S100",
    });
    await a.staff.as.mutation(api.attendancePins.setMyPin, { organizationId: a.organizationId, pin: "4829" });
    return a;
  }

  test("a device token is required; the URL alone grants nothing", async () => {
    const t = newTest();
    const a = await ready(t);
    for (const bad of [{ slug: a.slug, token: "" }, { slug: a.slug, token: "wk_nope" }, { slug: "other", token: a.token }]) {
      await expectCode(t.mutation(api.kioskAttendance.identify, { ...bad, staffNumber: "S100", pin: "4829" }), "NOT_FOUND");
      await expectCode(
        t.mutation(api.kioskAttendance.record, { ...bad, staffNumber: "S100", pin: "4829", type: "clock_in" }),
        "NOT_FOUND",
      );
    }
    expect(await t.run((ctx) => ctx.db.query("attendanceEvents").collect())).toHaveLength(0);
  });

  test("identify says hello; record writes a kiosk event; conflicts are handled", async () => {
    const t = newTest();
    const a = await ready(t);
    const id = await t.mutation(api.kioskAttendance.identify, { ...kiosk(a), staffNumber: " s100 ", pin: "4829" });
    expect(id).toMatchObject({ ok: true, firstName: "acme-staff", status: "out" });
    // Identify alone writes nothing.
    expect(await t.run((ctx) => ctx.db.query("attendanceEvents").collect())).toHaveLength(0);
    const rec = await t.mutation(api.kioskAttendance.record, {
      ...kiosk(a),
      staffNumber: "S100",
      pin: "4829",
      type: "clock_in",
    });
    expect(rec).toMatchObject({ ok: true, outcome: "recorded" });
    const [ev] = await t.run((ctx) => ctx.db.query("attendanceEvents").collect());
    expect(ev).toMatchObject({ source: "kiosk", userId: a.staff.userId, siteId: a.siteId, gateId: a.gateId });
    expect(ev!.kioskDeviceId).toBeDefined();
    const again = await t.mutation(api.kioskAttendance.record, {
      ...kiosk(a),
      staffNumber: "S100",
      pin: "4829",
      type: "clock_in",
    });
    expect(again).toMatchObject({ ok: true, outcome: "already_in" });
    expect((await a.staff.as.query(api.attendance.myStatus, { organizationId: a.organizationId })).status).toBe("in");
    const out = await t.mutation(api.kioskAttendance.record, {
      ...kiosk(a),
      staffNumber: "S100",
      pin: "4829",
      type: "clock_out",
    });
    expect(out).toMatchObject({ ok: true, outcome: "recorded" });
    const notIn = await t.mutation(api.kioskAttendance.record, {
      ...kiosk(a),
      staffNumber: "S100",
      pin: "4829",
      type: "clock_out",
    });
    expect(notIn).toMatchObject({ ok: true, outcome: "not_in" });
  });

  test("the PIN is checked on every action, not only at identify", async () => {
    const t = newTest();
    const a = await ready(t);
    await t.mutation(api.kioskAttendance.identify, { ...kiosk(a), staffNumber: "S100", pin: "4829" });
    const r = await t.mutation(api.kioskAttendance.record, { ...kiosk(a), staffNumber: "S100", pin: "9999", type: "clock_in" });
    expect(r).toEqual({ ok: false });
    expect(await t.run((ctx) => ctx.db.query("attendanceEvents").collect())).toHaveLength(0);
  });

  test("failures are identical and generic; 5 wrong PINs lock for 15 minutes", async () => {
    const t = newTest();
    const a = await ready(t);
    const call = (staffNumber: string, pin: string) =>
      t.mutation(api.kioskAttendance.identify, { ...kiosk(a), staffNumber, pin });
    const unknown = await call("NOPE1", "4829");
    const wrong = await call("S100", "9999");
    const malformed = await call("S100", "12");
    expect(unknown).toEqual({ ok: false });
    expect(wrong).toEqual(unknown);
    expect(malformed).toEqual(unknown);
    // The failed attempt persisted (a thrown error would have rolled it back).
    let pin = (await t.run((ctx) => ctx.db.query("staffPins").collect()))[0]!;
    expect(pin.failedAttempts).toBe(1);
    for (let i = 0; i < 4; i++) expect(await call("S100", "9999")).toEqual({ ok: false });
    pin = (await t.run((ctx) => ctx.db.query("staffPins").collect()))[0]!;
    expect(pin.failedAttempts).toBe(5);
    expect(pin.lockedUntil).toBeGreaterThan(Date.now() + 14 * 60_000);
    // Even the right PIN is refused, with the same generic answer.
    expect(await call("S100", "4829")).toEqual({ ok: false });
    expect(
      (await a.staff.as.query(api.attendancePins.myPinStatus, { organizationId: a.organizationId })).locked,
    ).toBe(true);
    const audit = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    expect(audit.some((l) => l.action === "attendance.pin_locked")).toBe(true);
    // When the lock runs out the right PIN works again and the counter resets.
    await t.run((ctx) => ctx.db.patch(pin._id, { lockedUntil: Date.now() - 1 }));
    expect(await call("S100", "4829")).toMatchObject({ ok: true });
    pin = (await t.run((ctx) => ctx.db.query("staffPins").collect()))[0]!;
    expect(pin).toMatchObject({ failedAttempts: 0 });
    expect(pin.lockedUntil).toBeUndefined();
  });

  test("a manager reset clears the lockout and removes the PIN", async () => {
    const t = newTest();
    const a = await ready(t);
    for (let i = 0; i < 5; i++) {
      await t.mutation(api.kioskAttendance.identify, { ...kiosk(a), staffNumber: "S100", pin: "0000" });
    }
    const mId = (await t.run((ctx) => ctx.db.query("memberships").collect())).find((m) => m.staffNumber === "S100")!._id;
    await a.admin.as.mutation(api.attendancePins.resetPin, { organizationId: a.organizationId, membershipId: mId });
    expect(await t.mutation(api.kioskAttendance.identify, { ...kiosk(a), staffNumber: "S100", pin: "4829" })).toEqual({ ok: false });
    await a.staff.as.mutation(api.attendancePins.setMyPin, { organizationId: a.organizationId, pin: "7351" });
    expect(await t.mutation(api.kioskAttendance.identify, { ...kiosk(a), staffNumber: "S100", pin: "7351" })).toMatchObject({ ok: true });
  });

  test("other organizations, disabled members and members without site access cannot use the kiosk", async () => {
    const t = newTest();
    const a = await ready(t);
    const b = await setup(t, "globex");
    // A's staff number and PIN at B's kiosk.
    expect(
      await t.mutation(api.kioskAttendance.identify, { slug: b.slug, token: b.token, staffNumber: "S100", pin: "4829" }),
    ).toEqual({ ok: false });
    // No access to this kiosk's site.
    const m = (await t.run((ctx) => ctx.db.query("memberships").collect())).find((x) => x.staffNumber === "S100")!;
    const otherId = await a.owner.as.mutation(api.sites.create, {
      organizationId: a.organizationId,
      name: "Branch",
      timeZone: "Africa/Nairobi",
    });
    await t.run((ctx) => ctx.db.patch(m._id, { siteAccess: [otherId] }));
    expect(await t.mutation(api.kioskAttendance.identify, { ...kiosk(a), staffNumber: "S100", pin: "4829" })).toEqual({ ok: false });
    await t.run((ctx) => ctx.db.patch(m._id, { siteAccess: "all", status: "disabled" }));
    expect(await t.mutation(api.kioskAttendance.identify, { ...kiosk(a), staffNumber: "S100", pin: "4829" })).toEqual({ ok: false });
    // Not counted against a disabled person's PIN: no oracle either way.
    await t.run((ctx) => ctx.db.patch(m._id, { status: "active" }));
    expect(await t.mutation(api.kioskAttendance.identify, { ...kiosk(a), staffNumber: "S100", pin: "4829" })).toMatchObject({ ok: true });
  });

  test("a revoked device stops working", async () => {
    const t = newTest();
    const a = await ready(t);
    const device = (await t.run((ctx) => ctx.db.query("kioskDevices").collect()))[0]!;
    await a.owner.as.mutation(api.kioskDevices.revoke, { organizationId: a.organizationId, deviceId: device._id });
    await expectCode(
      t.mutation(api.kioskAttendance.identify, { ...kiosk(a), staffNumber: "S100", pin: "4829" }),
      "NOT_FOUND",
    );
  });
});
