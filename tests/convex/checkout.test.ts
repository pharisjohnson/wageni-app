import { describe, expect, test } from "vitest";
import { api } from "../../convex/_generated/api";
import { addMember, createOrgWithOwner, expectCode, newTest, type T } from "./setup";

const visitor = { name: "Jane Visitor", phone: "+254700111222" };
const HOUR = 60 * 60 * 1000;

async function setup(t: T) {
  const org = await createOrgWithOwner(t, "Acme", "acme");
  const { organizationId, siteId } = org;
  const reception = await addMember(t, organizationId, "rita", "receptionist");
  const guard = await addMember(t, organizationId, "gus", "guard");
  const host = await addMember(t, organizationId, "hana", "host");
  const otherHost = await addMember(t, organizationId, "hugo", "host");
  const gateId = await org.owner.as.mutation(api.gates.create, {
    organizationId,
    siteId,
    name: "Main gate",
    type: "pedestrian",
  });
  /** An on-site visit hosted by `hostUserId`, via appointment. */
  async function onSite(hostUserId = host.userId, hostAs = host.as) {
    const start = Date.now() + HOUR;
    const appointmentId = await hostAs.mutation(api.appointments.create, {
      organizationId,
      siteId,
      hostUserId,
      visitor,
      purpose: "Meeting",
      scheduledStart: start,
      scheduledEnd: start + HOUR,
    });
    return await guard.as.mutation(api.visits.checkInAppointment, { organizationId, appointmentId, gateId });
  }
  return { ...org, reception, guard, host, otherHost, gateId, onSite };
}

describe("host check-out", () => {
  test("host clears own visitor: events in order, appointment completed, method recorded", async () => {
    const t = newTest();
    const s = await setup(t);
    const visitId = await s.onSite();
    const mine = await s.host.as.query(api.visits.myVisitors, { organizationId: s.organizationId });
    expect(mine.map((v) => v._id)).toEqual([visitId]);

    await s.host.as.mutation(api.visits.hostCheckOut, { organizationId: s.organizationId, visitId });
    const detail = await s.host.as.query(api.visits.get, { organizationId: s.organizationId, visitId });
    expect(detail.status).toBe("checked_out");
    expect(detail.checkedOutMethod).toBe("host");
    expect(detail.events.map((e) => e.type)).toEqual(["checked_in", "meeting_ended", "checked_out"]);
    expect(detail.events[1]?.actorUserId).toBe(s.host.userId);
    const appt = await s.host.as.query(api.appointments.get, {
      organizationId: s.organizationId,
      appointmentId: detail.appointmentId!,
    });
    expect(appt.status).toBe("completed");
    expect(await s.host.as.query(api.visits.myVisitors, { organizationId: s.organizationId })).toEqual([]);

    const audit = await t.run(async (ctx) => (await ctx.db.query("auditLogs").collect()).map((a) => a.action));
    expect(audit).toContain("visit.host_checked_out");
    // Double check-out conflicts, through either entry point.
    await expectCode(
      s.host.as.mutation(api.visits.hostCheckOut, { organizationId: s.organizationId, visitId }),
      "CONFLICT",
    );
    await expectCode(
      s.host.as.mutation(api.visits.checkOut, { organizationId: s.organizationId, visitId }),
      "CONFLICT",
    );
  });

  test("a host cannot check out another host's visitor", async () => {
    const t = newTest();
    const s = await setup(t);
    const visitId = await s.onSite();
    await expectCode(
      s.otherHost.as.mutation(api.visits.hostCheckOut, { organizationId: s.organizationId, visitId }),
      "FORBIDDEN",
    );
    await expectCode(
      s.otherHost.as.mutation(api.visits.checkOut, { organizationId: s.organizationId, visitId }),
      "FORBIDDEN",
    );
    await expectCode(
      s.otherHost.as.query(api.visits.get, { organizationId: s.organizationId, visitId }),
      "FORBIDDEN",
    );
    expect(await s.otherHost.as.query(api.visits.myVisitors, { organizationId: s.organizationId })).toEqual([]);
  });

  test("host can also use checkOut for own visit (method host)", async () => {
    const t = newTest();
    const s = await setup(t);
    const visitId = await s.onSite();
    await s.host.as.mutation(api.visits.checkOut, { organizationId: s.organizationId, visitId });
    const detail = await s.host.as.query(api.visits.get, { organizationId: s.organizationId, visitId });
    expect(detail.checkedOutMethod).toBe("host");
  });

  test("reception checks out any visitor without a gate; guard with a gate", async () => {
    const t = newTest();
    const s = await setup(t);
    const a = await s.onSite();
    const b = await s.onSite(s.otherHost.userId, s.otherHost.as);
    await s.reception.as.mutation(api.visits.checkOut, { organizationId: s.organizationId, visitId: a });
    await s.guard.as.mutation(api.visits.checkOut, {
      organizationId: s.organizationId,
      visitId: b,
      gateId: s.gateId,
    });
    const da = await s.reception.as.query(api.visits.get, { organizationId: s.organizationId, visitId: a });
    const db = await s.reception.as.query(api.visits.get, { organizationId: s.organizationId, visitId: b });
    expect(da.checkedOutMethod).toBe("reception");
    expect(da.checkedOutGateId).toBeUndefined();
    expect(db.checkedOutMethod).toBe("gate");
    expect(db.events.map((e) => e.type)).toEqual(["checked_in", "checked_out"]);
    const recent = await s.reception.as.query(api.visits.recentCheckOuts, {
      organizationId: s.organizationId,
      siteId: s.siteId,
    });
    expect(recent).toHaveLength(2);
  });

  test("staff without check-out permissions are forbidden", async () => {
    const t = newTest();
    const s = await setup(t);
    const visitId = await s.onSite();
    const staff = await addMember(t, s.organizationId, "sam", "staff");
    await expectCode(
      staff.as.mutation(api.visits.checkOut, { organizationId: s.organizationId, visitId }),
      "FORBIDDEN",
    );
  });
});

describe("check-out isolation", () => {
  test("cross-tenant and cross-site callers cannot check out", async () => {
    const t = newTest();
    const s = await setup(t);
    const visitId = await s.onSite();
    const other = await createOrgWithOwner(t, "Beta", "beta");
    await expectCode(
      other.owner.as.mutation(api.visits.checkOut, { organizationId: other.organizationId, visitId }),
      "NOT_FOUND",
    );
    await expectCode(
      other.owner.as.mutation(api.visits.checkOut, { organizationId: s.organizationId, visitId }),
      "NOT_FOUND",
    );
    const annex = await s.owner.as.mutation(api.sites.create, {
      organizationId: s.organizationId,
      name: "Annex",
      timeZone: "Africa/Nairobi",
    });
    const annexReception = await addMember(t, s.organizationId, "ann", "receptionist", [annex]);
    await expectCode(
      annexReception.as.mutation(api.visits.checkOut, { organizationId: s.organizationId, visitId }),
      "NOT_FOUND",
    );
    // A host restricted to another site cannot clear it either.
    const annexHost = await addMember(t, s.organizationId, "ahmed", "host", [annex]);
    await expectCode(
      annexHost.as.mutation(api.visits.hostCheckOut, { organizationId: s.organizationId, visitId }),
      "NOT_FOUND",
    );
    const detail = await s.owner.as.query(api.visits.get, { organizationId: s.organizationId, visitId });
    expect(detail.status).toBe("on_site");
  });
});
