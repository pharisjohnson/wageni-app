import { clientIp, hashIp } from "./client-ip";

/**
 * Core of the invitation proxy (`app/api/invite/[action]/route.ts`), kept free
 * of Next.js and Convex imports so it can be unit-tested.
 *
 * Flow: parse + size-check the body, read the client IP from platform
 * headers, hash it with INVITE_PROXY_SECRET, and hand `{ proxySecret, ipHash,
 * ...args }` to `call`, which invokes the Convex function. Convex checks the
 * secret in constant time and spends the per-IP budget. The raw IP is never
 * sent to Convex or stored.
 *
 * Failing closed: with INVITE_PROXY_SECRET unset the proxy answers 503, unless
 * ALLOW_UNPROXIED_INVITES=true (development only), in which case no secret or
 * IP hash is sent and Convex must have the same flag set.
 */

export const INVITE_ACTIONS = ["lookup", "upload-url", "register-upload", "submit"] as const;
export type InviteAction = (typeof INVITE_ACTIONS)[number];

/** The largest body accepted (a full form with long text answers is well under this). */
export const MAX_BODY_BYTES = 512 * 1024;

export type ProxyEnv = {
  secret?: string;
  allowUnproxied?: boolean;
  ipHeader?: string;
};

export type ProxyResult =
  | { status: 200; body: { ok: true; data: unknown } }
  | { status: number; body: { ok: false; code: string; message: string } };

const fail = (status: number, code: string, message: string): ProxyResult => ({
  status,
  body: { ok: false, code, message },
});

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Convex errors thrown with `appError` carry `{ code, message }` in `data`. */
function appErrorOf(e: unknown): { code: string; message: string } | null {
  const data = (e as { data?: unknown } | null)?.data;
  if (isObject(data) && typeof data.code === "string") {
    return { code: data.code, message: typeof data.message === "string" ? data.message : "Something went wrong." };
  }
  return null;
}

const STATUS_BY_CODE: Record<string, number> = {
  RATE_LIMITED: 429,
  VALIDATION: 400,
  CONFLICT: 409,
  NOT_FOUND: 404,
  UNAUTHENTICATED: 401,
  // The shared secret did not match (misconfiguration or a direct-call attempt): not the visitor's fault.
  FORBIDDEN: 503,
};

export async function proxyInvite(
  input: { action: string; bodyText: string; headers: { get(name: string): string | null } },
  env: ProxyEnv,
  call: (action: InviteAction, args: Record<string, unknown>) => Promise<unknown>,
): Promise<ProxyResult> {
  if (!(INVITE_ACTIONS as readonly string[]).includes(input.action)) return fail(404, "NOT_FOUND", "Not found.");
  const action = input.action as InviteAction;

  const secret = env.secret ?? "";
  let security: { proxySecret: string; ipHash: string };
  if (secret.length > 0) {
    const ip = clientIp(input.headers, { header: env.ipHeader });
    security = { proxySecret: secret, ipHash: await hashIp(ip, secret) };
  } else if (env.allowUnproxied) {
    security = { proxySecret: "", ipHash: "dev" };
  } else {
    // Fail closed: nothing reaches Convex without the shared secret.
    return fail(503, "UNAVAILABLE", "This service is not available right now.");
  }

  if (new TextEncoder().encode(input.bodyText).length > MAX_BODY_BYTES) {
    return fail(413, "VALIDATION", "That request is too large.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.bodyText || "{}");
  } catch {
    return fail(400, "VALIDATION", "Invalid request.");
  }
  if (!isObject(parsed)) return fail(400, "VALIDATION", "Invalid request.");
  // Callers may not smuggle their own security fields.
  const { proxySecret: _s, ipHash: _h, ...args } = parsed;
  void _s;
  void _h;

  try {
    const data = await call(action, { ...args, ...security });
    return { status: 200, body: { ok: true, data } };
  } catch (e) {
    const known = appErrorOf(e);
    if (known) {
      const status = STATUS_BY_CODE[known.code] ?? 400;
      // 503 hides the cause; the operator sees the mismatch in Convex logs.
      return status === 503
        ? fail(503, "UNAVAILABLE", "This service is not available right now.")
        : fail(status, known.code, known.message);
    }
    return fail(500, "INTERNAL", "Something went wrong. Please try again.");
  }
}
