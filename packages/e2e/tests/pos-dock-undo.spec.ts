import type { Page } from "@playwright/test";
import { expect, pairAndSignIn, test } from "./fixtures";

/**
 * Final visual review 1 and 2 on the order sheet: the dock names Hold, Discount and Bill in words whether or not there
 * are unsent lines, each at least a 44px target, and Send takes away the "Added …" Undo, which on a sent line voided it
 * as "Undo" with no reason asked.
 */

const MANAGER_PIN = "222222";

async function newTakeaway(page: Page) {
  await page.getByRole("button", { name: "Floor", exact: true }).click();
  await page.getByRole("button", { name: "Takeaway order", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Menu sections" })).toBeVisible();
}

/** Each named control shows its name on screen, inside the screen, and is a 44px target at least. */
async function namesOnScreen(page: Page, names: string[]) {
  const dock = page.getByRole("toolbar", { name: "Order actions" });
  for (const name of names) {
    const button = dock.getByRole("button", { name, exact: true });
    await expect(button).toHaveText(name);
    const box = (await button.boundingBox())!;
    expect(box.width, `${name} width`).toBeGreaterThanOrEqual(44);
    expect(box.height, `${name} height`).toBeGreaterThanOrEqual(44);
    expect(box.x + box.width, `${name} ends inside the screen`).toBeLessThanOrEqual(1180);
  }
  // One row: the primary sits level with the secondaries.
  const ys = await dock.getByRole("button").evaluateAll((bs) => bs.map((b) => Math.round(b.getBoundingClientRect().top)));
  expect(new Set(ys).size, "the dock stays on one row").toBe(1);
}

test.describe("order dock and Undo at 1180×820", () => {
  test.use({ viewport: { width: 1180, height: 820 } });

  test("Hold, Discount and Bill keep their names with unsent lines and after Send, and Send clears the Undo", async ({ page }) => {
    test.setTimeout(240_000);
    await pairAndSignIn(page, MANAGER_PIN);
    await newTakeaway(page);
    await page.getByRole("button", { name: /^Char Kway Teow,/ }).click();
    await expect(page.getByRole("button", { name: "Send 1 to kitchen" })).toBeVisible();
    for (const theme of ["day", "service"] as const) {
      await page.evaluate((t) => (t === "service" ? (document.documentElement.dataset.theme = "service") : delete document.documentElement.dataset.theme), theme);
      await namesOnScreen(page, ["Hold", "Discount", "Bill"]);
    }
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Send 1 to kitchen" }).click();
    await expect(page.getByText("Sent to the kitchen")).toBeVisible();
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
    await namesOnScreen(page, ["Discount", "Bill"]);
    const order = page.getByRole("region", { name: "Order" });
    await expect(order.getByText("Char Kway Teow")).toBeVisible();
    await expect(order.getByText(/Voided/)).toHaveCount(0);
  });
});
