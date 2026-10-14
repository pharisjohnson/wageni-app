import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import { IP_LIMITS } from "../../convex/invitations";
import { secretsMatch } from "../../convex/lib/proxy";
import { formsSetup, type FormsSetup } from "./formsSetup";
import { expectCode, newTest } from "./setup";

const HOUR = 60 * 60 * 1000;
const SECRET = "proxy-secret-0123456789abcdef";
const IP_A = "a".repeat(64);
const IP_B = "b".repeat(64);
const proxy = (ipHash = IP_A, proxySecret = SECRET) => ({ proxySecret, ipHash });
const DETAILS = { name: "Ivy Invitee", phone: "+254722333444" };

beforeEach(() => {
  process.env.INVITE_PROXY_SECRET = SECRET;
  delete process.env.ALLOW_UNPROXIED_INVITES;
  delete process.env.APP_BASE_URL;
  delete process.env.ALLOW_LOCAL_ORIGIN;
});
afterEach(() => {
  delete process.env.INVITE_PROXY_SECRET;
  delete process.env.ALLOW_UNPROXIED_INVITES;
  delete process.env.APP_BASE_URL;
  delete process.env.ALLOW_LOCAL_ORIGIN;
  vi.useRealTimers();
});

async function invite(s: FormsSetup, over: object = {}) {
  return await s.reception.as.mutation(api.invitations.create, {
    ...s.orgArg,
    siteId: s.siteId,
    hostUserId: s.host.userId,
    purpose: "Project kickoff",
    scheduledStart: Date.now() + 60_000,
    scheduledEnd: Date.now() + HOUR,
    ...over,
  });
}

describe("constant-time secret comparison", () => {
  test("equal strings match; any difference does not, whatever the length", async () => {
    expect(await secretsMatch("abc", "abc")).toBe(true);
    expect(await secretsMatch("abc", "abd")).toBe(false);
    expect(await secretsMatch("abc", "abcd")).toBe(false);
    expect(await secretsMatch("", "abc")).toBe(false);
    expect(await secretsMatch("", "")).toBe(true);
    expect(await secretsMatch(SECRET, SECRET.toUpperCase())).toBe(false);
  });
});

describe("direct (unproxied) calls are refused", () => {
  async function allFour(t: ReturnType<typeof newTest>, token: string, args: object) {
    const storageId = await t.run(async (ctx) => ctx.storage.store(new Blob(["x"])));
    return [
      () => t.mutation(api.invitations.lookup, { token, ...args } as never),
      () => t.mutation(api.invitations.generateUploadUrl, { token, kind: "photo", ...args } as never),
      () => t.mutation(api.invitations.registerUploaded, { token, storageId, kind: "photo", ...args } as never),
      () => t.mutation(api.invitations.submit, { token, details: DETAILS, answers: {}, ...args } as never),
    ];
  }

  test("a wrong, empty or malformed secret gets FORBIDDEN from every public function and changes nothing", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const { token } = await invite(s);
    for (const args of [
      { proxySecret: "wrong-secret-0123456789", ipHash: IP_A },
      { proxySecret: "", ipHash: IP_A },
      { proxySecret: SECRET, ipHash: "not-a-hash" },
      { proxySecret: SECRET, ipHash: IP_A.toUpperCase() },
    ]) {
      for (const call of await allFour(t, token, args)) await expectCode(call(), "FORBIDDEN");
    }
    // Nothing happened: the invitation is still open and no counters or uploads were created.
    expect((await t.run(async (ctx) => ctx.db.query("invitations").collect()))[0]).toMatchObject({ status: "pending" });
    expect(await t.run(async (ctx) => ctx.db.query("publicRateLimits").collect())).toHaveLength(0);
    expect(await t.run(async (ctx) => ctx.db.query("uploadIntents").collect())).toHaveLength(0);
  });

  test("the functions no longer exist without the secret argument at all", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const { token } = await invite(s);
    await expect(t.mutation(api.invitations.lookup, { token } as never)).rejects.toThrow();
    await expect(t.mutation(api.invitations.submit, { token, details: DETAILS, answers: {} } as never)).rejects.toThrow();
  });

  test("with the right secret the call works", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const { token } = await invite(s);
    expect(await t.mutation(api.invitations.lookup, { ...proxy(), token })).toMatchObject({ status: "ok" });
  });

  test("fails closed when no secret is configured", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const { token } = await invite(s);
    delete process.env.INVITE_PROXY_SECRET;
    await expectCode(t.mutation(api.invitations.lookup, { ...proxy(), token }), "FORBIDDEN");
    // An empty value counts as unset, and so does a guessable short one.
    process.env.INVITE_PROXY_SECRET = "";
    await expectCode(t.mutation(api.invitations.lookup, { ...proxy("", ""), token }), "FORBIDDEN");
    process.env.INVITE_PROXY_SECRET = "short";
    await expectCode(t.mutation(api.invitations.lookup, { ...proxy(IP_A, "short"), token }), "FORBIDDEN");
  });

  test("development flag: without a secret, calls work and share one counter", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const { token } = await invite(s);
    delete process.env.INVITE_PROXY_SECRET;
    process.env.ALLOW_UNPROXIED_INVITES = "true";
    expect(await t.mutation(api.invitations.lookup, { proxySecret: "", ipHash: "dev", token })).toMatchObject({ status: "ok" });
    const rows = await t.run(async (ctx) => ctx.db.query("publicRateLimits").collect());
    expect(rows.map((r) => r.key)).toContain("ip:invite_lookup:dev");
    // With a secret configured the flag does not weaken anything.
    process.env.INVITE_PROXY_SECRET = SECRET;
    await expectCode(t.mutation(api.invitations.lookup, { proxySecret: "", ipHash: "dev", token }), "FORBIDDEN");
  });
});

describe("per-IP limits", () => {
  test("lookups: one client is cut off at its budget while another is unaffected", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const { token } = await invite(s);
    for (let i = 0; i < IP_LIMITS.lookup.max; i++) {
      expect((await t.mutation(api.invitations.lookup, { ...proxy(IP_A), token })).status).toBe("ok");
    }
    await expectCode(t.mutation(api.invitations.lookup, { ...proxy(IP_A), token }), "RATE_LIMITED");
    // A guessing client does not get more tries by using bad tokens.
    await expectCode(t.mutation(api.invitations.lookup, { ...proxy(IP_A), token: "wi_nope" }), "RATE_LIMITED");
    expect((await t.mutation(api.invitations.lookup, { ...proxy(IP_B), token })).status).toBe("ok");
  });

  test("the budget refills after its window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-02T10:00:00Z"));
    const t = newTest();
    const s = await formsSetup(t);
    const { token } = await invite(s, { scheduledStart: Date.now() + 60_000, scheduledEnd: Date.now() + 3 * HOUR });
    for (let i = 0; i < IP_LIMITS.lookup.max; i++) await t.mutation(api.invitations.lookup, { ...proxy(IP_A), token });
    await expectCode(t.mutation(api.invitations.lookup, { ...proxy(IP_A), token }), "RATE_LIMITED");
    vi.setSystemTime(Date.now() + IP_LIMITS.lookup.windowMs + 1);
    expect((await t.mutation(api.invitations.lookup, { ...proxy(IP_A), token })).status).toBe("ok");
  });

  test("submissions and uploads have their own budgets per client", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    // Bad-token submits are cheap, so they exhaust the budget quickly.
    for (let i = 0; i < IP_LIMITS.submit.max; i++) {
      expect(await t.mutation(api.invitations.submit, { ...proxy(IP_A), token: "wi_nope", details: DETAILS, answers: {} })).toEqual({
        status: "unavailable",
      });
    }
    await expectCode(
      t.mutation(api.invitations.submit, { ...proxy(IP_A), token: "wi_nope", details: DETAILS, answers: {} }),
      "RATE_LIMITED",
    );
    // The submit budget is separate from the lookup budget and from other clients.
    expect(await t.mutation(api.invitations.lookup, { ...proxy(IP_A), token: "wi_nope" })).toEqual({ status: "unavailable" });
    expect(
      await t.mutation(api.invitations.submit, { ...proxy(IP_B), token: "wi_nope", details: DETAILS, answers: {} }),
    ).toEqual({ status: "unavailable" });

    const { token } = await invite(s);
    for (let i = 0; i < IP_LIMITS.upload.max; i++) {
      await t.mutation(api.invitations.registerUploaded, {
        ...proxy(IP_B),
        token: "wi_nope",
        storageId: await t.run(async (ctx) => ctx.storage.store(new Blob(["x"]))),
        kind: "photo",
      });
    }
    await expectCode(t.mutation(api.invitations.generateUploadUrl, { ...proxy(IP_B), token, kind: "photo" }), "RATE_LIMITED");
    expect((await t.mutation(api.invitations.generateUploadUrl, { ...proxy(IP_A), token, kind: "photo" })).status).toBe("ok");
  });

  test("an invitation upload URL records an intent for that invitation", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const inv = await invite(s);
    await t.mutation(api.invitations.generateUploadUrl, { ...proxy(), token: inv.token, kind: "photo" });
    const rows = await t.run(async (ctx) => ctx.db.query("uploadIntents").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ invitationId: inv.invitationId, kind: "photo" });
    expect(rows[0]!.kioskDeviceId).toBeUndefined();
  });

  test("counters store only the keyed hash, never an address", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const { token } = await invite(s);
    await t.mutation(api.invitations.lookup, { ...proxy(IP_A), token });
    const keys = (await t.run(async (ctx) => ctx.db.query("publicRateLimits").collect())).map((r) => r.key);
    expect(keys).toContain(`ip:invite_lookup:${IP_A}`);
    expect(JSON.stringify(keys)).not.toContain(SECRET);
  });
});

describe("stale counters", () => {
  test("rows from windows that ended long ago are swept, recent ones kept", async () => {
    const t = newTest();
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("publicRateLimits", { key: "ip:invite_lookup:old", windowStart: now - 30 * HOUR, count: 3 });
      await ctx.db.insert("publicRateLimits", { key: "ip:invite_lookup:new", windowStart: now - 1000, count: 3 });
    });
    expect(await t.mutation(internal.publicLimits.sweepStale, { now })).toEqual({ deleted: 1, hasMore: false });
    const keys = (await t.run(async (ctx) => ctx.db.query("publicRateLimits").collect())).map((r) => r.key);
    expect(keys).toEqual(["ip:invite_lookup:new"]);
  });

  test("is registered in the cron table", async () => {
    const crons = (await import("../../convex/crons")).default;
    expect(Object.keys(crons.crons)).toContain("stale rate limit sweep");
  });
});

describe("absolute invitation links", () => {
  test("a valid browser origin makes the link absolute when APP_BASE_URL is unset", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const res = await invite(s, { origin: "https://app.example.com" });
    expect(res.path).toBe(`/invite/${res.token}`);
    expect(res.url).toBe(`https://app.example.com/invite/${res.token}`);
  });

  test("APP_BASE_URL takes precedence over whatever the browser says", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    process.env.APP_BASE_URL = "https://wageni.example.org/";
    const res = await invite(s, { origin: "https://evil.example.com" });
    expect(res.url).toBe(`https://wageni.example.org/invite/${res.token}`);
    const none = await invite(s);
    expect(none.url).toBe(`https://wageni.example.org/invite/${none.token}`);
  });

  test("origins with credentials, paths, queries or fragments, and non-https schemes, are not used", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    for (const origin of [
      "https://user:pw@app.example.com",
      "https://app.example.com/some/path",
      "https://app.example.com?x=1",
      "https://app.example.com#x",
      "http://app.example.com",
      "javascript:alert(1)",
      "not a url",
    ]) {
      const res = await invite(s, { origin });
      expect(res.url, origin).toBe(res.path);
    }
  });

  test("localhost over http is only accepted when explicitly allowed (development)", async () => {
    const t = newTest();
    const s = await formsSetup(t);
    const off = await invite(s, { origin: "http://localhost:3000" });
    expect(off.url).toBe(off.path);
    process.env.ALLOW_LOCAL_ORIGIN = "true";
    const on = await invite(s, { origin: "http://localhost:3000" });
    expect(on.url).toBe(`http://localhost:3000/invite/${on.token}`);
    const lookalike = await invite(s, { origin: "http://localhost.evil.com" });
    expect(lookalike.url).toBe(lookalike.path);
  });

  test("the link handed to notifications is absolute too, and the token stays out of the audit log", async () => {
    vi.useFakeTimers();
    const t = newTest();
    const s = await formsSetup(t);
    const res = await invite(s, { origin: "https://app.example.com", visitorEmail: "ivy@example.com" });
    const scheduled = await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const job = scheduled.find((f) => f.name.includes("onInvitationCreated"));
    expect((job!.args[0] as { link: string }).link).toBe(`https://app.example.com/invite/${res.token}`);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // Once the message settles the outbox no longer holds the link.
    const outbox = JSON.stringify(await t.run(async (ctx) => ctx.db.query("notificationOutbox").collect()));
    expect(outbox).not.toContain(res.token);
    const logs = JSON.stringify(await t.run(async (ctx) => ctx.db.query("auditLogs").collect()));
    expect(logs).not.toContain(res.token);
  });
});
