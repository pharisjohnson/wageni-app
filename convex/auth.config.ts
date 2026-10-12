import type { AuthConfig } from "convex/server";

/**
 * Convex verifies JWTs issued by Clerk's "convex" JWT template.
 * Set CLERK_JWT_ISSUER_DOMAIN in the Convex dashboard (Settings → Environment
 * Variables), e.g. https://your-app.clerk.accounts.dev
 */
export default {
  providers: [
    {
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN!,
      applicationID: "convex",
    },
  ],
} satisfies AuthConfig;
