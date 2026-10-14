import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";

/**
 * Health and readiness probe for uptime monitors and Vercel checks.
 *
 *   GET /api/health            shallow: the app is serving. Nothing else.
 *   GET /api/health?deep=1     also reports which integrations are configured
 *                              (booleans only) and calls Convex (`health:ping`). Needs
 *                              `Authorization: Bearer $HEALTH_CHECK_TOKEN`
 *                              when that variable is set; without the variable
 *                              deep checks are refused, so the public cannot
 *                              use this route to generate backend calls.
 *
 * Never returns secrets, versions, hostnames or tenant data. 200 = healthy,
 * 503 = a deep check failed. Always `no-store`.
 */

const TIMEOUT_MS = 3000;

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function tokenOk(request: Request): boolean {
  const expected = process.env.HEALTH_CHECK_TOKEN;
  if (!expected || expected.length < 16) return false;
  const given = request.headers.get("authorization") ?? "";
  const provided = given.startsWith("Bearer ") ? given.slice(7) : "";
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export async function GET(request: Request) {
  const checks = {
    convexConfigured: Boolean(process.env.NEXT_PUBLIC_CONVEX_URL),
    clerkConfigured: Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY),
    inviteProxyConfigured: Boolean(process.env.INVITE_PROXY_SECRET),
  };
  const url = new URL(request.url);
  if (url.searchParams.get("deep") !== "1") return json({ status: "ok" });

  if (!tokenOk(request)) return json({ status: "forbidden" }, 403);
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) return json({ status: "degraded", checks, backend: "not_configured" }, 503);
  try {
    const client = new ConvexHttpClient(convexUrl);
    const result = await Promise.race([
      client.query(api.health.ping, {}),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)),
    ]);
    return json({ status: result.ok ? "ok" : "degraded", checks, backend: result.ok ? "ok" : "down" }, result.ok ? 200 : 503);
  } catch {
    return json({ status: "degraded", checks, backend: "down" }, 503);
  }
}
