import { describe, expect, test } from "vitest";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { addMember, createOrgWithOwner, expectCode, newTest, type T } from "./setup";

const MIN = 60_000;
const H = 60 * MIN;
const JUNE = (day: number, h = 0, m = 0) => Date.UTC(2026, 5, day, h, m);

async function setup(t: T, slug = "acme") {
  const a = await createOrgWithOwner(t, "Acme", slug);
  const admin = await addMember(t, a.organizationId, `${slug}-admin`, "admin");
  const reception = await addMember(t, a.organizationId, `${slug}-recep`, "receptionist");
  const guard = await addMember(t, a.organizationId, `${slug}-guard`, "guard");
  const host = await addMember(t, a.organizationId, `${slug}-host`, "host");
  return { ...a, admin, reception, guard, host };
}
type S = Awaited<ReturnType<typeof setup>>;

type SeedVisit = {
  siteId?: Id<"sites">;
  name?: string;
  createdAt: number;
  checkedInAt?: number;
  checkedOutAt?: number;
  meetingEndedAt?: number;
  status?: "expected" | "on_site" | "checked_out";
  host?: Id<"users">;
  purpose?: string;
  appointment?: boolean;
  phone?: string;
  company?: string;
};

/** Insert a visit (with visitor and events) the way the backend would, at chosen times. */
async function seedVisit(t: T, s: S, o: SeedVisit) {
  return await t.run(async (ctx) => {
    const siteId = o.siteId ?? s.siteId;
    const visitorId = await ctx.db.insert("visitors", {
      organizationId: s.organizationId,
      name: o.name ?? "Visitor",
      phone: o.phone,
      company: o.company,
      createdAt: o.createdAt,
      updatedAt: o.createdAt,
    });
    let appointmentId: Id<"appointments"> | undefined;
    if (o.appointment && o.host) {
      appointmentId = await ctx.db.insert("appointments", {
        organizationId: s.organizationId,
        siteId,
        visitorId,
        hostUserId: o.host,
        purpose: o.purpose ?? "Meeting",
        scheduledStart: o.createdAt,
        scheduledEnd: o.createdAt + H,
        status: "completed",
        createdBy: o.host,
        createdAt: o.createdAt,
        updatedAt: o.createdAt,
      });
    }
    const status = o.status ?? (o.checkedOutAt ? "checked_out" : o.checkedInAt ? "on_site" : "expected");
    const visitId = await ctx.db.insert("visits", {
      organizationId: s.organizationId,
      siteId,
      visitorId,
      appointmentId,
      hostUserId: o.host,
      purpose: o.purpose ?? "Meeting",
      status,
      checkedInAt: o.checkedInAt,
      checkedOutAt: o.checkedOutAt,
      createdAt: o.createdAt,
      updatedAt: o.createdAt,
    });
    const ev = (type: "checked_in" | "meeting_ended" | "checked_out", at: number) =>
      ctx.db.insert("visitEvents", {
        organizationId: s.organizationId,
        siteId,
        visitId,
        type,
        actorUserId: o.host ?? s.owner.userId,
        at,
      });
    if (o.checkedInAt) await ev("checked_in", o.checkedInAt);
    if (o.meetingEndedAt) await ev("meeting_ended", o.meetingEndedAt);
    if (o.checkedOutAt) await ev("checked_out", o.checkedOutAt);
    return visitId;
  });
}

const range = (s: S, extra: object = {}) => ({
  organizationId: s.organizationId,
  fromDate: "2026-06-01",
  toDate: "2026-06-30",
  ...extra,
});

describe("reports.visits", () => {
  test("durations use host confirmation then check-out; breakdowns and no-shows", async () => {
    const t = newTest();
    const s = await setup(t);
    await seedVisit(t, s, { createdAt: JUNE(2, 7), checkedInAt: JUNE(2, 7), checkedOutAt: JUNE(2, 8), host: s.host.userId, appointment: true, purpose: "Interview" });
    await seedVisit(t, s, {
      createdAt: JUNE(2, 9),
      checkedInAt: JUNE(2, 9),
      meetingEndedAt: JUNE(2, 9, 30),
      checkedOutAt: JUNE(2, 10, 30),
      host: s.host.userId,
      purpose: "interview",
    });
    await seedVisit(t, s, { createdAt: JUNE(3, 9), checkedInAt: JUNE(3, 9), purpose: "Delivery" }); // still on site
    await seedVisit(t, s, { createdAt: JUNE(3, 10), purpose: "Delivery" }); // expected
    // No-show: approved appointment in the past that never checked in.
    await t.run(async (ctx) => {
      const visitorId = await ctx.db.insert("visitors", { organizationId: s.organizationId, name: "Ghost", createdAt: 1, updatedAt: 1 });
      await ctx.db.insert("appointments", {
        organizationId: s.organizationId,
        siteId: s.siteId,
        visitorId,
        hostUserId: s.host.userId,
        purpose: "Lunch",
        scheduledStart: JUNE(4, 9),
        scheduledEnd: JUNE(4, 10),
        status: "approved",
        createdBy: s.host.userId,
        createdAt: 1,
        updatedAt: 1,
      });
    });

    const r = await s.reception.as.query(api.reports.visits, range(s));
    expect(r.summary).toMatchObject({ total: 4, onSite: 1, expected: 1, checkedOut: 2, walkIns: 3, byAppointment: 1, hostConfirmed: 1 });
    expect(r.summary.avgDurationMs).toBe(45 * MIN);
    expect(r.noShows).toBe(1);
    expect(r.byPurpose[0]).toMatchObject({ key: "delivery", count: 2 });
    expect(r.byHost.find((h) => h.label === "acme-host")?.count).toBe(2);
    // Contact details never appear on screen.
    expect(JSON.stringify(r.rows)).not.toContain("phone");
    expect(r.truncated).toBe(false);
  });

  test("busiest hours and days use the site time zone, range edges respect DST", async () => {
    const t = newTest();
    const s = await setup(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(s.organizationId, { timeZone: "America/New_York" });
      await ctx.db.patch(s.siteId, { timeZone: "America/New_York" });
    });
    const inside = Date.UTC(2026, 2, 9, 3, 30); // 23:30 EDT on 8 March
    const outside = Date.UTC(2026, 2, 9, 4, 30); // 00:30 EDT on 9 March
    const early = Date.UTC(2026, 2, 8, 6, 30); // 01:30 EST on 8 March
    for (const at of [inside, outside, early]) await seedVisit(t, s, { createdAt: at, checkedInAt: at, checkedOutAt: at + H });
    const r = await s.admin.as.query(api.reports.visits, {
      organizationId: s.organizationId,
      fromDate: "2026-03-08",
      toDate: "2026-03-08",
    });
    expect(r.summary.total).toBe(2);
    expect(r.byDay).toEqual([{ date: "2026-03-08", count: 2 }]);
    expect(r.byHour[23]!.count).toBe(1);
    expect(r.byHour[1]!.count).toBe(1);
  });

  test("bounds the date range and rejects bad dates", async () => {
    const t = newTest();
    const s = await setup(t);
    await expectCode(s.admin.as.query(api.reports.visits, range(s, { fromDate: "2026-01-01", toDate: "2026-12-31" })), "VALIDATION");
    await expectCode(s.admin.as.query(api.reports.visits, range(s, { fromDate: "x", toDate: "y" })), "VALIDATION");
    await expectCode(s.admin.as.query(api.reports.visits, range(s, { fromDate: "2026-06-10", toDate: "2026-06-01" })), "VALIDATION");
  });

  test("permission checks: guards and hosts cannot read reports", async () => {
    const t = newTest();
    const s = await setup(t);
    await expectCode(s.guard.as.query(api.reports.visits, range(s)), "FORBIDDEN");
    await expectCode(s.host.as.query(api.reports.onSite, { organizationId: s.organizationId }), "FORBIDDEN");
    await expectCode(s.host.as.query(api.reports.filterOptions, { organizationId: s.organizationId }), "FORBIDDEN");
    await s.reception.as.query(api.reports.visits, range(s));
  });

  test("site isolation: a site-restricted member sees only their site", async () => {
    const t = newTest();
    const s = await setup(t);
    const site2 = await s.owner.as.mutation(api.sites.create, { organizationId: s.organizationId, name: "Annex", timeZone: "Africa/Nairobi" });
    const restricted = await addMember(t, s.organizationId, "restricted", "receptionist", [s.siteId]);
    await seedVisit(t, s, { createdAt: JUNE(2, 9), checkedInAt: JUNE(2, 9), name: "Main visitor" });
    await seedVisit(t, s, { createdAt: JUNE(2, 9), checkedInAt: JUNE(2, 9), name: "Annex visitor", siteId: site2 });

    const all = await s.owner.as.query(api.reports.visits, range(s));
    expect(all.summary.total).toBe(2);
    const mine = await restricted.as.query(api.reports.visits, range(s));
    expect(mine.summary.total).toBe(1);
    expect(mine.rows.map((r) => r.visitorName)).toEqual(["Main visitor"]);
    await expectCode(restricted.as.query(api.reports.visits, range(s, { siteId: site2 })), "NOT_FOUND");
    const onSite = await restricted.as.query(api.reports.onSite, { organizationId: s.organizationId });
    expect(onSite.rows.map((r) => r.visitorName)).toEqual(["Main visitor"]);
    const options = await restricted.as.query(api.reports.filterOptions, { organizationId: s.organizationId });
    expect(options.sites.map((x) => x.name)).toEqual(["Head Office"]);
    // Filtering the owner's view by the annex works.
    const annex = await s.owner.as.query(api.reports.visits, range(s, { siteId: site2 }));
    expect(annex.summary.total).toBe(1);
    // Export respects site access too.
    const restrictedAdmin = await addMember(t, s.organizationId, "restricted-admin", "admin", [s.siteId]);
    const exported = await restrictedAdmin.as.mutation(api.reportsExport.csv, { organizationId: s.organizationId, report: "visits", fromDate: "2026-06-01", toDate: "2026-06-30" });
    expect(exported.rowCount).toBe(1);
    expect(exported.csv).toContain("Main visitor");
    expect(exported.csv).not.toContain("Annex visitor");
  });

  test("tenant isolation: no cross-organization reads", async () => {
    const t = newTest();
    const a = await setup(t, "acme");
    const b = await setup(t, "beta");
    await seedVisit(t, a, { createdAt: JUNE(2, 9), checkedInAt: JUNE(2, 9), name: "Acme only" });
    await expectCode(b.owner.as.query(api.reports.visits, range(a)), "NOT_FOUND");
    // Own organization + foreign site id.
    await expectCode(b.owner.as.query(api.reports.visits, range(b, { siteId: a.siteId })), "NOT_FOUND");
    await expectCode(b.owner.as.query(api.reports.onSite, { organizationId: b.organizationId, siteId: a.siteId }), "NOT_FOUND");
    await expectCode(
      b.owner.as.mutation(api.reportsExport.csv, { organizationId: b.organizationId, report: "visits", fromDate: "2026-06-01", toDate: "2026-06-30", siteId: a.siteId }),
      "NOT_FOUND",
    );
    const mine = await b.owner.as.query(api.reports.visits, range(b));
    expect(mine.summary.total).toBe(0);
    expect(JSON.stringify(mine)).not.toContain("Acme only");
  });
});

describe("reports.onSite", () => {
  test("now, and historically at a past instant", async () => {
    const t = newTest();
    const s = await setup(t);
    // Left before noon; still here; arrived after noon.
    await seedVisit(t, s, { name: "Left early", createdAt: JUNE(2, 8), checkedInAt: JUNE(2, 8), checkedOutAt: JUNE(2, 11) });
    await seedVisit(t, s, { name: "Stayed", createdAt: JUNE(2, 9), checkedInAt: JUNE(2, 9), checkedOutAt: JUNE(2, 15) });
    await seedVisit(t, s, { name: "Late", createdAt: JUNE(2, 13), checkedInAt: JUNE(2, 13) });
    const now = await s.reception.as.query(api.reports.onSite, { organizationId: s.organizationId });
    expect(now.rows.map((r) => r.visitorName)).toEqual(["Late"]);
    const noon = await s.reception.as.query(api.reports.onSite, { organizationId: s.organizationId, at: JUNE(2, 12) });
    expect(noon.historical).toBe(true);
    expect(noon.rows.map((r) => r.visitorName)).toEqual(["Stayed"]);
    const ten = await s.reception.as.query(api.reports.onSite, { organizationId: s.organizationId, at: JUNE(2, 10) });
    expect(ten.rows.map((r) => r.visitorName).sort()).toEqual(["Left early", "Stayed"]);
    await expectCode(
      s.reception.as.query(api.reports.onSite, { organizationId: s.organizationId, at: Date.now() + 10 * H }),
      "VALIDATION",
    );
  });
});

describe("reports.hostMeetings", () => {
  test("who met whom and when the host confirmed", async () => {
    const t = newTest();
    const s = await setup(t);
    await seedVisit(t, s, { name: "Confirmed", createdAt: JUNE(2, 9), checkedInAt: JUNE(2, 9), meetingEndedAt: JUNE(2, 10), checkedOutAt: JUNE(2, 10, 5), host: s.host.userId });
    await seedVisit(t, s, { name: "Unconfirmed", createdAt: JUNE(2, 11), checkedInAt: JUNE(2, 11), checkedOutAt: JUNE(2, 12), host: s.host.userId });
    await seedVisit(t, s, { name: "No host", createdAt: JUNE(2, 11), checkedInAt: JUNE(2, 11) });
    const r = await s.admin.as.query(api.reports.hostMeetings, range(s));
    expect(r.total).toBe(2);
    expect(r.confirmed).toBe(1);
    const row = r.rows.find((x) => x.visitorName === "Confirmed")!;
    expect(row).toMatchObject({ hostName: "acme-host", confirmedBy: "acme-host", meetingMs: H });
    const filtered = await s.admin.as.query(api.reports.hostMeetings, range(s, { hostUserId: s.reception.userId }));
    expect(filtered.total).toBe(0);
  });
});

describe("reports.appointments", () => {
  test("outcomes", async () => {
    const t = newTest();
    const s = await setup(t);
    await t.run(async (ctx) => {
      const visitorId = await ctx.db.insert("visitors", { organizationId: s.organizationId, name: "V", createdAt: 1, updatedAt: 1 });
      for (const [i, status] of (["completed", "approved", "cancelled", "declined", "checked_in"] as const).entries()) {
        await ctx.db.insert("appointments", {
          organizationId: s.organizationId,
          siteId: s.siteId,
          visitorId,
          hostUserId: s.host.userId,
          purpose: "P",
          scheduledStart: JUNE(2 + i, 9),
          scheduledEnd: JUNE(2 + i, 10),
          status,
          createdBy: s.host.userId,
          createdAt: 1,
          updatedAt: 1,
        });
      }
    });
    const r = await s.reception.as.query(api.reports.appointments, range(s));
    expect(r.counts).toMatchObject({ attended: 2, no_show: 1, cancelled: 1, declined: 1 });
    expect(r.attendanceRate).toBeCloseTo(2 / 3);
  });
});

describe("reports.attendance", () => {
  test("hours per person per day, late, absent, corrections", async () => {
    const t = newTest();
    const s = await setup(t);
    const staff = await addMember(t, s.organizationId, "sam", "staff");
    await t.run(async (ctx) => {
      const ev = (type: "clock_in" | "clock_out", at: number) =>
        ctx.db.insert("attendanceEvents", {
          organizationId: s.organizationId,
          siteId: s.siteId,
          userId: staff.userId,
          type,
          at,
          source: "app",
          createdAt: at,
        });
      // Africa/Nairobi is UTC+3. Mon 1 June: in 08:30 local; Tue 2 June: in 10:00 local (late).
      await ev("clock_in", JUNE(1, 5, 30));
      await ev("clock_out", JUNE(1, 14));
      await ev("clock_in", JUNE(2, 7));
      await ev("clock_out", JUNE(2, 11));
      await ctx.db.insert("attendanceCorrections", {
        organizationId: s.organizationId,
        siteId: s.siteId,
        userId: staff.userId,
        requestedBy: staff.userId,
        proposedType: "clock_out",
        proposedAt: JUNE(2, 11),
        reason: "forgot",
        status: "pending",
        createdAt: JUNE(2, 12),
      });
      // Members are "expected" only from the day they joined.
      await ctx.db.patch(staff.membershipId, { createdAt: JUNE(1, 0) });
    });
    const r = await s.reception.as.query(api.reports.attendance, {
      organizationId: s.organizationId,
      fromDate: "2026-06-01",
      toDate: "2026-06-05",
      userId: staff.userId,
    });
    const p = r.people[0]!;
    expect(p.name).toBe("sam");
    expect(p.totalMs).toBe(8.5 * H + 4 * H);
    expect(p.lateCount).toBe(1);
    expect(p.absentDates).toEqual(["2026-06-03", "2026-06-04", "2026-06-05"]);
    expect(p.corrections.pending).toBe(1);
    expect(r.totals.corrections).toBe(1);
    // Guards (no reports:read) and hosts are refused; so is anyone lacking the roster permission.
    await expectCode(s.guard.as.query(api.reports.attendance, { organizationId: s.organizationId, fromDate: "2026-06-01", toDate: "2026-06-05" }), "FORBIDDEN");
    await expectCode(s.admin.as.query(api.reports.attendance, { organizationId: s.organizationId, fromDate: "2026-04-01", toDate: "2026-06-30" }), "VALIDATION");
  });
});

describe("reports.today", () => {
  test("returns only the figures the role may see", async () => {
    const t = newTest();
    const s = await setup(t);
    const now = Date.now();
    await seedVisit(t, s, { createdAt: now - MIN, checkedInAt: now - MIN });
    const owner = await s.owner.as.query(api.reports.today, { organizationId: s.organizationId });
    expect(owner.onSite).toBe(1);
    expect(owner.checkedInToday).toBeGreaterThanOrEqual(0);
    expect(owner.staffIn).not.toBeNull();
    const host = await s.host.as.query(api.reports.today, { organizationId: s.organizationId });
    expect(host).toMatchObject({ onSite: null, expected: null, staffIn: null });
  });
});

describe("csv export", () => {
  const exportArgs = (s: S, extra: object = {}) => ({
    organizationId: s.organizationId,
    report: "visits" as const,
    fromDate: "2026-06-01",
    toDate: "2026-06-30",
    ...extra,
  });

  test("requires reports:export; reception can read but not export", async () => {
    const t = newTest();
    const s = await setup(t);
    await expectCode(s.reception.as.mutation(api.reportsExport.csv, exportArgs(s)), "FORBIDDEN");
    await expectCode(s.guard.as.mutation(api.reportsExport.csv, exportArgs(s)), "FORBIDDEN");
    await s.admin.as.mutation(api.reportsExport.csv, exportArgs(s));
  });

  test("escapes, neutralises formulas, adds BOM, and omits sensitive columns by default", async () => {
    const t = newTest();
    const s = await setup(t);
    await seedVisit(t, s, { createdAt: JUNE(2, 9), checkedInAt: JUNE(2, 9), checkedOutAt: JUNE(2, 10), name: '=HYPERLINK("http://evil","x")', company: "Acme, Ltd", phone: "+254700000000" });
    const out = await s.admin.as.mutation(api.reportsExport.csv, exportArgs(s));
    expect(out.csv.startsWith("﻿")).toBe(true);
    expect(out.csv).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(out.csv).toContain('"Acme, Ltd"');
    expect(out.csv).not.toContain("+254700000000");
    expect(out.csv.split("\r\n")[0]).not.toContain("Phone");
    expect(out.omittedColumns).toEqual(["Phone", "Email"]);
    expect(out.rowCount).toBe(1);
    expect(out.truncated).toBe(false);
    expect(out.filename).toBe("wageni-visits-2026-06-01_to_2026-06-30.csv");
    // Sensitive columns need forms:read_sensitive (owner and admin hold it; the default export omits them).
    const full = await s.owner.as.mutation(api.reportsExport.csv, exportArgs(s, { includeSensitive: true }));
    expect(full.omittedColumns).toEqual([]);
  });

  test("every export is audited with who, what, filters and row count", async () => {
    const t = newTest();
    const s = await setup(t);
    await seedVisit(t, s, { createdAt: JUNE(2, 9), checkedInAt: JUNE(2, 9) });
    await seedVisit(t, s, { createdAt: JUNE(3, 9), checkedInAt: JUNE(3, 9) });
    await s.admin.as.mutation(api.reportsExport.csv, exportArgs(s, { siteId: s.siteId }));
    const log = await s.owner.as.query(api.audit.list, {
      organizationId: s.organizationId,
      paginationOpts: { numItems: 10, cursor: null },
      action: "report.exported",
    });
    expect(log.page).toHaveLength(1);
    const entry = log.page[0]!;
    expect(entry.actorUserId).toBe(s.admin.userId);
    expect(entry.actor).toEqual({ kind: "user", name: "acme-admin" });
    expect(entry.resourceId).toBe("visits");
    expect(entry.metadata).toMatchObject({ rowCount: 2, fromDate: "2026-06-01", toDate: "2026-06-30", siteId: s.siteId, includeSensitive: false, truncated: false });
  });

  test("other report kinds export", async () => {
    const t = newTest();
    const s = await setup(t);
    await seedVisit(t, s, { createdAt: JUNE(2, 9), checkedInAt: JUNE(2, 9), meetingEndedAt: JUNE(2, 10), checkedOutAt: JUNE(2, 10), host: s.host.userId });
    for (const report of ["appointments", "attendance", "host_meetings"] as const) {
      const out = await s.admin.as.mutation(api.reportsExport.csv, exportArgs(s, { report }));
      expect(out.csv.startsWith("﻿")).toBe(true);
    }
    const hm = await s.admin.as.mutation(api.reportsExport.csv, exportArgs(s, { report: "host_meetings" }));
    expect(hm.rowCount).toBe(1);
    const on = await s.admin.as.mutation(api.reportsExport.csv, { organizationId: s.organizationId, report: "on_site" });
    expect(on.rowCount).toBe(0);
    await expectCode(s.admin.as.mutation(api.reportsExport.csv, { organizationId: s.organizationId, report: "visits" }), "VALIDATION");
  });
});

describe("audit log", () => {
  test("filters by actor, action, resource and date; labels kiosk actors; requires audit:read", async () => {
    const t = newTest();
    const s = await setup(t);
    const deviceId = await t.run(async (ctx) => {
      const gateId = await ctx.db.insert("gates", { organizationId: s.organizationId, siteId: s.siteId, name: "G", type: "pedestrian", status: "active", createdAt: 1, updatedAt: 1 });
      const id = await ctx.db.insert("kioskDevices", { organizationId: s.organizationId, siteId: s.siteId, gateId, name: "Lobby tablet", tokenHash: "h", status: "active", createdBy: s.owner.userId, createdAt: 1 });
      await ctx.db.insert("auditLogs", { organizationId: s.organizationId, kioskDeviceId: id, action: "visit.checked_in", resourceType: "visit", resourceId: "v1", at: 1000 });
      await ctx.db.insert("auditLogs", { organizationId: s.organizationId, actorUserId: s.admin.userId, action: "site.updated", resourceType: "site", resourceId: "x", at: 2000 });
      return id;
    });
    void deviceId;
    const page = (extra: object) =>
      s.owner.as.query(api.audit.list, { organizationId: s.organizationId, paginationOpts: { numItems: 50, cursor: null }, ...extra });
    const kiosk = await page({ action: "visit.checked_in" });
    expect(kiosk.page.map((e) => e.actor)).toEqual([{ kind: "kiosk", name: "Kiosk: Lobby tablet" }]);
    const byActor = await page({ actorUserId: s.admin.userId });
    expect(byActor.page.map((e) => e.action)).toEqual(["site.updated"]);
    const byResource = await page({ resourceType: "visit" });
    expect(byResource.page.every((e) => e.resourceType === "visit")).toBe(true);
    const dated = await page({ fromAt: 1500, toAt: 2500 });
    expect(dated.page.map((e) => e.action)).toEqual(["site.updated"]);
    const combined = await page({ actorUserId: s.admin.userId, action: "visit.checked_in" });
    expect(combined.page).toEqual([]);
    await expectCode(s.reception.as.query(api.audit.list, { organizationId: s.organizationId, paginationOpts: { numItems: 5, cursor: null } }), "FORBIDDEN");
    await expectCode(s.reception.as.query(api.audit.actors, { organizationId: s.organizationId }), "FORBIDDEN");
  });
});
