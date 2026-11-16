import { devLocal, expect, SG_ADMIN, shot, test, WEB } from "./fixtures";

/**
 * The specs' screenshots must not change the page they record. A shot taken while the development server is still
 * loading the page's scripts used to write the caret style into every input before React hydrated it, and React then
 * reported a hydration mismatch (live-round5 M6 on /settings/merchant, `style="caret-color:transparent"`).
 */
test("a screenshot taken before the page hydrates leaves the server's HTML as it was", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto(`${WEB}/login`);
  await expect(async () => {
    await page.getByLabel("Email").fill(SG_ADMIN);
    await page.getByLabel("Password").fill(devLocal().admin_password);
    await page.getByRole("button", { name: "Sign in" }).click({ timeout: 10_000 });
    await page.waitForURL(`${WEB}/today`, { timeout: 30_000 });
  }).toPass({ timeout: 300_000 });

  // Hold the page's scripts so the shot lands on the server's HTML, then let React hydrate it.
  let release!: () => void;
  const scripts = new Promise<void>((r) => (release = r));
  await page.route(/\/_next\/static\/chunks\/.+\.js/, async (route) => {
    await scripts;
    await route.continue();
  });
  await page.goto(`${WEB}/settings/merchant`, { waitUntil: "domcontentloaded" });
  const field = page.getByRole("textbox", { name: "Business registration label" });
  await expect(field).toBeVisible();
  expect(await field.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactFiber$"))), "not hydrated yet").toBe(false);
  await shot(page, test.info().outputPath("before-hydration.png"));
  release();
  await expect.poll(() => field.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactFiber$"))), { timeout: 120_000 }).toBe(true);
  // The watch fixture fails the test on React's "A tree hydrated but some attributes … didn't match" console error.
  await page.waitForLoadState("networkidle");
});
