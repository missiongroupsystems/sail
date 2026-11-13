import type { Page } from "@playwright/test";
import { devLocal, expect, GUEST, pairAndSignIn, register, SG_ADMIN, test, WEB } from "./fixtures";

const CASHIER_PIN = "333333";

/**
 * Round three of the comparison findings: each test holds a fix to the behaviour it gives. The finding's file and
 * number (compare2/office.md item 1 is "office 1") are in the test's name.
 */

async function officeSignIn(page: Page) {
  await page.goto(`${WEB}/login`);
  await expect(async () => {
    await page.getByLabel("Email").fill(SG_ADMIN);
    await page.getByLabel("Password").fill(devLocal().admin_password);
    await page.getByRole("button", { name: "Sign in" }).click({ timeout: 10_000 });
    await page.waitForURL(`${WEB}/today`, { timeout: 30_000 });
  }).toPass({ timeout: 300_000 });
}

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("office 1: a table wider than the phone fades at its right edge, so it reads as one that scrolls", async ({ page }) => {
    test.setTimeout(300_000);
    await officeSignIn(page);
    await page.goto(`${WEB}/audit`);
    const table = page.getByRole("grid").first();
    await expect(table).toBeVisible();
    const scroller = table.locator("xpath=..");
    await expect.poll(() => scroller.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    // The fade's CSS was never generated (its classes lived where the stylesheet did not look): the mask read "none".
    // It is measured after the rows render, so it is polled.
    await expect.poll(() => scroller.evaluate((el) => getComputedStyle(el).maskImage)).toContain("linear-gradient");
  });
});

test.describe("iPad landscape, small", () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test("pos-2 1, guest-sizes 1: the float is one field, Open shift waits for it, and the count's Close shift stays on screen", async ({ page }) => {
    test.setTimeout(300_000);
    await pairAndSignIn(page, CASHIER_PIN);
    await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Shift", exact: true }).click();
    await expect(page.getByRole("heading", { name: /^(Open shift|Shift open)$/ })).toBeVisible();
    const open = page.getByRole("button", { name: /^Open shift/ });
    const float = page.getByRole("textbox", { name: "Opening float" });
    // A shift left open by an earlier spec shows its summary instead; this check is for the closed state only.
    if (await float.isVisible().catch(() => false)) {
      await float.fill("");
      await expect(open).toBeDisabled();
      await float.fill("50.00");
      await expect(page.getByRole("button", { name: "Open shift with $50.00" })).toBeEnabled();
      await page.getByRole("button", { name: "Open shift with $50.00" }).click();
    }
    await page.getByRole("button", { name: "Close shift", exact: true }).click();
    for (const leave of await page.getByRole("list", { name: "Before closing" }).getByRole("button", { name: "Leave open" }).all()) await leave.click();
    await page.getByRole("button", { name: /^Next: count the cash/ }).click();
    const counted = page.getByRole("textbox", { name: "Cash counted in the drawer" });
    await expect(counted).toBeInViewport({ ratio: 1 });
    await counted.fill("50.00");
    await expect(page.getByRole("button", { name: /^Close shift · counted \$50\.00/ })).toBeInViewport({ ratio: 1 });
    // Leave the drawer as found: close it (a short count asks for a reason).
    await page.getByRole("button", { name: /^Close shift · counted/ }).click();
    const reason = page.getByRole("group", { name: "Reason" });
    if (await reason.isVisible({ timeout: 5000 }).catch(() => false)) {
      await reason.getByRole("button").first().click();
      await page.getByRole("button", { name: "Close shift", exact: true }).click();
    }
    await expect(page.getByRole("heading", { name: "Shift closed" })).toBeVisible();
  });

  test("guest-sizes 2, pos-1 1: no bill runs off the right edge, and the order dock is one row with Send at its end", async ({ page }) => {
    test.setTimeout(300_000);
    await pairAndSignIn(page, CASHIER_PIN);
    await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Floor", exact: true }).click();
    await page.getByRole("button", { name: "Takeaway order", exact: true }).click();
    await page.getByRole("button", { name: /^Mee Goreng,/ }).click();
    await expect(page.getByRole("button", { name: "Send 1 to kitchen" })).toBeVisible();
    await page.getByRole("button", { name: /^Chicken Rice,/ }).click();
    const dock = page.getByRole("toolbar", { name: "Order actions" });
    const send = dock.getByRole("button", { name: "Send 2 to kitchen" });
    const hold = dock.getByRole("button", { name: /Hold/ });
    const [s, h] = [await send.boundingBox(), await hold.boundingBox()];
    expect(Math.abs(s!.y - h!.y), "Send and Hold on one row").toBeLessThan(4);
    expect(s!.x).toBeGreaterThan(h!.x);
    await send.click();
    await page.getByRole("button", { name: "Bill", exact: true }).click();
    await page.getByRole("group", { name: "Split mode" }).getByRole("button", { name: "By item", exact: true }).click();
    await expect(page.getByRole("region", { name: "Bill 2" })).toBeVisible();
    for (const bill of await page.getByRole("region", { name: /^Bill \d/ }).all()) {
      const box = (await bill.boundingBox())!;
      expect(box.x + box.width, "bill inside the screen").toBeLessThanOrEqual(1024);
    }
    await page.getByRole("group", { name: "Split mode" }).getByRole("button", { name: "One bill", exact: true }).click();
  });
});

test.describe("guest phone", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("guest-sizes 11: the menu search finds items by name from the loaded menu, and Call staff stays", async ({ page }) => {
    test.setTimeout(300_000);
    const { outletId } = devLocal();
    const floor = await register<{ data: { tables: { id: string; order: unknown }[] } }>("GET", `/v1/outlets/${outletId}/floor`);
    const table = floor.data.tables.filter((t) => !t.order).at(-1)!;
    const qr = await register<{ data: { url: string } }>("POST", `/v1/tables/${table.id}/qr/rotate`, {});
    await page.goto(`${GUEST}/t/${qr.data.url.split("/t/")[1]!}`);
    // The table is not seated, so the menu is to browse (rows, not buttons); search works the same.
    const main = page.getByRole("main");
    await expect(main.getByText("Laksa", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Call staff" })).toBeVisible();
    await page.getByRole("button", { name: "Search the menu" }).click();
    await page.getByRole("searchbox", { name: "Search the menu" }).fill("lak");
    await expect(page.getByRole("region", { name: "Search results" }).getByText("Laksa", { exact: true })).toBeVisible();
    await expect(main.getByText("Kopi", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Close search" }).click();
    await expect(main.getByText("Kopi", { exact: true }).first()).toBeVisible();
  });
});
