import { devLocal, expect, pairAndSignIn, register, test } from "./fixtures";

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
