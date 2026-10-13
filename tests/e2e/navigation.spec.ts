import { expect, test, type Page } from "@playwright/test";

/** Mobile layouts hide the inline nav behind a menu button (below md = 768px). */
async function isCompact(page: Page) {
  const width = page.viewportSize()?.width ?? 1280;
  return width < 768;
}

async function openMenuIfCompact(page: Page) {
  if (await isCompact(page)) {
    await page.getByRole("button", { name: "Open menu" }).click();
    return page.getByRole("navigation", { name: "Mobile" });
  }
  return page.getByRole("navigation", { name: "Marketing" });
}

test("marketing nav links reach every landing section", async ({ page }) => {
  for (const [label, id] of [
    ["Features", "features"],
    ["How it works", "how-it-works"],
    ["FAQ", "faq"],
  ] as const) {
    await page.goto("/");
    const nav = await openMenuIfCompact(page);
    await nav.getByRole("link", { name: label }).click();
    await expect(page).toHaveURL(new RegExp(`#${id}$`));
    await expect(page.locator(`#${id}`)).toBeInViewport();
  }
});

test("landing anchors exist", async ({ page }) => {
  await page.goto("/");
  for (const id of ["features", "how-it-works", "faq"]) {
    await expect(page.locator(`#${id}`)).toHaveCount(1);
  }
});

test("mobile menu opens, lists every destination and closes", async ({ page }) => {
  test.skip(!(await isCompact(page)), "Menu only renders on narrow viewports");
  await page.goto("/");
  await page.getByRole("button", { name: "Open menu" }).click();
  const nav = page.getByRole("navigation", { name: "Mobile" });
  for (const name of ["Features", "How it works", "Pricing", "FAQ", "Sign in", "Get started"]) {
    await expect(nav.getByRole("link", { name })).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(nav).toBeHidden();
});

test("pricing links back to home and to sign-up", async ({ page }) => {
  await page.goto("/pricing");
  await page.getByRole("link", { name: /home$/i }).first().click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/pricing");
  await expect(page.getByRole("link", { name: "Start free trial" }).first()).toHaveAttribute("href", "/sign-up");
});

test("unknown routes show a 404 with a way home", async ({ page }) => {
  const response = await page.goto("/definitely-not-a-page");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await page.getByRole("link", { name: "Back to home" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("kiosk shows setup notice with a way home when the backend is not configured", async ({ page }) => {
  await page.goto("/kiosk/demo");
  const setup = page.getByRole("heading", { name: "Backend not configured" });
  test.skip(
    !(await setup.isVisible({ timeout: 10_000 }).catch(() => false)),
    "A backend is configured here; kiosk screens need live Convex data and cannot be asserted without it",
  );
  await page.getByRole("link", { name: "Back to home" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("kiosk sub-screens (Back / Start over, tile focus, 48px targets)", async () => {
  test.skip(true, "Requires a Convex deployment with a seeded organization; kiosk content is not rendered without a backend");
});

test("platform and onboarding never render without configuration or sign-in", async ({ page }) => {
  for (const path of ["/platform", "/onboarding"]) {
    await page.goto(path);
    await expect(
      page.getByRole("heading", { name: "Backend not configured" }).or(page.locator("[data-clerk-component], .cl-rootBox")),
    ).toBeVisible({ timeout: 15_000 });
  }
});
