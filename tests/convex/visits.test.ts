import { describe, expect, test } from "vitest";
import { api } from "../../convex/_generated/api";
import { addMember, createOrgWithOwner, expectCode, newTest, type T } from "./setup";

const HOUR = 60 * 60 * 1000;
const visitor = { name: "Jane Visitor", phone: "+254700111222" };

async function setup(t: T) {
  const org = await createOrgWithOwner(t, "Acme", "acme");
  const { organizationId, siteId } = org;
  const reception = await addMember(t, organizationId, "rita", "receptionist");
  const guard = await addMember(t, organizationId, "gus", "guard");
  const host = await addMember(t, organizationId, "hana", "host");
  const gateId = await org.owner.as.mutation(api.gates.create, {
    organizationId,
    siteId,
    name: "Main gate",
    type: "pedestrian",
  });
  const start = Date.now() + HOUR;
  return { ...org, reception, guard, host, gateId, start, end: start + HOUR };
}

describe("appointments", () => {
  test("receptionist books for a host; host approves; guard checks in and out", async () => {
    const t = newTest();
    const s = await setup(t);
    const apptId = await s.reception.as.mutation(api.appointments.create, {
      organizationId: s.organizationId,
      siteId: s.siteId,
      hostUserId: s.host.userId,
      visitor,
      purpose: "Contract review",
      scheduledStart: s.start,
      scheduledEnd: s.end,
    });
    // Cannot be checked in until approved.
    await expectCode(
      s.guard.as.mutation(api.visits.checkInAppointment, {
        organizationId: s.organizationId,
        appointmentId: apptId,
        gateId: s.gateId,
      }),
      "CONFLICT",
    );
    await s.host.as.mutation(api.appointments.decide, {
      organizationId: s.organizationId,
      appointmentId: apptId,
      decision: "approved",
    });
    const visitId = await s.guard.as.mutation(api.visits.checkInAppointment, {
      organizationId: s.organizationId,
      appointmentId: apptId,
      gateId: s.gateId,
    });
    const active = await s.guard.as.query(api.visits.listActive, { organizationId: s.organizationId });
    expect(active.map((v) => v._id)).toEqual([visitId]);
    expect(active[0]?.visitorName).toBe("Jane Visitor");

    await s.guard.as.mutation(api.visits.checkOut, {
      organizationId: s.organizationId,
      visitId,
      gateId: s.gateId,
    });
    expect(await s.guard.as.query(api.visits.listActive, { organizationId: s.organizationId })).toEqual([]);
    const detail = await s.guard.as.query(api.visits.get, { organizationId: s.organizationId, visitId });
    expect(detail.events.map((e) => e.type)).toEqual(["checked_in", "checked_out"]);
    // Double check-out is rejected.
    await expectCode(
      s.guard.as.mutation(api.visits.checkOut, { organizationId: s.organizationId, visitId, gateId: s.gateId }),
      "CONFLICT",
    );
  });

  test("a host auto-approves their own booking but cannot book for others", async () => {
    const t = newTest();
    const s = await setup(t);
    const own = await s.host.as.mutation(api.appointments.create, {
      organizationId: s.organizationId,
      siteId: s.siteId,
      hostUserId: s.host.userId,
      visitor,
      purpose: "Interview",
      scheduledStart: s.start,
      scheduledEnd: s.end,
    });
    const appt = await s.host.as.query(api.appointments.get, {
      organizationId: s.organizationId,
      appointmentId: own,
    });
    expect(appt.status).toBe("approved");
    await expectCode(
      s.host.as.mutation(api.appointments.create, {
        organizationId: s.organizationId,
        siteId: s.siteId,
        hostUserId: s.reception.userId,
        visitor,
        purpose: "Not mine",
        scheduledStart: s.start,
        scheduledEnd: s.end,
      }),
      "FORBIDDEN",
    );
  });

  test("hosts only see their own appointments; receptionists cannot approve", async () => {
    const t = newTest();
    const s = await setup(t);
    const other = await addMember(t, s.organizationId, "hugo", "host");
    const apptId = await s.reception.as.mutation(api.appointments.create, {
      organizationId: s.organizationId,
      siteId: s.siteId,
      hostUserId: s.host.userId,
      visitor,
      purpose: "Meeting",
      scheduledStart: s.start,
      scheduledEnd: s.end,
    });
    const range = { from: Date.now(), to: Date.now() + 24 * HOUR };
    expect(await s.host.as.query(api.appointments.list, { organizationId: s.organizationId, ...range })).toHaveLength(1);
    expect(await other.as.query(api.appointments.list, { organizationId: s.organizationId, ...range })).toHaveLength(0);
    await expectCode(
      other.as.query(api.appointments.get, { organizationId: s.organizationId, appointmentId: apptId }),
      "NOT_FOUND",
    );
    await expectCode(
      s.reception.as.mutation(api.appointments.decide, {
        organizationId: s.organizationId,
        appointmentId: apptId,
        decision: "approved",
      }),
      "FORBIDDEN",
    );
    await expectCode(
      other.as.mutation(api.appointments.decide, {
        organizationId: s.organizationId,
        appointmentId: apptId,
        decision: "approved",
      }),
      "NOT_FOUND",
    );
  });

  test("validation: past times and inverted ranges are rejected", async () => {
    const t = newTest();
    const s = await setup(t);
    const base = {
      organizationId: s.organizationId,
      siteId: s.siteId,
      hostUserId: s.host.userId,
      visitor,
      purpose: "Meeting",
    };
    await expectCode(
      s.reception.as.mutation(api.appointments.create, { ...base, scheduledStart: s.end, scheduledEnd: s.start }),
      "VALIDATION",
    );
    await expectCode(
      s.reception.as.mutation(api.appointments.create, {
        ...base,
        scheduledStart: Date.now() - 2 * HOUR,
        scheduledEnd: Date.now() - HOUR,
      }),
      "VALIDATION",
    );
  });

  test("cancelled appointments cannot be checked in", async () => {
    const t = newTest();
    const s = await setup(t);
    const apptId = await s.host.as.mutation(api.appointments.create, {
      organizationId: s.organizationId,
      siteId: s.siteId,
      hostUserId: s.host.userId,
      visitor,
      purpose: "Meeting",
      scheduledStart: s.start,
      scheduledEnd: s.end,
    });
    await s.host.as.mutation(api.appointments.cancel, { organizationId: s.organizationId, appointmentId: apptId });
    await expectCode(
      s.guard.as.mutation(api.visits.checkInAppointment, {
        organizationId: s.organizationId,
        appointmentId: apptId,
        gateId: s.gateId,
      }),
      "CONFLICT",
    );
  });
});

describe("walk-ins", () => {
  test("receptionist registers; guard admits; returning visitor is reused", async () => {
    const t = newTest();
    const s = await setup(t);
    const visitId = await s.reception.as.mutation(api.visits.registerWalkIn, {
      organizationId: s.organizationId,
      siteId: s.siteId,
      visitor,
      purpose: "Delivery",
    });
    // Receptionists cannot admit.
    await expectCode(
      s.reception.as.mutation(api.visits.admit, { organizationId: s.organizationId, visitId, gateId: s.gateId }),
      "FORBIDDEN",
    );
    await s.guard.as.mutation(api.visits.admit, { organizationId: s.organizationId, visitId, gateId: s.gateId });
    const detail = await s.guard.as.query(api.visits.get, { organizationId: s.organizationId, visitId });
    expect(detail.status).toBe("on_site");
    expect(detail.badgeCode).toMatch(/^\d{6}$/);

    await s.reception.as.mutation(api.visits.registerWalkIn, {
      organizationId: s.organizationId,
      siteId: s.siteId,
      visitor: { ...visitor, name: "Jane V." },
      purpose: "Second visit",
    });
    const count = await t.run(async (ctx) => (await ctx.db.query("visitors").collect()).length);
    expect(count).toBe(1);
  });

  test("a guard with a gate admits a walk-in immediately", async () => {
    const t = newTest();
    const s = await setup(t);
    // Guards lack visitors:register_walk_in by default, so grant it as an override.
    await t.run(async (ctx) =>
      ctx.db.patch(s.guard.membershipId, {
        permissionOverrides: { grant: ["visitors:register_walk_in"], revoke: [] },
      }),
    );
    const visitId = await s.guard.as.mutation(api.visits.registerWalkIn, {
      organizationId: s.organizationId,
      siteId: s.siteId,
      visitor,
      purpose: "Courier",
      gateId: s.gateId,
    });
    const detail = await s.guard.as.query(api.visits.get, { organizationId: s.organizationId, visitId });
    expect(detail.status).toBe("on_site");
    expect(detail.events.map((e) => e.type)).toEqual(["registered", "checked_in"]);
  });
});

describe("tenant and site isolation", () => {
  test("another organization cannot see or act on visits, appointments or gates", async () => {
    const t = newTest();
    const a = await setup(t);
    const b = await createOrgWithOwner(t, "Beta", "beta");
    const visitId = await a.reception.as.mutation(api.visits.registerWalkIn, {
      organizationId: a.organizationId,
      siteId: a.siteId,
      visitor,
      purpose: "Delivery",
    });
    // Cross-tenant: membership check fails first.
    await expectCode(b.owner.as.query(api.visits.get, { organizationId: a.organizationId, visitId }), "NOT_FOUND");
    // Same caller, own org, foreign record id: still NOT_FOUND.
    await expectCode(b.owner.as.query(api.visits.get, { organizationId: b.organizationId, visitId }), "NOT_FOUND");
    await expectCode(
      b.owner.as.mutation(api.visits.admit, { organizationId: b.organizationId, visitId, gateId: a.gateId }),
      "NOT_FOUND",
    );
    // A gate from another org cannot be used for check-in.
    const own = await b.owner.as.mutation(api.visits.registerWalkIn, {
      organizationId: b.organizationId,
      siteId: b.siteId,
      visitor,
      purpose: "Visit",
    });
    await expectCode(
      b.owner.as.mutation(api.visits.admit, { organizationId: b.organizationId, visitId: own, gateId: a.gateId }),
      "NOT_FOUND",
    );
  });

  test("site-restricted staff cannot touch other sites", async () => {
    const t = newTest();
    const s = await setup(t);
    const annex = await s.owner.as.mutation(api.sites.create, {
      organizationId: s.organizationId,
      name: "Annex",
      timeZone: "Africa/Nairobi",
    });
    const annexGate = await s.owner.as.mutation(api.gates.create, {
      organizationId: s.organizationId,
      siteId: annex,
      name: "Annex gate",
      type: "pedestrian",
    });
    const restricted = await addMember(t, s.organizationId, "gail", "guard", [s.siteId]);
    const visitId = await s.owner.as.mutation(api.visits.registerWalkIn, {
      organizationId: s.organizationId,
      siteId: annex,
      visitor,
      purpose: "Annex visit",
    });
    await expectCode(
      restricted.as.mutation(api.visits.admit, {
        organizationId: s.organizationId,
        visitId,
        gateId: annexGate,
      }),
      "NOT_FOUND",
    );
    expect(await restricted.as.query(api.visits.listActive, { organizationId: s.organizationId })).toEqual([]);
  });
});
