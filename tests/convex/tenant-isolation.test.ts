import { describe, expect, test } from "vitest";
import { api } from "../../convex/_generated/api";
import { addMember, createOrgWithOwner, expectCode, newTest, signIn } from "./setup";

describe("authentication", () => {
  test("unauthenticated callers are rejected by protected functions", async () => {
    const t = newTest();
    const { organizationId, siteId } = await createOrgWithOwner(t, "Acme", "acme");

    await expectCode(t.query(api.organizations.get, { organizationId }), "UNAUTHENTICATED");
    await expectCode(t.query(api.sites.list, { organizationId }), "UNAUTHENTICATED");
    await expectCode(t.query(api.gates.listBySite, { organizationId, siteId }), "UNAUTHENTICATED");
    await expectCode(t.query(api.dashboard.summary, { organizationId }), "UNAUTHENTICATED");
    await expectCode(
      t.query(api.memberships.list, {
        organizationId,
        paginationOpts: { numItems: 10, cursor: null },
      }),
      "UNAUTHENTICATED",
    );
    await expectCode(
      t.mutation(api.sites.create, { organizationId, name: "Annex", timeZone: "Africa/Nairobi" }),
      "UNAUTHENTICATED",
    );
    await expectCode(
      t.mutation(api.organizations.create, {
        name: "Nope",
        slug: "nope",
        timeZone: "Africa/Nairobi",
        siteName: "HQ",
      }),
      "UNAUTHENTICATED",
    );
  });

  test("an identity without a stored user record has no access", async () => {
    const t = newTest();
    const { organizationId } = await createOrgWithOwner(t, "Acme", "acme");
    const ghost = t.withIdentity({ tokenIdentifier: "test|ghost" });
    await expectCode(ghost.query(api.organizations.get, { organizationId }), "UNAUTHENTICATED");
  });

  test("signed-out users see no organizations", async () => {
    const t = newTest();
    await createOrgWithOwner(t, "Acme", "acme");
    expect(await t.query(api.organizations.mine, {})).toEqual([]);
  });
});

describe("tenant isolation", () => {
  test("a member of organization A cannot read organization B", async () => {
    const t = newTest();
    const a = await createOrgWithOwner(t, "Acme", "acme");
    const b = await createOrgWithOwner(t, "Beta", "beta");

    await expectCode(a.owner.as.query(api.organizations.get, { organizationId: b.organizationId }), "NOT_FOUND");
    await expectCode(a.owner.as.query(api.sites.list, { organizationId: b.organizationId }), "NOT_FOUND");
    await expectCode(a.owner.as.query(api.dashboard.summary, { organizationId: b.organizationId }), "NOT_FOUND");
    await expectCode(
      a.owner.as.query(api.audit.list, {
        organizationId: b.organizationId,
        paginationOpts: { numItems: 10, cursor: null },
      }),
      "NOT_FOUND",
    );

    const mine = await a.owner.as.query(api.organizations.mine, {});
    expect(mine.map((o) => o.slug)).toEqual(["acme"]);
  });

  test("passing another tenant's site id through your own organization is refused", async () => {
    const t = newTest();
    const a = await createOrgWithOwner(t, "Acme", "acme");
    const b = await createOrgWithOwner(t, "Beta", "beta");

    // Own organizationId (membership passes) + foreign siteId must still fail.
    await expectCode(
      a.owner.as.query(api.sites.get, { organizationId: a.organizationId, siteId: b.siteId }),
      "NOT_FOUND",
    );
    await expectCode(
      a.owner.as.query(api.gates.listBySite, { organizationId: a.organizationId, siteId: b.siteId }),
      "NOT_FOUND",
    );
    await expectCode(
      a.owner.as.mutation(api.gates.create, {
        organizationId: a.organizationId,
        siteId: b.siteId,
        name: "Sneaky gate",
        type: "pedestrian",
      }),
      "NOT_FOUND",
    );
    await expectCode(
      a.owner.as.mutation(api.sites.update, {
        organizationId: a.organizationId,
        siteId: b.siteId,
        name: "Hijacked",
        timeZone: "Africa/Nairobi",
        status: "inactive",
      }),
      "NOT_FOUND",
    );
  });

  test("another tenant's gate and membership cannot be modified", async () => {
    const t = newTest();
    const a = await createOrgWithOwner(t, "Acme", "acme");
    const b = await createOrgWithOwner(t, "Beta", "beta");
    const gateId = await b.owner.as.mutation(api.gates.create, {
      organizationId: b.organizationId,
      siteId: b.siteId,
      name: "Main",
      type: "pedestrian",
    });
    const bGuard = await addMember(t, b.organizationId, "beta-guard", "guard");

    await expectCode(
      a.owner.as.mutation(api.gates.update, {
        organizationId: a.organizationId,
        gateId,
        name: "Taken",
        type: "pedestrian",
        status: "inactive",
      }),
      "NOT_FOUND",
    );
    await expectCode(
      a.owner.as.mutation(api.memberships.updateRole, {
        organizationId: a.organizationId,
        membershipId: bGuard.membershipId,
        role: "admin",
      }),
      "NOT_FOUND",
    );
  });

  test("site-restricted members only see their sites", async () => {
    const t = newTest();
    const a = await createOrgWithOwner(t, "Acme", "acme");
    const annexId = await a.owner.as.mutation(api.sites.create, {
      organizationId: a.organizationId,
      name: "Annex",
      timeZone: "Africa/Nairobi",
    });
    const guard = await addMember(t, a.organizationId, "guard", "guard", [annexId]);

    const visible = await guard.as.query(api.sites.list, { organizationId: a.organizationId });
    expect(visible.map((s) => s._id)).toEqual([annexId]);
    await expectCode(
      guard.as.query(api.gates.listBySite, { organizationId: a.organizationId, siteId: a.siteId }),
      "NOT_FOUND",
    );
  });

  test("disabled members and suspended organizations lose access", async () => {
    const t = newTest();
    const a = await createOrgWithOwner(t, "Acme", "acme");
    const host = await addMember(t, a.organizationId, "host", "host");

    await a.owner.as.mutation(api.memberships.setStatus, {
      organizationId: a.organizationId,
      membershipId: host.membershipId,
      status: "disabled",
    });
    await expectCode(host.as.query(api.organizations.get, { organizationId: a.organizationId }), "NOT_FOUND");

    await t.run((ctx) => ctx.db.patch(a.organizationId, { status: "suspended" }));
    await expectCode(a.owner.as.query(api.organizations.get, { organizationId: a.organizationId }), "FORBIDDEN");
  });
});

describe("organization onboarding", () => {
  test("creates owner membership, default site and audit entry", async () => {
    const t = newTest();
    const { owner, organizationId, siteId } = await createOrgWithOwner(t, "Acme", "acme");

    const org = await owner.as.query(api.organizations.get, { organizationId });
    expect(org.membership.role).toBe("owner");
    expect(org.status).toBe("trial");

    const sites = await owner.as.query(api.sites.list, { organizationId });
    expect(sites.map((s) => s._id)).toEqual([siteId]);

    const audit = await owner.as.query(api.audit.list, {
      organizationId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(audit.page.map((e) => e.action)).toContain("organization.created");
  });

  test("rejects duplicate and invalid slugs", async () => {
    const t = newTest();
    await createOrgWithOwner(t, "Acme", "acme");
    const other = await signIn(t, "other");
    const base = { name: "Acme 2", timeZone: "Africa/Nairobi", siteName: "HQ" };
    await expectCode(other.as.mutation(api.organizations.create, { ...base, slug: "acme" }), "CONFLICT");
    await expectCode(other.as.mutation(api.organizations.create, { ...base, slug: "Bad Slug!" }), "VALIDATION");
    await expectCode(other.as.mutation(api.organizations.create, { ...base, slug: "platform" }), "VALIDATION");
    await expectCode(
      other.as.mutation(api.organizations.create, { ...base, slug: "fine-slug", timeZone: "Mars/Base" }),
      "VALIDATION",
    );
  });

  test("public kiosk lookup exposes branding only", async () => {
    const t = newTest();
    await createOrgWithOwner(t, "Acme", "acme");
    const pub = await t.query(api.organizations.getPublicBySlug, { slug: "acme" });
    expect(pub).toEqual({
      name: "Acme",
      slug: "acme",
      branding: { logoUrl: null, primaryColor: null, welcomeText: null, privacyNotice: null },
    });
    expect(await t.query(api.organizations.getPublicBySlug, { slug: "missing" })).toBeNull();
  });
});
