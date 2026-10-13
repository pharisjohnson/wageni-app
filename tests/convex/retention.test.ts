import { describe, expect, test } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { addMember, createOrgWithOwner, expectCode, newTest, type T } from "./setup";

const DAY = 24 * 60 * 60 * 1000;

async function setup(t: T, slug = "acme") {
  const a = await createOrgWithOwner(t, "Acme", slug);
  const admin = await addMember(t, a.organizationId, `${slug}-admin`, "admin");
  const reception = await addMember(t, a.organizationId, `${slug}-recep`, "receptionist");
  return { ...a, admin, reception };
}
type S = Awaited<ReturnType<typeof setup>>;

async function visit(t: T, s: S, o: { daysAgo: number; name: string; status?: "checked_out" | "on_site"; visitorId?: Id<"visitors">; phone?: string }) {
  return await t.run(async (ctx) => {
    const at = Date.now() - o.daysAgo * DAY;
    const visitorId =
      o.visitorId ??
      (await ctx.db.insert("visitors", {
        organizationId: s.organizationId,
        name: o.name,
        phone: o.phone ?? "+254700000001",
        email: `${o.name}@example.com`,
        company: "Co",
        createdAt: at,
        updatedAt: at,
      }));
    const visitId = await ctx.db.insert("visits", {
      organizationId: s.organizationId,
      siteId: s.siteId,
      visitorId,
      purpose: "Meeting",
      status: o.status ?? "checked_out",
      badgeCode: "123456",
      checkedInAt: at,
      checkedOutAt: o.status === "on_site" ? undefined : at + 3_600_000,
      createdAt: at,
      updatedAt: at,
    });
    return { visitId, visitorId };
  });
}

const purge = (t: T, s: S, dryRun: boolean, extra: { batchSize?: number } = {}) =>
  t.mutation(internal.retention.purgeExpired, { organizationId: s.organizationId, dryRun, ...extra });

describe("retention settings", () => {
  test("defaults, update, minimums, permission, audit", async () => {
    const t = newTest();
    const s = await setup(t);
    const initial = await s.owner.as.query(api.retention.get, { organizationId: s.organizationId });
    expect(initial.retention).toEqual({ visitRecordsDays: 365, auditLogDays: 730, attendanceDays: 2555 });
    expect(initial.minimums.auditLogDays).toBe(365);

    const ok = { visitRecordsDays: 90, auditLogDays: 400, attendanceDays: 1000 };
    await s.admin.as.mutation(api.retention.update, { organizationId: s.organizationId, retention: ok });
    expect((await s.owner.as.query(api.retention.get, { organizationId: s.organizationId })).retention).toEqual(ok);

    for (const bad of [
      { ...ok, auditLogDays: 364 },
      { ...ok, attendanceDays: 30 },
      { ...ok, visitRecordsDays: 29 },
      { ...ok, visitRecordsDays: 20_000 },
      { ...ok, auditLogDays: 400.5 },
    ]) {
      await expectCode(s.owner.as.mutation(api.retention.update, { organizationId: s.organizationId, retention: bad }), "VALIDATION");
    }
    await expectCode(s.reception.as.mutation(api.retention.update, { organizationId: s.organizationId, retention: ok }), "FORBIDDEN");
    await expectCode(s.reception.as.query(api.retention.get, { organizationId: s.organizationId }), "FORBIDDEN");

    const log = await s.owner.as.query(api.audit.list, {
      organizationId: s.organizationId,
      paginationOpts: { numItems: 10, cursor: null },
      action: "organization.retention_updated",
    });
    expect(log.page).toHaveLength(1);
  });
});

describe("retention.purgeExpired", () => {
  async function seed(t: T, s: S) {
    await visit(t, s, { daysAgo: 400, name: "Old" });
    const shared = await visit(t, s, { daysAgo: 400, name: "Shared", phone: "+254711111111" });
    await visit(t, s, { daysAgo: 10, name: "Shared", visitorId: shared.visitorId }); // keeps the visitor alive
    await visit(t, s, { daysAgo: 5, name: "Recent", phone: "+254722222222" });
    await visit(t, s, { daysAgo: 900, name: "StuckOnSite", status: "on_site", phone: "+254733333333" });
    await t.run(async (ctx) => {
      const old = Date.now() - 800 * DAY;
      await ctx.db.insert("auditLogs", { organizationId: s.organizationId, action: "old.thing", resourceType: "x", resourceId: "1", at: old });
      const gateless = Date.now() - 4000 * DAY;
      const ev = (at: number) =>
        ctx.db.insert("attendanceEvents", { organizationId: s.organizationId, siteId: s.siteId, userId: s.admin.userId, type: "clock_in", at, source: "app", createdAt: at });
      await ev(gateless);
      await ev(Date.now() - DAY);
      await ctx.db.insert("attendanceCorrections", {
        organizationId: s.organizationId,
        siteId: s.siteId,
        userId: s.admin.userId,
        requestedBy: s.admin.userId,
        proposedType: "clock_out",
        proposedAt: gateless,
        reason: "r",
        status: "approved",
        createdAt: gateless,
      });
      await ctx.db.insert("attendanceCorrections", {
        organizationId: s.organizationId,
        siteId: s.siteId,
        userId: s.admin.userId,
        requestedBy: s.admin.userId,
        proposedType: "clock_out",
        proposedAt: gateless,
        reason: "still pending",
        status: "pending",
        createdAt: gateless,
      });
    });
  }

  const snapshot = (t: T, s: S) =>
    t.run(async (ctx) => ({
      visitors: await ctx.db.query("visitors").collect(),
      visits: await ctx.db.query("visits").collect(),
      audits: (await ctx.db.query("auditLogs").collect()).filter((a) => a.organizationId === s.organizationId).length,
      events: (await ctx.db.query("attendanceEvents").collect()).length,
      corrections: (await ctx.db.query("attendanceCorrections").collect()).length,
    }));

  test("dry run reports counts and changes nothing", async () => {
    const t = newTest();
    const s = await setup(t);
    await seed(t, s);
    const before = await snapshot(t, s);
    const res = await purge(t, s, true);
    expect(res.dryRun).toBe(true);
    expect(res.counts).toEqual({ visits: 2, visitors: 1, auditLogs: 1, attendanceEvents: 1, attendanceCorrections: 1 });
    expect(await snapshot(t, s)).toEqual(before);
  });

  test("execute anonymises old visits, keeps counts, deletes expired audit/attendance, spares the rest", async () => {
    const t = newTest();
    const s = await setup(t);
    await seed(t, s);
    const res = await purge(t, s, false);
    expect(res.counts).toEqual({ visits: 2, visitors: 1, auditLogs: 1, attendanceEvents: 1, attendanceCorrections: 1 });
    expect(res.hasMore).toBe(false);

    const after = await snapshot(t, s);
    expect(after.visits).toHaveLength(5); // never deleted: report counts survive
    const byName = new Map(after.visitors.map((v) => [v.name, v]));
    expect(byName.has("Old")).toBe(false);
    const anonymised = after.visitors.filter((v) => v.anonymisedAt !== undefined);
    expect(anonymised).toHaveLength(1);
    expect(anonymised[0]?.name).toBe("Anonymised visitor");
    expect([anonymised[0]?.phone, anonymised[0]?.email, anonymised[0]?.company]).toEqual([undefined, undefined, undefined]);
    // Shared visitor (still has a recent visit), recent visitor and the on-site visitor are untouched.
    expect(byName.get("Shared")?.phone).toBe("+254711111111");
    expect(byName.get("Recent")?.phone).toBe("+254722222222");
    expect(byName.get("StuckOnSite")?.phone).toBe("+254733333333");
    const oldVisits = after.visits.filter((v) => v.anonymisedAt !== undefined);
    expect(oldVisits).toHaveLength(2);
    expect(oldVisits.every((v) => v.badgeCode === undefined)).toBe(true);
    expect(after.visits.filter((v) => v.status === "on_site")[0]?.badgeCode).toBe("123456");
    // The old audit entry is gone; the purge is itself audited (plus the setup entries).
    const log = await s.owner.as.query(api.audit.list, {
      organizationId: s.organizationId,
      paginationOpts: { numItems: 50, cursor: null },
    });
    expect(log.page.some((e) => e.action === "old.thing")).toBe(false);
    const purged = log.page.find((e) => e.action === "retention.purged");
    expect(purged?.actor.kind).toBe("system");
    expect(purged?.metadata).toMatchObject({ visits: 2, auditLogs: 1 });
    expect(after.events).toBe(1);
    expect(after.corrections).toBe(1); // the pending one

    // Idempotent: running again finds nothing.
    const again = await purge(t, s, false);
    expect(Object.values(again.counts).every((n) => n === 0)).toBe(true);
  });

  test("minimums are enforced at purge time even if a shorter value is stored", async () => {
    const t = newTest();
    const s = await setup(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(s.organizationId, { retention: { visitRecordsDays: 1, auditLogDays: 1, attendanceDays: 1 } });
      const at = Date.now() - 100 * DAY;
      await ctx.db.insert("auditLogs", { organizationId: s.organizationId, action: "recent.enough", resourceType: "x", resourceId: "1", at });
      await ctx.db.insert("attendanceEvents", { organizationId: s.organizationId, siteId: s.siteId, userId: s.admin.userId, type: "clock_in", at, source: "app", createdAt: at });
    });
    await visit(t, s, { daysAgo: 20, name: "TwentyDays" }); // inside the 30-day floor
    await visit(t, s, { daysAgo: 40, name: "FortyDays" }); // past it
    const res = await purge(t, s, false);
    expect(res.counts).toMatchObject({ visits: 1, auditLogs: 0, attendanceEvents: 0 });
    const names = await t.run(async (ctx) => (await ctx.db.query("visitors").collect()).map((v) => v.name).sort());
    expect(names).toEqual(["Anonymised visitor", "TwentyDays"]);
  });

  test("custom longer periods are honoured", async () => {
    const t = newTest();
    const s = await setup(t);
    await s.owner.as.mutation(api.retention.update, {
      organizationId: s.organizationId,
      retention: { visitRecordsDays: 1000, auditLogDays: 1000, attendanceDays: 3650 },
    });
    await seed(t, s);
    const res = await purge(t, s, true);
    expect(res.counts).toEqual({ visits: 0, visitors: 0, auditLogs: 0, attendanceEvents: 1, attendanceCorrections: 1 }); // only the 4000-day-old attendance is past even the 10-year cap
  });

  test("batches are bounded and hasMore says so", async () => {
    const t = newTest();
    const s = await setup(t);
    for (let i = 0; i < 3; i++) await visit(t, s, { daysAgo: 400 + i, name: `V${i}`, phone: `+25470000010${i}` });
    const dry = await purge(t, s, true, { batchSize: 2 });
    expect(dry.counts.visits).toBe(2);
    expect(dry.hasMore).toBe(true);
    const all = await purge(t, s, true, { batchSize: 10 });
    expect(all.counts.visits).toBe(3);
    expect(all.hasMore).toBe(false);
  });

  test("never touches another organization", async () => {
    const t = newTest();
    const a = await setup(t, "acme");
    const b = await setup(t, "beta");
    await visit(t, a, { daysAgo: 400, name: "AcmeOld" });
    await visit(t, b, { daysAgo: 400, name: "BetaOld", phone: "+254799999999" });
    await purge(t, a, false);
    const names = await t.run(async (ctx) => (await ctx.db.query("visitors").collect()).map((v) => v.name).sort());
    expect(names).toEqual(["Anonymised visitor", "BetaOld"]);
  });

  test("preview matches a dry run and needs settings:manage", async () => {
    const t = newTest();
    const s = await setup(t);
    await visit(t, s, { daysAgo: 400, name: "Old" });
    const p = await s.owner.as.query(api.retention.preview, { organizationId: s.organizationId });
    expect(p.counts.visits).toBe(1);
    await expectCode(s.reception.as.query(api.retention.preview, { organizationId: s.organizationId }), "FORBIDDEN");
  });
});
