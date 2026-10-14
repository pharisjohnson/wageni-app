import { expect, test } from "@playwright/test";

test("landing page explains the product and links to sign-up", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Know who is on your premises");
  await expect(page.getByRole("link", { name: "Get early access" }).first()).toHaveAttribute("href", "/sign-up");
  await expect(page.locator("#features")).toBeVisible();
});

test("pricing page lists plans", async ({ page }) => {
  await page.goto("/pricing");
  await expect(page.getByRole("heading", { name: "Pricing" })).toBeVisible();
  await expect(page.getByText("Starter", { exact: true })).toBeVisible();
});

test("layout has no horizontal overflow", async ({ page }) => {
  await page.goto("/");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("private areas never render without configuration or sign-in", async ({ page }) => {
  await page.goto("/app");
  // Either the setup notice (no credentials) or a redirect to sign-in.
  await expect(
    page.getByRole("heading", { name: "Backend not configured" }).or(page.locator("[data-clerk-component], .cl-rootBox")),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Dashboard")).toHaveCount(0);
});
