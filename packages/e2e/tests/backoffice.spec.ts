import type { Page } from "@playwright/test";
import { devLocal, expect, SG_ADMIN, test, textContrast, WEB } from "./fixtures";

/** Sign in as the seeded Admin with the demo password; done once the Today page has rendered, so the next navigation is not cut short. */
async function signIn(page: Page) {
  await page.goto(`${WEB}/login`);
  // A click that lands before the dev server's first compile has hydrated the form does nothing, so press until it signs in.
  await expect(async () => {
    await page.getByLabel("Email").fill(SG_ADMIN);
    await page.getByLabel("Password").fill(devLocal().admin_password);
    await page.getByRole("button", { name: "Sign in" }).click({ timeout: 10_000 });
    await page.waitForURL(`${WEB}/today`, { timeout: 30_000 });
  }).toPass({ timeout: 300_000 });
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
}

/** One page per back-office section and each section's sub-pages. */
const PAGES = [
  "/today",
  "/orders",
  "/menu/products",
  "/menu/modifiers",
  "/menu/menus",
  "/menu/categories",
  "/menu/availability",
  "/menu/sold-out",
  "/menu/import",
  "/pricing/rules",
  "/pricing/simulator",
  "/pricing/customers",
  "/floor",
  "/printing/printers",
  "/printing/relays",
  "/printing/jobs",
  "/team",
  "/reports",
  "/reports/z-report",
  "/reports/sales",
  "/reports/items",
  "/reports/shifts",
  "/reports/print-health",
  "/changes",
  "/assistants",
  "/settings/outlets",
  "/settings/brands",
  "/settings/stations",
  "/settings/channels",
  "/settings/tenders",
  "/settings/tax",
  "/settings/void-reasons",
  "/settings/merchant",
  "/audit",
  "/account/password",
];

test("back office: sign in, then every section loads without console errors or failed requests", async ({ page }) => {
  // The dev servers compile each route on its first visit.
  test.setTimeout(1_800_000);
  await signIn(page);

  for (const path of PAGES) {
    await test.step(path, async () => {
      const res = await page.goto(`${WEB}${path}`);
      expect(res?.status(), path).toBeLessThan(400);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      // Client data loads after the frame: wait for the page's loading placeholders to go, so its requests are judged.
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    });
  }
});

test("back office: body text and secondary buttons are readable in Day and Service", async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);
  await page.goto(`${WEB}/menu/products`);
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  for (const theme of ["day", "service"] as const) {
    await page.evaluate((t) => {
      if (t === "service") document.documentElement.dataset.theme = "service";
      else delete document.documentElement.dataset.theme;
    }, theme);
    for (const [what, selector] of [
      ["page heading", "main h1"],
      ["secondary text", "main .text-ink-2"],
      ["table text", 'main [role="grid"] [role="rowheader"], main table th[scope="row"], main table td'],
      ["secondary button", "main button.bg-surface-2"],
    ] as const) {
      await expect.poll(async () => (await textContrast(page, selector)).ratio, { message: `${theme}: ${what} contrast`, timeout: 5_000 }).toBeGreaterThanOrEqual(4.5);
    }
  }
});
