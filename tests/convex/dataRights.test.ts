import { describe, expect, test } from "vitest";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { ERASED_NAME } from "../../convex/dataRights";
import { addMember, createOrgWithOwner, expectCode, newTest, type T } from "./setup";

/** H1: tenant data export and visitor erasure (Kenya DPA access and erasure requests). */

async function seedOrg(t: T, slug: string) {
  const org = await createOrgWithOwner(t, slug, slug);
  const admin = await addMember(t, org.organizationId, `${slug}-admin`, "admin");
  const host = await addMember(t, org.organizationId, `${slug}-host`, "host");
  const data = await t.run(async (ctx) => {
    const now = Date.now();
    const mkVisitor = (name: string, phone: string) =>
      ctx.db.insert("visitors", {
        organizationId: org.organizationId,
        name,
        phone,
        email: `${name.split(" ")[0]!.toLowerCase()}@mail.test`,
        company: "Acme",
        createdAt: now,
        updatedAt: now,
      });
    const jane = await mkVisitor("Jane Visitor", "+254700111222");
    const john = await mkVisitor("John Other", "+254700333444");
    const mkVisit = (visitorId: Id<"visitors">, status: "on_site" | "checked_out", badgeCode: string) =>
      ctx.db.insert("visits", {
        organizationId: org.organizationId,
        siteId: org.siteId,
        visitorId,
        hostUserId: host.userId,
        purpose: "Meet Jane about the secret deal",
        status,
        badgeCode,
        checkedInAt: now - 1000,
        createdAt: now - 1000,
        updatedAt: now,
      });
    const janeVisit = await mkVisit(jane, "checked_out", "111111");
    const johnVisit = await mkVisit(john, "on_site", "222222");
    const appt = await ctx.db.insert("appointments", {
      organizationId: org.organizationId,
      siteId: org.siteId,
      visitorId: jane,
      hostUserId: host.userId,
      purpose: "Discuss Jane's contract",
      scheduledStart: now - 5 * 3600_000,
      scheduledEnd: now - 4 * 3600_000,
      status: "completed",
      decisionNote: "Approved, Jane is a VIP",
      createdBy: host.userId,
      createdAt: now,
      updatedAt: now,
    });
    return { jane, john, janeVisit, johnVisit, appt };
  });
  return { ...org, admin, host, ...data };
}
type Org = Awaited<ReturnType<typeof seedOrg>>;

const exportTable = (o: Org, table: "visitors" | "visits" | "members" | "audit" | "sites", extra: object = {}) =>
  o.owner.as.mutation(api.dataRights.exportChunk, { organizationId: o.organizationId, table, ...extra });

describe("organization data export", () => {
  test("owner exports their own tables, audited; contact details only with the sensitive permission", async () => {
    const t = newTest();
    const a = await seedOrg(t, "acme");
    const b = await seedOrg(t, "globex");
    const visitors = await exportTable(a, "visitors");
    expect(visitors.done).toBe(true);
    const names = (visitors.rows as { name: string }[]).map((r) => r.name).sort();
    expect(names).toEqual(["Jane Visitor", "John Other"]);
    // Owner holds forms:read_sensitive, so contact details are present.
    expect(JSON.stringify(visitors.rows)).toContain("+254700111222");
    // Never another tenant's rows.
    expect(JSON.stringify(visitors.rows)).not.toContain(b.jane);
    const visits = await exportTable(a, "visits");
    expect((visits.rows as { _id: string }[]).map((r) => r._id).sort()).toEqual([a.janeVisit, a.johnVisit].sort());
    // Members: secrets (PIN hashes) live in another table and are never exported.
    const members = await exportTable(a, "members");
    expect(JSON.stringify(members.rows)).not.toMatch(/pinHash|tokenHash|salt/);
    const audit = await a.owner.as.query(api.audit.list, {
      organizationId: a.organizationId,
      paginationOpts: { numItems: 50, cursor: null },
    });
    expect(audit.page.filter((e) => e.action === "organization.data_exported").length).toBe(3);
  });

  test("pages with a cursor and caps the page size", async () => {
    const t = newTest();
    const a = await seedOrg(t, "acme");
    await t.run(async (ctx) => {
      for (let i = 0; i < 130; i++) {
        await ctx.db.insert("visitors", {
          organizationId: a.organizationId,
          name: `Visitor ${i}`,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    });
    const first = await exportTable(a, "visitors", { limit: 100000 });
    expect(first.rows).toHaveLength(100);
    expect(first.done).toBe(false);
    const second = await exportTable(a, "visitors", { cursor: first.nextCursor, limit: 100000 });
    expect(second.rows).toHaveLength(32);
    expect(second.done).toBe(true);
  });

  test("only the owner (organization:manage + reports:export); no other role, nobody signed out", async () => {
    const t = newTest();
    const a = await seedOrg(t, "acme");
    const other = await seedOrg(t, "globex");
    const args = { organizationId: a.organizationId, table: "visitors" as const };
    await expectCode(a.admin.as.mutation(api.dataRights.exportChunk, args), "FORBIDDEN");
    await expectCode(a.host.as.mutation(api.dataRights.exportChunk, args), "FORBIDDEN");
    // Another tenant's owner cannot read this organization at all.
    await expectCode(other.owner.as.mutation(api.dataRights.exportChunk, args), "NOT_FOUND");
    await expect(t.mutation(api.dataRights.exportChunk, args)).rejects.toThrow();
  });
});

describe("visitor erasure", () => {
  test("anonymises the person everywhere, leaves others alone, and is audited without personal data", async () => {
    const t = newTest();
    const a = await seedOrg(t, "acme");
    const res = await a.owner.as.mutation(api.dataRights.eraseVisitor, {
      organizationId: a.organizationId,
      visitorId: a.jane,
    });
    expect(res).toMatchObject({ done: true, visits: 1, appointments: 1 });
    const { jane, john, visit, appt, audit } = await t.run(async (ctx) => ({
      jane: await ctx.db.get(a.jane),
      john: await ctx.db.get(a.john),
      visit: await ctx.db.get(a.janeVisit),
      appt: await ctx.db.get(a.appt),
      audit: (await ctx.db.query("auditLogs").collect()).filter((e) => e.action === "visitor.erased"),
    }));
    expect(jane?.name).toBe(ERASED_NAME);
    expect([jane?.phone, jane?.email, jane?.company]).toEqual([undefined, undefined, undefined]);
    expect(jane?.anonymisedAt).toBeTypeOf("number");
    expect(visit?.badgeCode).toBeUndefined();
    expect(visit?.purpose).toBe("Erased on request");
    expect(appt?.purpose).toBe("Erased on request");
    expect(appt?.decisionNote).toBeUndefined();
    expect(john?.name).toBe("John Other");
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toMatch(/Jane|254700/);
    // Idempotent.
    expect(
      await a.owner.as.mutation(api.dataRights.eraseVisitor, { organizationId: a.organizationId, visitorId: a.jane }),
    ).toMatchObject({ done: true, visits: 0 });
  });

  test("refuses while the person is on site; foreign visitors are NOT_FOUND; admins are forbidden", async () => {
    const t = newTest();
    const a = await seedOrg(t, "acme");
    const b = await seedOrg(t, "globex");
    await expectCode(
      a.owner.as.mutation(api.dataRights.eraseVisitor, { organizationId: a.organizationId, visitorId: a.john }),
      "CONFLICT",
    );
    await expectCode(
      a.owner.as.mutation(api.dataRights.eraseVisitor, { organizationId: a.organizationId, visitorId: b.jane }),
      "NOT_FOUND",
    );
    await expectCode(
      a.admin.as.mutation(api.dataRights.eraseVisitor, { organizationId: a.organizationId, visitorId: a.jane }),
      "FORBIDDEN",
    );
    expect((await t.run((ctx) => ctx.db.get(b.jane)))?.name).toBe("Jane Visitor");
  });

  test("redacts form answers and schedules their files for deletion", async () => {
    const t = newTest();
    const a = await seedOrg(t, "acme");
    const { responseId, fileId } = await t.run(async (ctx) => {
      const now = Date.now();
      const formId = await ctx.db.insert("forms", {
        organizationId: a.organizationId,
        name: "Visitor form",
        audience: "visitor",
        status: "published",
        draftFields: [],
        createdBy: a.owner.userId,
        createdAt: now,
        updatedAt: now,
      } as never);
      const formVersionId = await ctx.db.insert("formVersions", {
        organizationId: a.organizationId,
        formId,
        version: 1,
        name: "Visitor form",
        audience: "visitor",
        fields: [],
        publishedBy: a.owner.userId,
        publishedAt: now,
      } as never);
      const fileId = await ctx.db.insert("files", {
        organizationId: a.organizationId,
        kind: "id_scan",
        contentType: "image/png",
        size: 10,
        status: "attached",
        verifyStatus: "verified",
        deleteAfter: now + 90 * 86400_000,
        createdAt: now,
      } as never);
      const responseId = await ctx.db.insert("formResponses", {
        organizationId: a.organizationId,
        formId,
        formVersionId,
        visitId: a.janeVisit,
        answers: { name: "Jane Visitor", id: { fileId }, ok: true },
        createdAt: now,
      });
      return { responseId, fileId };
    });
    const before = Date.now();
    await a.owner.as.mutation(api.dataRights.eraseVisitor, { organizationId: a.organizationId, visitorId: a.jane });
    const { response, file } = await t.run(async (ctx) => ({ response: await ctx.db.get(responseId), file: await ctx.db.get(fileId) }));
    expect(response?.answers).toEqual({ name: { redacted: true }, id: { redacted: true }, ok: { redacted: true } });
    expect(file?.deleteAfter).toBeLessThanOrEqual(Date.now());
    expect(file?.deleteAfter).toBeGreaterThanOrEqual(before - 1000);
  });
});

describe("page size caps on authenticated lists", () => {
  test("audit.list never returns more than 100 rows however many are requested", async () => {
    const t = newTest();
    const a = await seedOrg(t, "acme");
    await t.run(async (ctx) => {
      for (let i = 0; i < 150; i++) {
        await ctx.db.insert("auditLogs", {
          organizationId: a.organizationId,
          actorUserId: a.owner.userId,
          action: "test.noise",
          resourceType: "test",
          resourceId: String(i),
          at: Date.now() + i,
        });
      }
    });
    const page = await a.owner.as.query(api.audit.list, {
      organizationId: a.organizationId,
      paginationOpts: { numItems: 5000, cursor: null },
    });
    expect(page.page.length).toBe(100);
    const members = await a.owner.as.query(api.memberships.list, {
      organizationId: a.organizationId,
      paginationOpts: { numItems: 1_000_000, cursor: null },
    });
    expect(members.page.length).toBeLessThanOrEqual(100);
  });
});
