import { describe, expect, test } from "vitest";
import { buildCsp, buildSecurityHeaders, clerkFrontendHost } from "../../lib/security/headers";

const clerkKey = `pk_live_${Buffer.from("clerk.wageni.example$").toString("base64")}`;
const devKey = `pk_test_${Buffer.from("fun-cat-12.clerk.accounts.dev$").toString("base64")}`;

describe("clerkFrontendHost", () => {
  test("decodes the host from live and test keys, rejects junk", () => {
    expect(clerkFrontendHost(clerkKey)).toBe("clerk.wageni.example");
    expect(clerkFrontendHost(devKey)).toBe("fun-cat-12.clerk.accounts.dev");
    expect(clerkFrontendHost(undefined)).toBeNull();
    expect(clerkFrontendHost("pk_test_")).toBeNull();
    expect(clerkFrontendHost("pk_test_!!!notbase64")).toBeNull();
    expect(clerkFrontendHost(`pk_live_${Buffer.from("evil.com/x;script-src *$").toString("base64")}`)).toBeNull();
  });
});

describe("content security policy", () => {
  const prod = buildCsp({
    isDev: false,
    convexUrl: "https://happy-animal-123.convex.cloud",
    clerkPublishableKey: clerkKey,
  });

  test("locks down framing, plugins, base URI and form targets", () => {
    expect(prod).toContain("frame-ancestors 'none'");
    expect(prod).toContain("object-src 'none'");
    expect(prod).toContain("base-uri 'self'");
    expect(prod).toContain("form-action 'self'");
    expect(prod).toContain("default-src 'self'");
    expect(prod).toContain("upgrade-insecure-requests");
  });

  test("allows Clerk, Convex (https + websocket) and camera/blob media, nothing wildcard for scripts", () => {
    expect(prod).toMatch(/script-src [^;]*https:\/\/clerk\.wageni\.example/);
    expect(prod).toMatch(/connect-src [^;]*https:\/\/happy-animal-123\.convex\.cloud/);
    expect(prod).toMatch(/connect-src [^;]*wss:\/\/happy-animal-123\.convex\.cloud/);
    expect(prod).toMatch(/connect-src [^;]*wss:\/\/\*\.convex\.cloud/);
    expect(prod).toMatch(/media-src [^;]*blob:/);
    const script = /script-src ([^;]*)/.exec(prod)![1]!;
    expect(script).not.toMatch(/(^| )\*( |$)|https: |unsafe-eval|http:/);
  });

  test("development adds eval and websockets, production never does", () => {
    const dev = buildCsp({ isDev: true });
    expect(dev).toContain("'unsafe-eval'");
    expect(prod).not.toContain("unsafe-eval");
    expect(prod).not.toMatch(/ ws:/);
  });

  test("report-only and report-uri are supported", () => {
    const h = buildSecurityHeaders({ isDev: false, reportOnly: true, reportUri: "https://r.example/csp" });
    const keys = h.map((x) => x.key);
    expect(keys).toContain("Content-Security-Policy-Report-Only");
    expect(keys).not.toContain("Content-Security-Policy");
    expect(h[0]!.value).toContain("report-uri https://r.example/csp");
  });
});

describe("other security headers", () => {
  const headers = Object.fromEntries(buildSecurityHeaders({ isDev: false }).map((h) => [h.key, h.value]));

  test("HSTS, nosniff, frame denial, referrer and permissions policy", () => {
    expect(headers["Strict-Transport-Security"]).toMatch(/max-age=\d{8,}/);
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
  });

  test("camera is allowed for this origin only; microphone and geolocation are off", () => {
    const p = headers["Permissions-Policy"]!;
    expect(p).toContain("camera=(self)");
    expect(p).toContain("microphone=()");
    expect(p).toContain("geolocation=()");
  });
});
