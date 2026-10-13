import { describe, expect, test } from "vitest";
import { api } from "../../convex/_generated/api";
import { KIOSK_RATE_MAX_PER_WINDOW } from "../../convex/lib/kiosk";
import { addMember, createOrgWithOwner, expectCode, newTest, type T } from "./setup";

async function setup(t: T, slug = "acme") {
  const a = await createOrgWithOwner(t, "Acme", slug);
  const gateId = await a.owner.as.mutation(api.gates.create, {
    organizationId: a.organizationId,
    siteId: a.siteId,
    name: "Front",
    type: "pedestrian",
  });
  const { token, deviceId } = await a.owner.as.mutation(api.kioskDevices.issue, {
    organizationId: a.organizationId,
    gateId,
    name: "Tablet",
  });
  return { ...a, gateId, token, deviceId };
}

describe("kiosk device trust", () => {
  test("a valid token and slug returns only site and gate names", async () => {
    const t = newTest();
    const a = await setup(t);
    const ctx = await t.query(api.kiosk.context, { slug: "acme", token: a.token });
    expect(ctx).toEqual({ siteName: "Head Office", gateName: "Front" });
    // Slug matching is case-insensitive like getPublicBySlug.
    await t.query(api.kiosk.context, { slug: "ACME", token: a.token });
  });

  test("the public URL alone (no or bogus token) is rejected", async () => {
    const t = newTest();
    await setup(t);
    await expectCode(t.query(api.kiosk.context, { slug: "acme", token: "" }), "NOT_FOUND");
    await expectCode(t.query(api.kiosk.context, { slug: "acme", token: "wk_nope" }), "NOT_FOUND");
    await expectCode(t.query(api.kiosk.context, { slug: "acme", token: "plain" }), "NOT_FOUND");
    await expectCode(t.mutation(api.kiosk.heartbeat, { slug: "acme", token: "wk_nope" }), "NOT_FOUND");
  });

  test("revoked tokens stop working immediately", async () => {
    const t = newTest();
    const a = await setup(t);
    await a.owner.as.mutation(api.kioskDevices.revoke, { organizationId: a.organizationId, deviceId: a.deviceId });
    await expectCode(t.query(api.kiosk.context, { slug: "acme", token: a.token }), "NOT_FOUND");
    await expectCode(t.mutation(api.kiosk.heartbeat, { slug: "acme", token: a.token }), "NOT_FOUND");
  });

  test("a token only works for its own organization slug; failures look identical", async () => {
    const t = newTest();
    const a = await setup(t, "acme");
    const b = await setup(t, "globex");
    await expectCode(t.query(api.kiosk.context, { slug: "globex", token: a.token }), "NOT_FOUND");
    await expectCode(t.query(api.kiosk.context, { slug: "acme", token: b.token }), "NOT_FOUND");
    const errors = [] as unknown[];
    for (const args of [
      { slug: "globex", token: a.token },
      { slug: "missing", token: a.token },
      { slug: "acme", token: "wk_nope" },
    ]) {
      errors.push(await t.query(api.kiosk.context, args).catch((e) => (e as { data: unknown }).data));
    }
    expect(new Set(errors.map((e) => JSON.stringify(e))).size).toBe(1);
  });

  test("suspended organizations and inactive gates are rejected", async () => {
    const t = newTest();
    const a = await setup(t);
    await t.run((ctx) => ctx.db.patch(a.gateId, { status: "inactive" }));
    await expectCode(t.query(api.kiosk.context, { slug: "acme", token: a.token }), "NOT_FOUND");
    await t.run((ctx) => ctx.db.patch(a.gateId, { status: "active" }));
    await t.query(api.kiosk.context, { slug: "acme", token: a.token });
    await t.run((ctx) => ctx.db.patch(a.organizationId, { status: "suspended" }));
    await expectCode(t.query(api.kiosk.context, { slug: "acme", token: a.token }), "NOT_FOUND");
  });

  test("the token hash is never returned and the plaintext is not stored", async () => {
    const t = newTest();
    const a = await setup(t);
    const list = await a.owner.as.query(api.kioskDevices.listByGate, {
      organizationId: a.organizationId,
      gateId: a.gateId,
    });
    expect(list).toHaveLength(1);
    const json = JSON.stringify(list);
    expect(json).not.toContain("tokenHash");
    expect(json).not.toContain(a.token);
    const stored = await t.run((ctx) => ctx.db.get(a.deviceId));
    expect(stored?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(a.token);
  });

  test("issuing and revoking are audited without the token", async () => {
    const t = newTest();
    const a = await setup(t);
    await a.owner.as.mutation(api.kioskDevices.revoke, { organizationId: a.organizationId, deviceId: a.deviceId });
    const logs = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    const actions = logs.map((l) => l.action);
    expect(actions).toContain("kiosk_device.issued");
    expect(actions).toContain("kiosk_device.revoked");
    expect(JSON.stringify(logs)).not.toContain(a.token);
  });
});

describe("kiosk device administration", () => {
  test("members without sites:manage cannot issue, list or revoke", async () => {
    const t = newTest();
    const a = await setup(t);
    const rec = await addMember(t, a.organizationId, "rec", "receptionist");
    await expectCode(
      rec.as.mutation(api.kioskDevices.issue, { organizationId: a.organizationId, gateId: a.gateId, name: "X" }),
      "FORBIDDEN",
    );
    await expectCode(
      rec.as.query(api.kioskDevices.listByGate, { organizationId: a.organizationId, gateId: a.gateId }),
      "FORBIDDEN",
    );
    await expectCode(
      rec.as.mutation(api.kioskDevices.revoke, { organizationId: a.organizationId, deviceId: a.deviceId }),
      "FORBIDDEN",
    );
  });

  test("cross-tenant: another org's admin cannot touch or see devices", async () => {
    const t = newTest();
    const a = await setup(t, "acme");
    const b = await setup(t, "globex");
    await expectCode(
      b.owner.as.mutation(api.kioskDevices.issue, { organizationId: b.organizationId, gateId: a.gateId, name: "X" }),
      "NOT_FOUND",
    );
    await expectCode(
      b.owner.as.query(api.kioskDevices.listByGate, { organizationId: b.organizationId, gateId: a.gateId }),
      "NOT_FOUND",
    );
    await expectCode(
      b.owner.as.mutation(api.kioskDevices.revoke, { organizationId: b.organizationId, deviceId: a.deviceId }),
      "NOT_FOUND",
    );
    await expectCode(
      b.owner.as.mutation(api.kioskDevices.issue, { organizationId: a.organizationId, gateId: a.gateId, name: "X" }),
      "NOT_FOUND",
    );
    await t.query(api.kiosk.context, { slug: "acme", token: a.token });
  });

  test("device names are validated", async () => {
    const t = newTest();
    const a = await setup(t);
    await expectCode(
      a.owner.as.mutation(api.kioskDevices.issue, { organizationId: a.organizationId, gateId: a.gateId, name: "   " }),
      "VALIDATION",
    );
  });
});

describe("kiosk rate limit", () => {
  test("mutations are limited per device per window; other devices are unaffected", async () => {
    const t = newTest();
    const a = await setup(t);
    const other = await a.owner.as.mutation(api.kioskDevices.issue, {
      organizationId: a.organizationId,
      gateId: a.gateId,
      name: "Second",
    });
    for (let i = 0; i < KIOSK_RATE_MAX_PER_WINDOW; i++) {
      await t.mutation(api.kiosk.heartbeat, { slug: "acme", token: a.token });
    }
    await expectCode(t.mutation(api.kiosk.heartbeat, { slug: "acme", token: a.token }), "RATE_LIMITED");
    await t.mutation(api.kiosk.heartbeat, { slug: "acme", token: other.token });
    // Reads are not counted.
    await t.query(api.kiosk.context, { slug: "acme", token: a.token });
  });

  test("the window resets and lastSeenAt is set once", async () => {
    const t = newTest();
    const a = await setup(t);
    for (let i = 0; i < KIOSK_RATE_MAX_PER_WINDOW; i++) {
      await t.mutation(api.kiosk.heartbeat, { slug: "acme", token: a.token });
    }
    const device = await t.run((ctx) => ctx.db.get(a.deviceId));
    expect(device?.lastSeenAt).toBeTypeOf("number");
    await t.run((ctx) => ctx.db.patch(a.deviceId, { rateWindowStart: Date.now() - 61_000 }));
    await t.mutation(api.kiosk.heartbeat, { slug: "acme", token: a.token });
    const after = await t.run((ctx) => ctx.db.get(a.deviceId));
    expect(after?.rateCount).toBe(1);
    expect(after?.lastSeenAt).toBe(device?.lastSeenAt);
  });
});
