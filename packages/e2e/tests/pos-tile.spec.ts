import { expect, pairAndSignIn, shot, test } from "./fixtures";

/**
 * A catalogue tile's name and its count badge never overlap: a one-word name too long for the tile (live check:
 * "Cheeseburger" at 1180 × 820) wraps inside the space left of the badge instead of running under it.
 */
const CASHIER_PIN = "333333";

test.use({ viewport: { width: 1180, height: 820 } });

/** Where the tile's name and its badge sit, after giving the name `label` (the demo menu has no long one-word name). */
async function layout(page: import("@playwright/test").Page, label: string) {
  return page.getByRole("button", { name: /^Mee Goreng,/ }).evaluate((tile, text) => {
    const name = tile.querySelector<HTMLElement>("span > span")!;
    name.firstChild!.textContent = text;
    const badge = Array.from(tile.querySelectorAll<HTMLElement>("span")).find((s) => getComputedStyle(s).position === "absolute")!;
    const range = document.createRange();
    range.selectNodeContents(name);
    const b = badge.getBoundingClientRect();
    const t = tile.getBoundingClientRect();
    const lines = Array.from(range.getClientRects()).map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom }));
    return {
      overlaps: lines.some((r) => r.right > b.left && r.left < b.right && r.bottom > b.top && r.top < b.bottom),
      clipped: lines.some((r) => r.right > t.right - 1) || name.scrollWidth > name.clientWidth,
      badge: badge.textContent,
      height: t.height,
      width: t.width,
    };
  }, label);
}

test("POS tile: the count badge never covers the item's name, with long names and two-digit counts", async ({ page }) => {
  test.setTimeout(300_000);
  await pairAndSignIn(page, CASHIER_PIN);
  await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Floor", exact: true }).click();
  await page.getByRole("button", { name: "Takeaway order", exact: true }).click();
  const tile = page.getByRole("button", { name: /^Mee Goreng,/ });
  await tile.click();
  await expect(tile).toHaveAccessibleName(/1 on the order/);
  await expect(page.getByRole("button", { name: "Send 1 to kitchen" })).toBeVisible();
  for (const label of ["Cheeseburger", "Cheeseburger deluxe", "Supercalifragilistic", "Mee Goreng"]) {
    const l = await layout(page, label);
    expect(l.overlaps, `“${label}” runs under the badge`).toBe(false);
    expect(l.clipped, `“${label}” is cut off`).toBe(false);
    expect(l.height).toBeGreaterThanOrEqual(44);
  }
  for (let i = 2; i <= 12; i++) {
    // One tap at a time: an add sent while the last is in flight is replayed after a 409 (pos.spec.ts).
    await tile.click();
    await expect(page.getByRole("button", { name: `Send ${i} to kitchen` })).toBeVisible();
  }
  for (const theme of ["day", "service"] as const) {
    await page.evaluate((t) => (t === "service" ? (document.documentElement.dataset.theme = "service") : delete document.documentElement.dataset.theme), theme);
    for (const label of ["Cheeseburger", "Cheeseburger deluxe"]) {
      const l = await layout(page, label);
      expect(l.badge).toBe("12");
      expect(l.overlaps, `“${label}” runs under the 12 badge (${theme})`).toBe(false);
      expect(l.clipped, `“${label}” is cut off (${theme})`).toBe(false);
    }
    await shot(tile, test.info().outputPath(`tile-${theme}.png`));
  }
});
