import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

/**
 * Optimistic route protection only: redirects signed-out users away from
 * private areas. Real authorization happens in every Convex function.
 * Marketing pages, organization kiosks (/kiosk), invitation links (/invite and
 * /api/invite) and the health probe (/api/health) stay public: only the
 * prefixes below require a session. Security headers live in next.config.ts.
 */
const isProtectedRoute = createRouteMatcher(["/app(.*)", "/platform(.*)", "/onboarding(.*)"]);

const authConfigured = Boolean(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY,
);

export default authConfigured
  ? clerkMiddleware(async (auth, req) => {
      if (isProtectedRoute(req)) await auth.protect();
    })
  : () => NextResponse.next();

export const config = {
  matcher: [
    // Skip Next.js internals and static files, unless found in search params
    "/((?!_next|api/health|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api(?!/health)|trpc)(.*)",
  ],
};
