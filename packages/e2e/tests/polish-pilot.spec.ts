import type { Page } from "@playwright/test";
import { devDatabase, devLocal, expect, pairAndSignIn, register, SG_ADMIN, test, WEB } from "./fixtures";

/**
 * The polish round before the first pilot outlet is set up: what the team hit in the walkthrough of 18 November.
 * Each test names the item it covers (A1 to A8 in the round's plan).
 */

const CASHIER_PIN = "333333"; // Cal Cashier (dev seed)

/** Orders this file opened through the API: cancelled after each test, so tables and lists are as the later specs expect. */
const opened: string[] = [];
test.afterEach(async () => {
  for (const orderId of opened.splice(0)) await register("POST", `/v1/orders/${orderId}/cancel`, { reason: "End-to-end test" }).catch(() => undefined);
});

/** Sign in to the back office as the seeded Admin; done once Today has rendered, so the next navigation is not cut short. */
async function signIn(page: Page) {
  await page.goto(`${WEB}/login`);
  await expect(async () => {
    await page.getByLabel("Email").fill(SG_ADMIN);
    await page.getByLabel("Password").fill(devLocal().admin_password);
    await page.getByRole("button", { name: "Sign in" }).click({ timeout: 10_000 });
    await page.waitForURL(`${WEB}/today`, { timeout: 30_000 });
  }).toPass({ timeout: 300_000 });
}

/** Open a row's sheet. A click before the dev server's first compile has hydrated the page does nothing: press until it opens. */
async function openRow(page: Page, name: string) {
  const sheet = page.getByRole("dialog", { name });
  await expect(async () => {
    await page.getByRole("rowheader", { name }).click({ timeout: 5_000 });
    await expect(sheet).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 120_000 });
  return sheet;
}

test.describe("POS", () => {
  test.use({ viewport: { width: 1180, height: 820 } });

  test("A1: an order opened on the floor is under Orders, with a type filter, and moves to Today's closed once paid", async ({ page }) => {
    test.setTimeout(420_000);
    const { outletId, brandId } = devLocal();
    await pairAndSignIn(page, CASHIER_PIN);

    let tableName = "";
    await test.step("open a dine-in order on the floor and send it", async () => {
      await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Floor", exact: true }).click();
      const free = page.getByRole("button", { name: /^Table \S+, Free/ }).first();
      tableName = ((await free.getAttribute("aria-label")) ?? "").match(/^Table (\S+),/)![1]!;
      await free.click();
      await page.getByRole("button", { name: "2 guests", exact: true }).click();
      await page.getByRole("button", { name: /^Mee Goreng,/ }).click();
      await page.getByRole("button", { name: "Send 1 to kitchen" }).click();
      await expect(page.getByRole("region", { name: "Order" }).getByText(/^Sent /)).toBeVisible();
    });

    await test.step("a takeaway and a pickup order from the API", async () => {
      for (const body of [
        { order_type: "takeaway", takeaway_ref: "Polish takeaway" },
        { order_type: "pickup", customer_ref: { name: "Polish pickup" } },
      ]) {
        const orderId = crypto.randomUUID();
        await register("POST", "/v1/orders", { order_id: orderId, outlet_id: outletId, brand_id: brandId, ...body });
        opened.push(orderId);
      }
    });

    const which = page.getByRole("group", { name: "Which orders" });
    const types = page.getByRole("group", { name: "Order type" });
    const rows = page.getByRole("button", { name: /^(Dine-in|Takeaway|Pickup|Delivery) \S+.*, (New|Sent|Ready|Out for delivery|Done|Cancelled)$/ });
    const dineIn = page.getByRole("button", { name: /^Dine-in / }).filter({ hasText: `Table ${tableName} · Dine-in` });

    await test.step("Orders → Open lists the table's order; All is chosen", async () => {
      await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Orders", exact: true }).click();
      await expect(types.getByRole("button", { name: /^All/ })).toHaveAttribute("aria-pressed", "true");
      await expect(dineIn).toBeVisible();
      await expect(page.getByRole("button", { name: /^Takeaway / }).filter({ hasText: "Takeaway" }).first()).toBeVisible();
      await expect(page.getByRole("button", { name: /^Pickup .*Polish pickup/ })).toBeVisible();
    });

    await test.step("each filter shows only its type", async () => {
      for (const [label, type] of [["Dine-in", "Dine-in"], ["Takeaway", "Takeaway"], ["Pickup", "Pickup"]] as const) {
        await types.getByRole("button", { name: new RegExp(`^${label}`) }).click();
        await expect(rows.first()).toBeVisible();
        const names = await rows.evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? ""));
        expect(names.length, `${label}: rows`).toBeGreaterThan(0);
        for (const n of names) expect(n, `${label} filter`).toMatch(new RegExp(`^${type} `));
      }
      await types.getByRole("button", { name: /^Dine-in/ }).click();
      await expect(dineIn).toBeVisible();
      await expect(page.getByRole("button", { name: /^Pickup .*Polish pickup/ })).toHaveCount(0);
      await types.getByRole("button", { name: /^All/ }).click();
    });

    await test.step("pay the table by card: it leaves Open and is under Today's closed", async () => {
      await dineIn.click();
      await page.getByRole("button", { name: /^Pay \$/ }).click();
      await page.getByRole("group", { name: "Payment method" }).getByRole("button", { name: "Card", exact: true }).click();
      await page.getByRole("button", { name: /^Take .+ by Card$/ }).click();
      await expect(page.getByText(/^Paid · /)).toBeVisible();
      await page.getByRole("button", { name: "No receipt" }).click();
      await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Orders", exact: true }).click();
      await expect(which.getByRole("button", { name: /^Open/ })).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByRole("button", { name: /^Pickup .*Polish pickup/ })).toBeVisible();
      await expect(dineIn).toHaveCount(0);
      await which.getByRole("button", { name: /^Today's closed/ }).click();
      await types.getByRole("button", { name: /^Dine-in/ }).click();
      await expect(page.getByRole("button", { name: /^Dine-in .*, Done$/ }).filter({ hasText: `Table ${tableName} · Dine-in` }).first()).toBeVisible();
    });
  });
});

test.describe("back office and POS together", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("A2: a POS station needs a brand; one saved without it says so on the iPad and in Settings, and works once it has one", async ({ page, browser, watch }) => {
    test.setTimeout(420_000);
    const { merchantId, outletId } = devLocal();
    const stamp = String(Date.now()).slice(-6);
    const old = { id: crypto.randomUUID(), name: `Old till ${stamp}` };
    const display = `Pass screen ${stamp}`;
    // No register call can save a POS station without a brand any more: the old state goes in as the row itself.
    const sql = devDatabase();
    await sql`insert into stations (id, merchant_id, outlet_id, name) values (${old.id}, ${merchantId}, ${outletId}, ${old.name})`;
    await sql.end();

    const ipad = await browser.newPage({ viewport: { width: 1180, height: 820 } });
    watch.attach(ipad);
    try {
      await test.step("the iPad paired to it shows one message in place of the screens", async () => {
        await pairAndSignIn(ipad, CASHIER_PIN, "sg", old.id);
        await expect(ipad.getByRole("heading", { name: "This station has no brand" })).toBeVisible();
        await expect(ipad.getByRole("main").getByRole("alert")).toHaveText("In the back office, open Settings › Stations and choose one.");
        await expect(ipad.getByRole("navigation", { name: "Destinations" })).toHaveCount(0);
      });

      await signIn(page);
      await page.goto(`${WEB}/settings/stations`);

      await test.step("Settings › Stations marks it; its sheet cannot be saved until a brand is chosen", async () => {
        await expect(page.getByRole("row", { name: new RegExp(old.name) })).toContainText("No brand · cannot take orders");
        const sheet = await openRow(page, old.name);
        await expect(sheet.getByRole("alert").filter({ hasText: "This station has no brand" })).toBeVisible();
        const brand = sheet.getByRole("button", { name: /Brand/ });
        await expect(brand).toContainText("Choose a brand");
        await sheet.getByRole("button", { name: "Save changes" }).click();
        await expect(sheet.getByText("Choose a brand", { exact: true }).last()).toBeVisible();
        await expect(sheet).toBeVisible();
        await brand.click();
        await expect(page.getByRole("option", { name: /Any brand/ })).toHaveCount(0);
        await page.getByRole("option").first().click();
        await sheet.getByRole("button", { name: "Save changes" }).click();
        await expect(sheet).toBeHidden();
        await expect(page.getByRole("row", { name: new RegExp(old.name) })).not.toContainText("cannot take orders");
      });

      await test.step("the iPad follows without a new sign-in", async () => {
        await expect(ipad.getByRole("navigation", { name: "Destinations" })).toBeVisible({ timeout: 30_000 });
        await expect(ipad.getByRole("heading", { name: "This station has no brand" })).toHaveCount(0);
      });

      await test.step("a kitchen display still saves without a brand", async () => {
        // The closing sheet keeps its own Add station for a moment; the page's button comes first.
        await page.getByRole("button", { name: "Add station" }).first().click();
        const sheet = page.getByRole("dialog", { name: "New station" });
        await sheet.getByLabel("Name").fill(display);
        await sheet.getByRole("button", { name: /Kind/ }).click();
        await page.getByRole("option", { name: /Kitchen display/ }).click();
        await expect(sheet.getByRole("button", { name: /Brand/ })).toHaveCount(0);
        await sheet.getByRole("button", { name: "Add station" }).click();
        await expect(sheet).toBeHidden();
        await expect(page.getByRole("row", { name: new RegExp(display) })).toContainText("Kitchen display");
      });
    } finally {
      await ipad.close();
      const all = await register<{ data: { id: string; name: string }[] }>("GET", `/v1/outlets/${outletId}/stations`);
      for (const s of all.data.filter((x) => x.name === old.name || x.name === display)) await register("PATCH", `/v1/stations/${s.id}`, { archived: true });
    }
  });
});
