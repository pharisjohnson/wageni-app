import type { NextConfig } from "next";
import { buildSecurityHeaders } from "./lib/security/headers";

const isDev = process.env.NODE_ENV === "development";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: buildSecurityHeaders({
          isDev,
          convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL,
          clerkPublishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
          reportOnly: process.env.CSP_REPORT_ONLY === "true",
          reportUri: process.env.CSP_REPORT_URI || undefined,
        }),
      },
    ];
  },
};

export default nextConfig;
