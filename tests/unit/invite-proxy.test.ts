import { ConvexError } from "convex/values";
import { describe, expect, test, vi } from "vitest";
import { MAX_BODY_BYTES, proxyInvite, type InviteAction } from "../../lib/server/invite-proxy";

const SECRET = "proxy-secret-0123456789abcdef";
const headers = (h: Record<string, string> = {}) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });
const run = (
  action: string,
  body: unknown,
  h: Record<string, string>,
  env: Parameters<typeof proxyInvite>[1],
  call: Parameters<typeof proxyInvite>[2],
) => proxyInvite({ action, bodyText: typeof body === "string" ? body : JSON.stringify(body), headers: headers(h) }, env, call);

describe("invite proxy", () => {
  test("passes the secret and a keyed IP hash to Convex, never the raw address", async () => {
    const call = vi.fn(async (_a: InviteAction, _args: Record<string, unknown>) => ({ status: "ok" }));
    const res = await run("lookup", { token: "wi_x" }, { "x-real-ip": "203.0.113.9" }, { secret: SECRET }, call);
    expect(res).toEqual({ status: 200, body: { ok: true, data: { status: "ok" } } });
    const [action, args] = call.mock.calls[0]!;
    expect(action).toBe("lookup");
    expect(args).toMatchObject({ token: "wi_x", proxySecret: SECRET });
    expect(args.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(args)).not.toContain("203.0.113.9");
  });

  test("the same client gets the same hash; different clients differ", async () => {
    const hashes: string[] = [];
    const call = async (_a: InviteAction, args: Record<string, unknown>) => {
      hashes.push(args.ipHash as string);
      return null;
    };
    await run("lookup", {}, { "x-real-ip": "203.0.113.9" }, { secret: SECRET }, call);
    await run("lookup", {}, { "x-forwarded-for": "203.0.113.9, 10.0.0.1" }, { secret: SECRET }, call);
    await run("lookup", {}, { "x-real-ip": "203.0.113.10" }, { secret: SECRET }, call);
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[2]).not.toBe(hashes[0]);
  });

  test("callers cannot supply their own secret or IP hash", async () => {
    const call = vi.fn(async (_a: InviteAction, _args: Record<string, unknown>) => null);
    await run("submit", { token: "t", proxySecret: "mine", ipHash: "f".repeat(64) }, { "x-real-ip": "203.0.113.9" }, { secret: SECRET }, call);
    const args = call.mock.calls[0]![1];
    expect(args.proxySecret).toBe(SECRET);
    expect(args.ipHash).not.toBe("f".repeat(64));
  });

  test("fails closed without a secret (503, Convex is never called)", async () => {
    const call = vi.fn(async () => null);
    for (const env of [{}, { secret: "" }, { allowUnproxied: false }]) {
      const res = await run("lookup", { token: "t" }, { "x-real-ip": "203.0.113.9" }, env, call);
      expect(res.status).toBe(503);
    }
    expect(call).not.toHaveBeenCalled();
  });

  test("the development flag allows calls without a secret and sends no secret", async () => {
    const call = vi.fn(async (_a: InviteAction, _args: Record<string, unknown>) => ({ ok: 1 }));
    const res = await run("lookup", { token: "t" }, {}, { allowUnproxied: true }, call);
    expect(res.status).toBe(200);
    expect(call.mock.calls[0]![1]).toMatchObject({ proxySecret: "", ipHash: "dev" });
  });

  test("unknown actions, bad JSON and oversize bodies are refused before Convex", async () => {
    const call = vi.fn(async () => null);
    expect((await run("delete-everything", {}, {}, { secret: SECRET }, call)).status).toBe(404);
    expect((await run("lookup", "{nope", {}, { secret: SECRET }, call)).status).toBe(400);
    expect((await run("lookup", "[1,2]", {}, { secret: SECRET }, call)).status).toBe(400);
    expect((await run("lookup", "x".repeat(MAX_BODY_BYTES + 1), {}, { secret: SECRET }, call)).status).toBe(413);
    expect(call).not.toHaveBeenCalled();
  });

  test("maps Convex application errors to HTTP statuses and hides everything else", async () => {
    const fails = (code: string, message = "Safe message.") => async () => {
      throw new ConvexError({ code, message });
    };
    expect(await run("lookup", {}, {}, { secret: SECRET }, fails("RATE_LIMITED"))).toMatchObject({
      status: 429,
      body: { ok: false, code: "RATE_LIMITED" },
    });
    expect(await run("submit", {}, {}, { secret: SECRET }, fails("VALIDATION", "Enter your name."))).toMatchObject({
      status: 400,
      body: { message: "Enter your name." },
    });
    expect((await run("submit", {}, {}, { secret: SECRET }, fails("CONFLICT"))).status).toBe(409);
    // A secret mismatch is an operator problem: the visitor sees "not available", not the cause.
    const forbidden = await run("lookup", {}, {}, { secret: SECRET }, fails("FORBIDDEN", "secret mismatch"));
    expect(forbidden.status).toBe(503);
    expect(JSON.stringify(forbidden.body)).not.toContain("mismatch");
    const boom = await run(
      "lookup",
      {},
      {},
      { secret: SECRET },
      async () => {
        throw new Error("stack trace with internals");
      },
    );
    expect(boom.status).toBe(500);
    expect(JSON.stringify(boom.body)).not.toContain("internals");
  });
});
