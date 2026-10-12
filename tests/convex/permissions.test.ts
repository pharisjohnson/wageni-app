import { describe, expect, test } from "vitest";
import { api } from "../../convex/_generated/api";
import { addMember, createOrgWithOwner, expectCode, newTest, signIn } from "./setup";

const page = { numItems: 50, cursor: null };

describe("role boundaries", () => {
  test("receptionists cannot manage members, sites or branding", async () => {
    const t = newTest();
    const a = await createOrgWithOwner(t, "Acme", "acme");
    const rec = await addMember(t, a.organizationId, "rec", "receptionist");
    const guard = await addMember(t, a.organizationId, "guard", "guard");
    const orgId = a.organizationId;

    await expectCode(
      rec.as.mutation(api.memberships.updateRole, { organizationId: orgId, membershipId: guard.membershipId, role: "staff" }),
      "FORBIDDEN",
    );
    await expectCode(
      rec.as.mutation(api.sites.create, { organizationId: orgId, name: "Annex", timeZone: "Africa/Nairobi" }),
      "FORBIDDEN",
    );
    await expectCode(
      rec.as.mutation(api.organizations.updateBranding, { organizationId: orgId, branding: { welcomeText: "Hi" } }),
      "FORBIDDEN",
    );
    await expectCode(rec.as.query(api.audit.list, { organizationId: orgId, paginationOpts: page }), "FORBIDDEN");

    const org = await rec.as.query(api.organizations.get, { organizationId: orgId });
    expect(org.membership.permissions).not.toContain("billing:manage");
    expect(org.membership.permissions).not.toContain("members:manage");
    expect(org.membership.permissions).not.toContain("forms:manage");
    expect(org.membership.permissions).not.toContain("appointments:approve");
  });

  test("guards cannot book appointments by default", async () => {
    const t = newTest();
    const a = await createOrgWithOwner(t, "Acme", "acme");
    const guard = await addMember(t, a.organizationId, "guard", "guard");
    const org = await guard.as.query(api.organizations.get, { organizationId: a.organizationId });
    expect(org.membership.permissions).not.toContain("appointments:create");
    expect(org.membership.permissions).toContain("visits:check_in");
  });

  test("hosts and staff cannot read the member directory", async () => {
    const t = newTest();
    const a = await createOrgWithOwner(t, "Acme", "acme");
    const host = await addMember(t, a.organizationId, "host", "host");
    const staff = await addMember(t, a.organizationId, "staff", "staff");
    for (const m of [host, staff]) {
      await expectCode(m.as.query(api.memberships.list, { organizationId: a.organizationId, paginationOpts: page }), "FORBIDDEN");
    }
  });

  test("dashboard only returns figures the caller may see", async () => {
    const t = newTest();
    const a = await createOrgWithOwner(t, "Acme", "acme");
    const staff = await addMember(t, a.organizationId, "staff", "staff");
    expect(await staff.as.query(api.dashboard.summary, { organizationId: a.organizationId })).toEqual({
      sites: null,
      gates: null,
      members: null,
      capped: false,
    });
    const owner = await a.owner.as.query(api.dashboard.summary, { organizationId: a.organizationId });
    expect(owner).toMatchObject({ sites: 1, gates: 0, members: 2 });
  });
});

describe("privilege escalation", () => {
  test("nobody can modify their own membership", async () => {
    const t = newTest();
    const a = await createOrgWithOwner(t, "Acme", "acme");
    const admin = await addMember(t, a.organizationId, "admin", "admin");
    await expectCode(
      admin.as.mutation(api.memberships.updateRole, { organizationId: a.organizationId, membershipId: admin.membershipId, role: "owner" }),
      "FORBIDDEN",
    );
    await expectCode(
      admin.as.mutation(api.memberships.setOverrides, {
        organizationId: a.organizationId,
        membershipId: admin.membershipId,
        overrides: { grant: ["billing:manage"], revoke: [] },
      }),
      "FORBIDDEN",
    );
  });

  test("admins cannot create owners, edit owners/admins, or grant permissions they lack", async () => {
    const t = newTest();
    const a = await createOrgWithOwner(t, "Acme", "acme");
    const orgId = a.organizationId;
    const admin = await addMember(t, orgId, "admin", "admin");
    const admin2 = await addMember(t, orgId, "admin2", "admin");
    const rec = await addMember(t, orgId, "rec", "receptionist");
    const ownerMembership = await t.run((ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q) => q.eq("organizationId", orgId).eq("userId", a.owner.userId))
        .unique(),
    );

    await expectCode(
      admin.as.mutation(api.memberships.updateRole, { organizationId: orgId, membershipId: rec.membershipId, role: "owner" }),
      "FORBIDDEN",
    );
    await expectCode(
      admin.as.mutation(api.memberships.updateRole, { organizationId: orgId, membershipId: rec.membershipId, role: "admin" }),
      "FORBIDDEN",
    );
    await expectCode(
      admin.as.mutation(api.memberships.setStatus, { organizationId: orgId, membershipId: ownerMembership!._id, status: "disabled" }),
      "FORBIDDEN",
    );
    await expectCode(
      admin.as.mutation(api.memberships.setStatus, { organizationId: orgId, membershipId: admin2.membershipId, status: "disabled" }),
      "FORBIDDEN",
    );
    await expectCode(
      admin.as.mutation(api.memberships.setOverrides, {
        organizationId: orgId,
        membershipId: rec.membershipId,
        overrides: { grant: ["billing:manage"], revoke: [] },
      }),
      "FORBIDDEN",
    );

    // Allowed: an admin may adjust a receptionist within their own permissions.
    await admin.as.mutation(api.memberships.setOverrides, {
      organizationId: orgId,
      membershipId: rec.membershipId,
      overrides: { grant: ["appointments:approve", "visits:check_in"], revoke: [] },
    });
    const recOrg = await rec.as.query(api.organizations.get, { organizationId: orgId });
    expect(recOrg.membership.permissions).toContain("appointments:approve");

    const audit = await a.owner.as.query(api.audit.list, { organizationId: orgId, paginationOpts: page });
    expect(audit.page.map((e) => e.action)).toContain("membership.overrides_changed");
  });

  test("site-restricted admins cannot grant access to all sites", async () => {
    const t = newTest();
    const a = await createOrgWithOwner(t, "Acme", "acme");
    const admin = await addMember(t, a.organizationId, "admin", "admin", [a.siteId]);
    const guard = await addMember(t, a.organizationId, "guard", "guard", [a.siteId]);
    await expectCode(
      admin.as.mutation(api.memberships.setSiteAccess, {
        organizationId: a.organizationId,
        membershipId: guard.membershipId,
        siteAccess: "all",
      }),
      "FORBIDDEN",
    );
  });

  test("revoked permissions take effect immediately", async () => {
    const t = newTest();
    const a = await createOrgWithOwner(t, "Acme", "acme");
    const admin = await addMember(t, a.organizationId, "admin", "admin");
    await a.owner.as.mutation(api.memberships.setOverrides, {
      organizationId: a.organizationId,
      membershipId: admin.membershipId,
      overrides: { grant: [], revoke: ["sites:manage"] },
    });
    await expectCode(
      admin.as.mutation(api.sites.create, { organizationId: a.organizationId, name: "Annex", timeZone: "Africa/Nairobi" }),
      "FORBIDDEN",
    );
  });
});

describe("platform boundary", () => {
  test("organization owners cannot call platform functions", async () => {
    const t = newTest();
    const a = await createOrgWithOwner(t, "Acme", "acme");
    await expectCode(a.owner.as.query(api.platform.listOrganizations, { paginationOpts: page }), "FORBIDDEN");
    await expectCode(
      a.owner.as.mutation(api.platform.setOrganizationStatus, {
        organizationId: a.organizationId,
        status: "active",
        reason: "self-upgrade",
      }),
      "FORBIDDEN",
    );
  });

  test("platform admins see org metadata but not tenant data without membership", async () => {
    const t = newTest();
    const a = await createOrgWithOwner(t, "Acme", "acme");
    const ops = await signIn(t, "ops");
    await t.run((ctx) => ctx.db.patch(ops.userId, { platformRole: "super_admin" }));

    const orgs = await ops.as.query(api.platform.listOrganizations, { paginationOpts: page });
    expect(orgs.page[0]).toEqual({
      _id: a.organizationId,
      name: "Acme",
      slug: "acme",
      status: "trial",
      isDemo: false,
      createdAt: expect.any(Number),
    });
    await expectCode(ops.as.query(api.sites.list, { organizationId: a.organizationId }), "NOT_FOUND");
    await expectCode(
      ops.as.query(api.memberships.list, { organizationId: a.organizationId, paginationOpts: page }),
      "NOT_FOUND",
    );
  });

  test("platform status changes require a reason and are audited", async () => {
    const t = newTest();
    const a = await createOrgWithOwner(t, "Acme", "acme");
    const ops = await addMember(t, a.organizationId, "ops", "staff");
    await t.run((ctx) => ctx.db.patch(ops.userId, { platformRole: "super_admin" }));

    await expectCode(
      ops.as.mutation(api.platform.setOrganizationStatus, { organizationId: a.organizationId, status: "suspended", reason: "" }),
      "VALIDATION",
    );
    await ops.as.mutation(api.platform.setOrganizationStatus, {
      organizationId: a.organizationId,
      status: "suspended",
      reason: "Unpaid invoice",
    });
    const logs = await t.run((ctx) =>
      ctx.db.query("auditLogs").withIndex("by_org_at", (q) => q.eq("organizationId", a.organizationId)).collect(),
    );
    expect(logs.map((l) => l.action)).toContain("platform.organization_status_changed");
  });
});
