/**
 * Security response headers (H1). Pure so it can be unit-tested and used from
 * next.config.ts.
 *
 * Content Security Policy: an allowlist policy, not a nonce policy. A nonce
 * policy needs every page rendered per request, which would turn off static
 * rendering and the partial-prefetch shell this app is built around, so
 * `script-src` keeps `'unsafe-inline'` for the framework's own bootstrap
 * scripts and relies on the allowlist, `object-src 'none'`, `base-uri 'self'`
 * and `frame-ancestors 'none'` for the rest. The residual risk (an injected
 * inline script would run) is mitigated by the app never rendering
 * user-supplied HTML: all customer text (branding, form labels, consent text)
 * is rendered as React text. Tighten to nonces if the app ever goes fully
 * dynamic.
 *
 * Third parties that must work:
 *  - Clerk: its JS loads from, and the browser talks to, the instance's
 *    Frontend API host. It is derived from the publishable key (the key is
 *    base64 of "<host>$"). Bot protection loads from challenges.cloudflare.com.
 *  - Convex: https and wss to *.convex.cloud (queries, mutations, storage upload URLs).
 *  - next/font self-hosts Google Fonts at build time, so no font host is needed.
 *  - Customer logos are arbitrary https images (`img-src https:`).
 *  - Camera: kiosk ID scan, face photo and invitation uploads use getUserMedia,
 *    allowed for this origin only by Permissions-Policy.
 */
export type HeaderInput = {
  isDev: boolean;
  convexUrl?: string;
  clerkPublishableKey?: string;
  /** Send the policy as Content-Security-Policy-Report-Only (safe rollout). */
  reportOnly?: boolean;
  /** Where the browser posts violation reports (optional). */
  reportUri?: string;
};

/** The Clerk Frontend API host encoded in a publishable key, or null. */
export function clerkFrontendHost(key: string | undefined): string | null {
  if (!key) return null;
  const parts = key.split("_");
  const encoded = parts[2];
  if (!encoded) return null;
  try {
    const host = Buffer.from(encoded, "base64").toString("utf8").replace(/\$$/, "");
    return /^[a-z0-9.-]+$/i.test(host) && host.includes(".") ? host : null;
  } catch {
    return null;
  }
}

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

export function buildCsp({ isDev, convexUrl, clerkPublishableKey, reportUri }: HeaderInput): string {
  const clerkHost = clerkFrontendHost(clerkPublishableKey);
  const clerk = [clerkHost ? `https://${clerkHost}` : null, "https://*.clerk.accounts.dev"].filter(Boolean) as string[];
  const convexOrigin = originOf(convexUrl);
  const convexWs = convexOrigin ? convexOrigin.replace(/^http/, "ws") : null;
  const convex = ["https://*.convex.cloud", "wss://*.convex.cloud", convexOrigin, convexWs].filter(Boolean) as string[];

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": [
      "'self'",
      "'unsafe-inline'",
      ...(isDev ? ["'unsafe-eval'"] : []),
      ...clerk,
      "https://challenges.cloudflare.com",
    ],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", "https:"],
    "font-src": ["'self'", "data:"],
    "connect-src": [
      "'self'",
      ...convex,
      ...clerk,
      "https://clerk-telemetry.com",
      ...(isDev ? ["ws:", "http://localhost:*", "http://127.0.0.1:*"] : []),
    ],
    "media-src": ["'self'", "blob:"],
    "worker-src": ["'self'", "blob:"],
    "frame-src": ["https://challenges.cloudflare.com", ...clerk],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };
  const parts = Object.entries(directives).map(([k, v]) => `${k} ${v.join(" ")}`);
  if (!isDev) parts.push("upgrade-insecure-requests");
  if (reportUri) parts.push(`report-uri ${reportUri}`);
  return parts.join("; ");
}

export const PERMISSIONS_POLICY = [
  "camera=(self)",
  "microphone=()",
  "geolocation=()",
  "payment=()",
  "usb=()",
  "bluetooth=()",
  "serial=()",
  "interest-cohort=()",
].join(", ");

export function buildSecurityHeaders(input: HeaderInput): { key: string; value: string }[] {
  const csp = buildCsp(input);
  return [
    { key: input.reportOnly ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy", value: csp },
    { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
    { key: "X-DNS-Prefetch-Control", value: "off" },
    { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
  ];
}
