import { ConvexHttpClient } from "convex/browser";
import type { NextRequest } from "next/server";
import { api } from "@/convex/_generated/api";
import { proxyInvite, type InviteAction } from "@/lib/server/invite-proxy";

/**
 * Per-IP rate limiting front for the public invitation page. The browser
 * calls this route instead of Convex; Convex rejects direct calls (no shared
 * secret). See lib/server/invite-proxy.ts and docs/security.md.
 *
 * Client IP trust: read from x-real-ip / x-forwarded-for, which Vercel sets
 * from the connecting address. Hosts that forward client-supplied values need
 * CLIENT_IP_HEADER pointed at a header their proxy controls.
 */

// A POST handler is never cached (and `dynamic` route config is not allowed with cacheComponents).

function client() {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is not set");
  return new ConvexHttpClient(url);
}

async function call(action: InviteAction, args: Record<string, unknown>): Promise<unknown> {
  const convex = client();
  // Arguments are validated by the Convex function's own validators.
  switch (action) {
    case "lookup":
      return await convex.mutation(api.invitations.lookup, args as never);
    case "upload-url":
      return await convex.mutation(api.invitations.generateUploadUrl, args as never);
    case "register-upload":
      return await convex.mutation(api.invitations.registerUploaded, args as never);
    case "submit":
      return await convex.mutation(api.invitations.submit, args as never);
  }
}

export async function POST(request: NextRequest, ctx: RouteContext<"/api/invite/[action]">) {
  const { action } = await ctx.params;
  const result = await proxyInvite(
    { action, bodyText: await request.text(), headers: request.headers },
    {
      secret: process.env.INVITE_PROXY_SECRET,
      allowUnproxied: process.env.ALLOW_UNPROXIED_INVITES === "true",
      ipHeader: process.env.CLIENT_IP_HEADER || undefined,
    },
    call,
  );
  return Response.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}
