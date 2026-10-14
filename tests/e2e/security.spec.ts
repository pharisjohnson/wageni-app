import { expect, test } from "@playwright/test";

const PAGES = ["/", "/pricing", "/kiosk/demo-org", "/invite/not-a-real-token"];

test.describe("security headers", () => {
  for (const path of PAGES) {
    test(`${path} sends the hardening headers`, async ({ request }) => {
      const res = await request.get(path);
      const h = res.headers();
      expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(h["content-security-policy"]).toContain("object-src 'none'");
      expect(h["strict-transport-security"]).toMatch(/max-age=\d+/);
      expect(h["x-content-type-options"]).toBe("nosniff");
      expect(h["x-frame-options"]).toBe("DENY");
      expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
      expect(h["permissions-policy"]).toContain("camera=(self)");
      expect(h["x-powered-by"]).toBeUndefined();
    });
  }

  test("public pages render with no Content-Security-Policy violations", async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (m) => {
      if (/content security policy|refused to (load|execute|connect|apply)/i.test(m.text())) violations.push(m.text());
    });
    for (const path of ["/", "/pricing", "/kiosk/demo-org"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
    }
    expect(violations).toEqual([]);
  });
});

test.describe("health endpoint", () => {
  test("shallow check is public, uncached and reveals nothing", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);
    expect(res.headers()["cache-control"]).toContain("no-store");
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("deep check is refused without the token", async ({ request }) => {
    const res = await request.get("/api/health?deep=1");
    expect(res.status()).toBe(403);
    const res2 = await request.get("/api/health?deep=1", { headers: { authorization: "Bearer wrong" } });
    expect(res2.status()).toBe(403);
  });
});

test.describe("public routes stay public", () => {
  test("kiosk and invitation pages do not redirect to sign-in", async ({ page }) => {
    await page.goto("/kiosk/demo-org");
    expect(new URL(page.url()).pathname).toBe("/kiosk/demo-org");
    await page.goto("/invite/not-a-real-token");
    expect(new URL(page.url()).pathname).toBe("/invite/not-a-real-token");
  });

  test("the invite API refuses non-POST and unknown actions", async ({ request }) => {
    expect((await request.get("/api/invite/lookup")).status()).toBe(405);
    const bad = await request.post("/api/invite/nope", { data: {} });
    expect(bad.status()).toBeGreaterThanOrEqual(400);
    expect(bad.status()).toBeLessThan(500);
  });
});
