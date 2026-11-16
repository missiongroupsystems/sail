import { expect, pairAndSignIn, shot, test } from "./fixtures";

/**
 * A catalogue tile's name and its corner mark (the count badge, or a folder's chevron) never overlap, and only the
 * line beside the mark gives way to it: "Cheeseburger deluxe" stays whole within the two lines with a 12 badge (live
 * check in Safari at 1180 × 820: padding on the whole name cut it to "Cheese-/burger…"). Safari hyphenates and
 * Chromium on Linux does not, so every case runs with `hyphens: manual` and with `hyphens: auto`, and the checks are
 * geometric: no line under the mark, no line past the name's box (the two-line clamp hides nothing), 44px or taller.
 */
const CASHIER_PIN = "333333";

test.use({ viewport: { width: 1180, height: 820 } });

type Layout = { overlaps: boolean; clipped: boolean; hidden: boolean; lines: number; mark: string | null; height: number; width: number };

/** Where the tile's name and its corner mark sit, after giving the name `label` with the given `hyphens` (the demo menu has no long name). */
async function layout(tile: import("@playwright/test").Locator, label: string, hyphens: "manual" | "auto"): Promise<Layout> {
  return tile.evaluate(
    (el, [text, h]) => {
      const name = el.querySelector<HTMLElement>("span > span")!;
      const body = (name.querySelector(":scope > span.block") as HTMLElement | null) ?? name;
      const node = Array.from(body.childNodes).find((n) => n.nodeType === Node.TEXT_NODE)!;
      node.textContent = text;
      name.style.hyphens = h;
      const mark = Array.from(el.querySelectorAll<HTMLElement | SVGElement>("span, svg")).find((s) => getComputedStyle(s).position === "absolute")!;
      const range = document.createRange();
      range.selectNodeContents(node);
      const m = mark.getBoundingClientRect();
      const box = name.getBoundingClientRect();
      const t = el.getBoundingClientRect();
      // One rect per line fragment; merge fragments on the same line.
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0);
      const tops = new Set(rects.map((r) => Math.round(r.top)));
      return {
        overlaps: rects.some((r) => r.right > m.left && r.left < m.right && r.bottom > m.top && r.top < m.bottom),
        clipped: rects.some((r) => r.right > box.right + 0.5 || r.left < box.left - 0.5),
        hidden: rects.some((r) => r.bottom > box.bottom + 0.5) || name.scrollHeight > name.clientHeight + 1,
        lines: tops.size,
        mark: mark.textContent,
        height: t.height,
        width: t.width,
      };
    },
    [label, hyphens] as const,
  );
}

async function check(tile: import("@playwright/test").Locator, label: string, what: string) {
  for (const hyphens of ["manual", "auto"] as const) {
    const l = await layout(tile, label, hyphens);
    const where = `“${label}” ${what}, hyphens ${hyphens}`;
    expect(l.width, where).toBeLessThanOrEqual(136);
    expect(l.overlaps, `${where}: runs under the corner mark`).toBe(false);
    expect(l.clipped, `${where}: runs out of its box`).toBe(false);
    expect(l.hidden, `${where}: part of the name is cut off by the two-line clamp`).toBe(false);
    expect(l.height, where).toBeGreaterThanOrEqual(44);
  }
}

test("POS tile: the count badge never covers the item's name, and only the line beside it gives way", async ({ page }) => {
  test.setTimeout(300_000);
  await pairAndSignIn(page, CASHIER_PIN);
  await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Floor", exact: true }).click();
  await page.getByRole("button", { name: "Takeaway order", exact: true }).click();
  const tile = page.getByRole("button", { name: /^Mee Goreng,/ });
  await tile.click();
  await expect(tile).toHaveAccessibleName(/1 on the order/);
  await expect(page.getByRole("button", { name: "Send 1 to kitchen" })).toBeVisible();
  for (const label of ["Cheeseburger", "Cheeseburger deluxe", "Supercalifragilistic", "Mee Goreng"]) await check(tile, label, "with a 1 badge");
  for (let i = 2; i <= 12; i++) {
    await tile.click();
    await expect(page.getByRole("button", { name: `Send ${i} to kitchen` })).toBeVisible();
  }
  const folder = page.getByRole("button", { name: /^Hot, folder/ });
  for (const theme of ["day", "service"] as const) {
    await page.evaluate((t) => (t === "service" ? (document.documentElement.dataset.theme = "service") : delete document.documentElement.dataset.theme), theme);
    // "Cheese\u00ADburger" breaks where Safari's dictionary does ("Cheese-/burger"), which Chromium on Linux cannot.
    for (const label of ["Cheeseburger", "Cheeseburger deluxe", "Cheese\u00ADburger deluxe"]) {
      await check(tile, label, `with a 12 badge (${theme})`);
      expect((await layout(tile, label, "manual")).mark).toBe("12");
    }
    // The whole of "Cheeseburger deluxe" in two lines with the 12 badge: the second line has the tile's full width.
    for (const label of ["Cheeseburger deluxe", "Cheese\u00ADburger deluxe"]) for (const h of ["manual", "auto"] as const) expect((await layout(tile, label, h)).lines, `${label} ${h}`).toBe(2);
    await layout(tile, "Cheese\u00ADburger deluxe", "manual");
    await shot(tile, test.info().outputPath(`tile-12-${theme}.png`));
    // A name too long for two lines keeps as much as fits, with the ellipsis at the end of the second line.
    const long = await layout(tile, "Cheeseburger deluxe with extra pickles", "manual");
    expect(long.overlaps).toBe(false);
    expect(long.clipped).toBe(false);
    await shot(tile, test.info().outputPath(`tile-12-long-${theme}.png`));
    await layout(tile, "Cheeseburger deluxe", "manual");
  }
  await page.evaluate(() => delete document.documentElement.dataset.theme);
  // Folder tiles keep their first line clear of the chevron in the same way.
  await page.getByRole("tab", { name: "Drinks" }).or(page.getByRole("button", { name: "Drinks", exact: true })).first().click();
  await expect(folder).toBeVisible();
  for (const theme of ["day", "service"] as const) {
    await page.evaluate((t) => (t === "service" ? (document.documentElement.dataset.theme = "service") : delete document.documentElement.dataset.theme), theme);
    for (const label of ["Cheeseburger", "Cheeseburger deluxe", "Cheese\u00ADburger deluxe", "Supercalifragilistic"]) await check(folder, label, `folder (${theme})`);
    expect((await layout(folder, "Cheeseburger deluxe", "manual")).lines).toBe(2);
    await shot(folder, test.info().outputPath(`folder-${theme}.png`));
  }
});
