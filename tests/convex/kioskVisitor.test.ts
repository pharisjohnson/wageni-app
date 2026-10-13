import { describe, expect, test } from "vitest";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { LOOKUP_MAX_FAILURES, LOOKUP_WINDOW_MS } from "../../convex/lib/kioskLookup";
import { addMember, createOrgWithOwner, expectCode, newTest, type T } from "./setup";

const HOUR = 60 * 60 * 1000;
const PHONE = "+254700111222";

/** An org with a gate, a paired kiosk and a host. */
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
  const k = { slug, token };

  /** Insert an appointment directly so the test does not depend on the time of day. */
  async function appointment(
    opts: { phone?: string; status?: "approved" | "pending_approval"; start?: number; siteId?: Id<"sites"> } = {},
  ) {
    return await t.run(async (ctx) => {
      const now = Date.now();
      const visitorId = await ctx.db.insert("visitors", {
        organizationId: org.organizationId,
        name: "Jane Visitor",
        phone: opts.phone ?? PHONE,
        createdAt: now,
        updatedAt: now,
      });
      return await ctx.db.insert("appointments", {
        organizationId: org.organizationId,
        siteId: opts.siteId ?? org.siteId,
        visitorId,
        hostUserId: host.userId,
        purpose: "Secret contract talks",
        scheduledStart: opts.start ?? now,
        scheduledEnd: (opts.start ?? now) + HOUR,
        status: opts.status ?? "approved",
        createdBy: host.userId,
        createdAt: now,
        updatedAt: now,
      });
    });
  }

  return { ...org, host, gateId, token, deviceId, k, appointment };
}

async function checkIn(t: T, s: Awaited<ReturnType<typeof setup>>) {
  const appointmentId = await s.appointment();
  const found = await t.mutation(api.kioskVisitor.findAppointments, { ...s.k, phone: PHONE });
  expect(found.status).toBe("found");
  const done = await t.mutation(api.kioskVisitor.checkInAppointment, { ...s.k, appointmentId, phone: PHONE });
  if (done.status !== "ok") throw new Error("check-in failed");
  return { appointmentId, badgeCode: done.badgeCode };
}

describe("kiosk visitor: device token required", () => {
  test("every function rejects a missing, bogus or revoked token", async () => {
    const t = newTest();
    const s = await setup(t);
    const appointmentId = await s.appointment();
    const bad = [{ slug: "acme", token: "" }, { slug: "acme", token: "wk_nope" }, { slug: "acme" }];
    for (const b of bad) {
      const k = { token: "", ...b };
      await expectCode(t.query(api.kioskVisitor.hosts, k), "NOT_FOUND");
      await expectCode(t.mutation(api.kioskVisitor.findAppointments, { ...k, phone: PHONE }), "NOT_FOUND");
      await expectCode(
        t.mutation(api.kioskVisitor.checkInAppointment, { ...k, appointmentId, phone: PHONE }),
        "NOT_FOUND",
      );
      await expectCode(
        t.mutation(api.kioskVisitor.registerWalkIn, {
          ...k,
          visitor: { name: "Walt Walker", phone: PHONE },
          purpose: "Delivery",
          hostUserId: s.host.userId,
        }),
        "NOT_FOUND",
      );
      await expectCode(t.mutation(api.kioskVisitor.checkOut, { ...k, badgeCode: "123456", phoneLast4: "1222" }), "NOT_FOUND");
    }
    await s.owner.as.mutation(api.kioskDevices.revoke, { organizationId: s.organizationId, deviceId: s.deviceId });
    await expectCode(t.mutation(api.kioskVisitor.findAppointments, { ...s.k, phone: PHONE }), "NOT_FOUND");
    await expectCode(t.query(api.kioskVisitor.hosts, s.k), "NOT_FOUND");
  });
});

describe("kiosk appointment check-in", () => {
  test("lookup returns only minimal fields; check-in creates an on-site visit with kiosk origin", async () => {
    const t = newTest();
    const s = await setup(t);
    const appointmentId = await s.appointment();
    const found = await t.mutation(api.kioskVisitor.findAppointments, { ...s.k, phone: "0700 111 222" });
    expect(found).toEqual({
      status: "found",
      matches: [
        {
          appointmentId,
          firstName: "Jane",
          hostName: "acme-hana",
          startAt: expect.any(Number),
        },
      ],
    });
    const json = JSON.stringify(found);
    for (const secret of ["Visitor", "Secret", PHONE, "@example.com"]) expect(json).not.toContain(secret);

    const done = await t.mutation(api.kioskVisitor.checkInAppointment, { ...s.k, appointmentId, phone: PHONE });
    expect(done).toEqual({ status: "ok", firstName: "Jane", hostName: "acme-hana", badgeCode: expect.stringMatching(/^\d{6}$/) });

    const { visit, events, audit, appt } = await t.run(async (ctx) => {
      const visit = (await ctx.db.query("visits").collect())[0]!;
      return {
        visit,
        events: await ctx.db.query("visitEvents").collect(),
        audit: await ctx.db.query("auditLogs").collect(),
        appt: await ctx.db.get(appointmentId),
      };
    });
    expect(visit).toMatchObject({
      status: "on_site",
      checkedInGateId: s.gateId,
      siteId: s.siteId,
      organizationId: s.organizationId,
      appointmentId,
      hostUserId: s.host.userId,
    });
    expect(appt?.status).toBe("checked_in");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "checked_in", kioskDeviceId: s.deviceId, gateId: s.gateId });
    expect(events[0]?.actorUserId).toBeUndefined();
    const entry = audit.find((a) => a.action === "visit.checked_in");
    expect(entry).toMatchObject({ kioskDeviceId: s.deviceId, resourceId: visit._id });
    expect(entry?.actorUserId).toBeUndefined();

    // Staff see the kiosk as the origin on the timeline.
    const detail = await s.owner.as.query(api.visits.get, { organizationId: s.organizationId, visitId: visit._id });
    expect(detail.events[0]?.actorName).toBe("Kiosk: Tablet");

    // Cannot be used twice.
    expect(await t.mutation(api.kioskVisitor.checkInAppointment, { ...s.k, appointmentId, phone: PHONE })).toEqual({
      status: "no_match",
    });
    expect(await t.mutation(api.kioskVisitor.findAppointments, { ...s.k, phone: PHONE })).toEqual({ status: "no_match" });
  });

  test("anything that does not match looks identical (generic response)", async () => {
    const t = newTest();
    const s = await setup(t);
    await s.appointment({ phone: "+254700000001", status: "pending_approval" });
    await s.appointment({ phone: "+254700000002", start: Date.now() + 48 * HOUR });
    await s.appointment({ phone: "+254700000003" }); // real, approved, today
    const results = [];
    for (const phone of ["+254799999999", "+254700000001", "+254700000002"]) {
      results.push(await t.mutation(api.kioskVisitor.findAppointments, { ...s.k, phone }));
    }
    expect(results).toEqual(Array(3).fill({ status: "no_match" }));
  });

  test("an appointment id alone cannot check in: the phone is verified again", async () => {
    const t = newTest();
    const s = await setup(t);
    const appointmentId = await s.appointment();
    const res = await t.mutation(api.kioskVisitor.checkInAppointment, { ...s.k, appointmentId, phone: "+254711000000" });
    expect(res).toEqual({ status: "no_match" });
    expect(await t.run((ctx) => ctx.db.query("visits").collect())).toHaveLength(0);
  });

  test("tenant and site isolation", async () => {
    const t = newTest();
    const a = await setup(t, "acme");
    const b = await setup(t, "globex");
    const bAppt = await b.appointment();
    // Org A's kiosk cannot find or check in org B's appointment.
    expect(await t.mutation(api.kioskVisitor.findAppointments, { ...a.k, phone: PHONE })).toEqual({ status: "no_match" });
    expect(
      await t.mutation(api.kioskVisitor.checkInAppointment, { ...a.k, appointmentId: bAppt, phone: PHONE }),
    ).toEqual({ status: "no_match" });
    // B's token with A's slug fails like any bad token.
    await expectCode(t.mutation(api.kioskVisitor.findAppointments, { slug: "acme", token: b.token, phone: PHONE }), "NOT_FOUND");

    // A second site in org A: its appointments are invisible to the first site's kiosk.
    const site2 = await a.owner.as.mutation(api.sites.create, {
      organizationId: a.organizationId,
      name: "Annex",
      timeZone: "Africa/Nairobi",
    });
    await a.appointment({ siteId: site2 });
    expect(await t.mutation(api.kioskVisitor.findAppointments, { ...a.k, phone: PHONE })).toEqual({ status: "no_match" });
  });

  test("failed lookups are throttled per device, then recover after the window", async () => {
    const t = newTest();
    const s = await setup(t);
    await s.appointment();
    for (let i = 0; i < LOOKUP_MAX_FAILURES; i++) {
      expect(await t.mutation(api.kioskVisitor.findAppointments, { ...s.k, phone: `+25471000000${i}` })).toEqual({
        status: "no_match",
      });
    }
    // Even the correct phone is refused while locked, so a guess can't be confirmed.
    expect(await t.mutation(api.kioskVisitor.findAppointments, { ...s.k, phone: PHONE })).toEqual({ status: "locked" });
    const audit = await t.run(async (ctx) => (await ctx.db.query("auditLogs").collect()).map((a) => a.action));
    expect(audit.filter((a) => a === "kiosk.lookup_throttled")).toHaveLength(1);
    // Another device is unaffected.
    const other = await s.owner.as.mutation(api.kioskDevices.issue, {
      organizationId: s.organizationId,
      gateId: s.gateId,
      name: "Second",
    });
    expect((await t.mutation(api.kioskVisitor.findAppointments, { slug: "acme", token: other.token, phone: PHONE })).status).toBe(
      "found",
    );
    // The window expires.
    await t.run((ctx) => ctx.db.patch(s.deviceId, { lookupWindowStart: Date.now() - LOOKUP_WINDOW_MS - 1 }));
    expect((await t.mutation(api.kioskVisitor.findAppointments, { ...s.k, phone: PHONE })).status).toBe("found");
  });

  test("invalid phone input is a validation error", async () => {
    const t = newTest();
    const s = await setup(t);
    await expectCode(t.mutation(api.kioskVisitor.findAppointments, { ...s.k, phone: "abc" }), "VALIDATION");
    await expectCode(t.mutation(api.kioskVisitor.findAppointments, { ...s.k, phone: "-------" }), "VALIDATION");
  });
});

describe("kiosk walk-in", () => {
  const visitor = { name: "Walt Walker", phone: "+254733000111", company: "Acme Couriers" };

  test("host list is names only, for hosts at this site", async () => {
    const t = newTest();
    const s = await setup(t);
    await addMember(t, s.organizationId, "gus", "guard");
    const list = await t.query(api.kioskVisitor.hosts, s.k);
    const names = list.map((h) => h.name);
    expect(names).toContain("acme-hana");
    expect(names).not.toContain("gus");
    for (const h of list) expect(Object.keys(h).sort()).toEqual(["name", "userId"]);
    expect(JSON.stringify(list)).not.toContain("@");
  });

  test("registers an expected visit (awaiting admit) with kiosk origin", async () => {
    const t = newTest();
    const s = await setup(t);
    const res = await t.mutation(api.kioskVisitor.registerWalkIn, {
      ...s.k,
      visitor,
      purpose: "Deliver parcel",
      hostUserId: s.host.userId,
    });
    expect(res).toEqual({ status: "ok", firstName: "Walt", hostName: "acme-hana" });
    const { visit, events, audit, visitorRow } = await t.run(async (ctx) => {
      const visit = (await ctx.db.query("visits").collect())[0]!;
      return {
        visit,
        events: await ctx.db.query("visitEvents").collect(),
        audit: await ctx.db.query("auditLogs").collect(),
        visitorRow: await ctx.db.get(visit.visitorId),
      };
    });
    expect(visit).toMatchObject({ status: "expected", hostUserId: s.host.userId, purpose: "Deliver parcel", siteId: s.siteId });
    expect(visit.badgeCode).toBeUndefined();
    expect(visitorRow).toMatchObject({ name: "Walt Walker", phone: "+254733000111", organizationId: s.organizationId });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "registered", kioskDeviceId: s.deviceId });
    expect(events[0]?.actorUserId).toBeUndefined();
    expect(audit.find((a) => a.action === "visit.walk_in_registered")).toMatchObject({ kioskDeviceId: s.deviceId });

    // Reception can admit it as usual, which issues the badge.
    const admitted = visit._id;
    await s.owner.as.mutation(api.visits.admit, { organizationId: s.organizationId, visitId: admitted, gateId: s.gateId });
    const after = await s.owner.as.query(api.visits.get, { organizationId: s.organizationId, visitId: admitted });
    expect(after.status).toBe("on_site");
    expect(after.badgeCode).toMatch(/^\d{6}$/);
  });

  test("validates with the shared schema; rejects hosts outside the org/site", async () => {
    const t = newTest();
    const s = await setup(t);
    const other = await setup(t, "globex");
    const base = { ...s.k, visitor, purpose: "Deliver parcel", hostUserId: s.host.userId };
    await expectCode(t.mutation(api.kioskVisitor.registerWalkIn, { ...base, visitor: { ...visitor, name: "W" } }), "VALIDATION");
    await expectCode(
      t.mutation(api.kioskVisitor.registerWalkIn, { ...base, visitor: { ...visitor, phone: "nope" } }),
      "VALIDATION",
    );
    await expectCode(t.mutation(api.kioskVisitor.registerWalkIn, { ...base, purpose: " " }), "VALIDATION");
    await expectCode(t.mutation(api.kioskVisitor.registerWalkIn, { ...base, hostUserId: other.host.userId }), "VALIDATION");
    expect(await t.run((ctx) => ctx.db.query("visits").collect())).toHaveLength(0);
  });

  test("an existing visitor with the same phone is reused but not edited by the public form", async () => {
    const t = newTest();
    const s = await setup(t);
    await s.appointment({ phone: "+254733000111" });
    await t.mutation(api.kioskVisitor.registerWalkIn, {
      ...s.k,
      visitor: { name: "Someone Else", phone: "+254733000111", company: "Evil Corp" },
      purpose: "Deliver parcel",
      hostUserId: s.host.userId,
    });
    const visitors = await t.run((ctx) => ctx.db.query("visitors").collect());
    expect(visitors).toHaveLength(1);
    expect(visitors[0]).toMatchObject({ name: "Jane Visitor" });
    expect(visitors[0]?.company).toBeUndefined();
  });
});

describe("kiosk check-out", () => {
  test("badge code + last 4 digits closes the visit with method kiosk", async () => {
    const t = newTest();
    const s = await setup(t);
    const { appointmentId, badgeCode } = await checkIn(t, s);
    const res = await t.mutation(api.kioskVisitor.checkOut, { ...s.k, badgeCode, phoneLast4: "1222" });
    expect(res).toEqual({ status: "ok", firstName: "Jane" });
    const { visit, events, audit, appt } = await t.run(async (ctx) => ({
      visit: (await ctx.db.query("visits").collect())[0]!,
      events: await ctx.db.query("visitEvents").collect(),
      audit: await ctx.db.query("auditLogs").collect(),
      appt: await ctx.db.get(appointmentId),
    }));
    expect(visit).toMatchObject({ status: "checked_out", checkedOutMethod: "kiosk", checkedOutGateId: s.gateId });
    expect(visit.checkedOutAt).toBeTypeOf("number");
    expect(appt?.status).toBe("completed");
    expect(events.map((e) => e.type)).toEqual(["checked_in", "checked_out"]);
    expect(events[1]).toMatchObject({ kioskDeviceId: s.deviceId, gateId: s.gateId });
    const entry = audit.find((a) => a.action === "visit.checked_out");
    expect(entry).toMatchObject({ kioskDeviceId: s.deviceId, metadata: { method: "kiosk", gateId: s.gateId } });
    // Already out: generic no match.
    expect(await t.mutation(api.kioskVisitor.checkOut, { ...s.k, badgeCode, phoneLast4: "1222" })).toEqual({
      status: "no_match",
    });
  });

  test("wrong code or wrong digits fail identically and never reveal which was wrong", async () => {
    const t = newTest();
    const s = await setup(t);
    const { badgeCode } = await checkIn(t, s);
    const wrongCode = badgeCode === "000000" ? "111111" : "000000";
    const results = [
      await t.mutation(api.kioskVisitor.checkOut, { ...s.k, badgeCode: wrongCode, phoneLast4: "1222" }),
      await t.mutation(api.kioskVisitor.checkOut, { ...s.k, badgeCode, phoneLast4: "9999" }),
      await t.mutation(api.kioskVisitor.checkOut, { ...s.k, badgeCode: wrongCode, phoneLast4: "9999" }),
    ];
    expect(results).toEqual(Array(3).fill({ status: "no_match" }));
    const visit = (await t.run((ctx) => ctx.db.query("visits").collect()))[0]!;
    expect(visit.status).toBe("on_site");
    await expectCode(t.mutation(api.kioskVisitor.checkOut, { ...s.k, badgeCode: "12", phoneLast4: "1222" }), "VALIDATION");
    await expectCode(t.mutation(api.kioskVisitor.checkOut, { ...s.k, badgeCode, phoneLast4: "12" }), "VALIDATION");
  });

  test("guessing is throttled; other sites and tenants cannot be reached", async () => {
    const t = newTest();
    const s = await setup(t);
    const { badgeCode } = await checkIn(t, s);
    for (let i = 0; i < LOOKUP_MAX_FAILURES; i++) {
      await t.mutation(api.kioskVisitor.checkOut, { ...s.k, badgeCode, phoneLast4: `000${i}` });
    }
    // The right answer is now refused too.
    expect(await t.mutation(api.kioskVisitor.checkOut, { ...s.k, badgeCode, phoneLast4: "1222" })).toEqual({ status: "locked" });
    expect((await t.run((ctx) => ctx.db.query("visits").collect()))[0]?.status).toBe("on_site");

    // A kiosk at another site, and one in another org, cannot close this visit.
    const site2 = await s.owner.as.mutation(api.sites.create, {
      organizationId: s.organizationId,
      name: "Annex",
      timeZone: "Africa/Nairobi",
    });
    const gate2 = await s.owner.as.mutation(api.gates.create, {
      organizationId: s.organizationId,
      siteId: site2,
      name: "Annex gate",
      type: "pedestrian",
    });
    const dev2 = await s.owner.as.mutation(api.kioskDevices.issue, {
      organizationId: s.organizationId,
      gateId: gate2,
      name: "Annex tablet",
    });
    const g = await setup(t, "globex");
    for (const k of [{ slug: "acme", token: dev2.token }, g.k]) {
      expect(await t.mutation(api.kioskVisitor.checkOut, { ...k, badgeCode, phoneLast4: "1222" })).toEqual({ status: "no_match" });
    }
    expect((await t.run((ctx) => ctx.db.query("visits").collect()))[0]?.status).toBe("on_site");
  });

  test("host check-out still works on a visit the kiosk checked in", async () => {
    const t = newTest();
    const s = await setup(t);
    await checkIn(t, s);
    const visit = (await t.run((ctx) => ctx.db.query("visits").collect()))[0]!;
    await s.host.as.mutation(api.visits.hostCheckOut, { organizationId: s.organizationId, visitId: visit._id });
    const detail = await s.host.as.query(api.visits.get, { organizationId: s.organizationId, visitId: visit._id });
    expect(detail.checkedOutMethod).toBe("host");
    expect(detail.events.map((e) => [e.type, e.actorName])).toEqual([
      ["checked_in", "Kiosk: Tablet"],
      ["meeting_ended", "acme-hana"],
      ["checked_out", "acme-hana"],
    ]);
  });
});
