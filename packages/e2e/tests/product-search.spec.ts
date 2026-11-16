import type { Page } from "@playwright/test";
import { devLocal, expect, SG_ADMIN, shot, test, WEB } from "./fixtures";

/**
 * Menus & sections, "+ Products": the search results read from the left like every other list, name first and price
 * at the right (live check: the text sat in the middle of its row). The Button's own `justify-center` won over the
 * row's `justify-between`, as class names are not merged.
 */
async function signIn(page: Page) {
  await page.goto(`${WEB}/login`);
  await expect(async () => {
    await page.getByLabel("Email").fill(SG_ADMIN);
    await page.getByLabel("Password").fill(devLocal().admin_password);
    await page.getByRole("button", { name: "Sign in" }).click({ timeout: 10_000 });
    await page.waitForURL(`${WEB}/today`, { timeout: 30_000 });
  }).toPass({ timeout: 300_000 });
}

test("the product picker's results are left-aligned, with the price at the right", async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await page.goto(`${WEB}/menu/menus`);
  await page.getByRole("button", { name: "Products", exact: true }).first().click();
  await page.getByRole("searchbox", { name: "Search products" }).fill("a");
  const results = page.getByRole("list", { name: "Results" });
  await expect(results.getByRole("button").first()).toBeVisible();
  const rows = await results.getByRole("button").evaluateAll((buttons) =>
    buttons.map((b) => {
      const box = b.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(b);
      const text = Array.from(range.getClientRects());
      const s = getComputedStyle(b);
      const inset = { left: parseFloat(s.paddingLeft) + parseFloat(s.borderLeftWidth), right: parseFloat(s.paddingRight) + parseFloat(s.borderRightWidth) };
      return { label: b.textContent, left: Math.min(...text.map((r) => r.left)) - box.left - inset.left, right: box.right - Math.max(...text.map((r) => r.right)) - inset.right };
    }),
  );
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    // The name starts at the row's padding and the price ends at it.
    expect(r.left, `${r.label}: text starts at the left`).toBeLessThanOrEqual(1);
    expect(r.right, `${r.label}: the price ends at the right`).toBeLessThanOrEqual(1);
  }
  await shot(page, test.info().outputPath("menus-product-search.png"));
});
