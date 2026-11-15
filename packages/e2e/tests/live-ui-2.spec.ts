import type { Page } from "@playwright/test";
import { devLocal, expect, GUEST, keyIn, pairAndSignIn, register, test } from "./fixtures";

/**
 * Round two of the live-test and comparison findings: each test holds a fix to the behaviour it gives. The finding's
 * id is in the test's name.
 */

const CASHIER_PIN = "333333";
const SERVER_PIN = "444444";

test.use({ viewport: { width: 1180, height: 820 } });

async function takeaway(page: Page, item = /^Mee Goreng,/) {
  await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Floor", exact: true }).click();
  await page.getByRole("button", { name: "Takeaway order", exact: true }).click();
  await page.getByRole("button", { name: item }).click();
  await expect(page.getByRole("button", { name: "Send 1 to kitchen" })).toBeVisible();
}

/** Cash needs an open drawer: an outlet-wide shift for the test, closed again after it so later specs open their own. */
async function withShift<T>(fn: () => Promise<T>): Promise<T> {
  const { outletId } = devLocal();
  const shift = await register<{ data: { id: string } }>("POST", "/v1/shifts", { outlet_id: outletId, station_id: null, float_cents: 0 });
  try {
    return await fn();
  } finally {
    await register("POST", `/v1/shifts/${shift.data.id}/close`, { counted_cash_cents: 0, variance_reason: "End of an end-to-end test" }).catch(() => undefined);
  }
}

test("A-5: the browser's back stays in the POS and goes back one screen", async ({ page }) => {
  test.setTimeout(300_000);
  await pairAndSignIn(page, CASHIER_PIN);
  await takeaway(page);
  await page.goBack();
  await expect(page).toHaveURL(/\/pos$/);
  // One screen back: the takeaway's order closes for the list it belongs to; the POS is still there.
  await expect(page.getByRole("navigation", { name: "Destinations" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Order" })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Which orders" })).toBeVisible();
});

test("A-10, C-3: a cash note shows no change until the register has priced it; typed cash shows its change", async ({ page }) => {
  test.setTimeout(300_000);
  await withShift(async () => {
    await pairAndSignIn(page, CASHIER_PIN);
    await takeaway(page);
    await page.getByRole("button", { name: "Send 1 to kitchen" }).click();
    await page.getByRole("button", { name: /^Pay \$/ }).click();
    await page.getByRole("group", { name: "Payment method" }).getByRole("button", { name: "Cash", exact: true }).click();
    await expect(page.getByText("The register will record")).toBeVisible();
    // Hold the next dry run (the one for the note) on the wire: the last answer, for Exact, must not show as its change.
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    await page.route(/\/v1\/checks\/[^/]+\/payments$/, async (route) => {
      const body = route.request().postDataJSON() as { dry_run?: boolean; tendered?: number } | null;
      if (body?.dry_run && body.tendered) await held;
      await route.continue();
    });
    await page.getByRole("group", { name: "Cash given" }).getByRole("button").nth(1).click();
    await expect(page.getByText("Checking with the register…")).toBeVisible();
    await expect(page.getByText("Change to give")).toHaveCount(0);
    release();
    await expect(page.getByText("Change to give")).toBeVisible();
    await page.unroute(/\/v1\/checks\/[^/]+\/payments$/);
    // C-3: a typed amount of cash previews its change as the quick buttons do.
    await page.getByRole("button", { name: "Type the cash given" }).click();
    await keyIn(page, "Amount keys", "5000");
    await expect(page.getByRole("status").filter({ hasText: "Change to give" })).toContainText(/Change to give\s*\$\d/);
  });
});

test("B-F4, B-F13: a Server's cash payment asks for a Cashier's approval, as every other method does", async ({ page }) => {
  test.setTimeout(300_000);
  await withShift(async () => {
    await pairAndSignIn(page, SERVER_PIN);
    await takeaway(page);
    await page.getByRole("button", { name: "Send 1 to kitchen" }).click();
    await expect(page.getByRole("toolbar", { name: "Order actions" }).getByText("Cashier approval")).toBeVisible();
    await page.getByRole("button", { name: /^Pay \$/ }).click();
    await page.getByRole("group", { name: "Payment method" }).getByRole("button", { name: "Cash", exact: true }).click();
    // The register quotes a Server's dry run, so the take button is live and leads to the approval sheet.
    const take = page.getByRole("button", { name: /^Take \$[\d.,]+ cash/ });
    await expect(take).toBeEnabled();
    await take.click();
    await expect(page.getByRole("dialog", { name: "Cashier approval" })).toBeVisible();
    await page.keyboard.press("Escape");
  });
});

test("B-F7, B-F9: a partial void's approval names the part, and a typed reason stops at the register's 200 characters", async ({ page }) => {
  test.setTimeout(300_000);
  await pairAndSignIn(page, CASHIER_PIN);
  await takeaway(page);
  await page.getByRole("button", { name: /^Mee Goreng,/ }).click();
  await expect(page.getByRole("button", { name: "Send 2 to kitchen" })).toBeVisible().catch(async () => {
    await expect(page.getByRole("button", { name: "Send 1 to kitchen" })).toBeVisible();
  });
  // B-F9 on an unsent line first: Remove item, then the free-text reason.
  const order = page.getByRole("region", { name: "Order" });
  await order.getByRole("button", { name: /Mee Goreng/ }).first().click();
  const sheet = page.getByRole("dialog", { name: "Mee Goreng" });
  await sheet.getByRole("button", { name: /^Remove item/ }).click();
  const other = sheet.getByRole("group", { name: "Reason" }).getByRole("button", { name: /Type a reason|Other…/ });
  await other.click();
  const field = sheet.getByRole("textbox", { name: "Reason" });
  await field.fill("x".repeat(250));
  expect((await field.inputValue()).length).toBeLessThanOrEqual(200);
  await sheet.getByRole("button", { name: "Keep the line" }).click();
  await sheet.getByRole("button", { name: "Close" }).click();
  // B-F7: send two, void one of them, and the approval reads "1 of 2 · already sent" (no client-priced part).
  await page.getByRole("button", { name: /^Send \d to kitchen/ }).click();
  await expect(order.getByText(/^Sent /).first()).toBeVisible();
  await order.getByRole("button", { name: /Mee Goreng/ }).first().click();
  const sent = page.getByRole("dialog", { name: "Mee Goreng" });
  const qty = sent.getByRole("group", { name: /Quantity/ });
  if (await qty.getByRole("button", { name: /Decrease|Fewer|Less/ }).isEnabled()) {
    await qty.getByRole("button", { name: /Decrease|Fewer|Less/ }).click();
    await sent.getByRole("button", { name: /^Void item/ }).click();
    await sent.getByRole("group", { name: "Reason" }).getByRole("button").first().click();
    await expect(page.getByRole("dialog", { name: "Manager approval" })).toContainText(/1 of \d · already sent/);
  } else {
    await sent.getByRole("button", { name: /^Void item/ }).click();
    await sent.getByRole("group", { name: "Reason" }).getByRole("button").first().click();
    await expect(page.getByRole("dialog", { name: "Manager approval" })).toContainText(/already sent/);
  }
  await page.keyboard.press("Escape");
});

test("C-4: the close checklist says where the open orders are and View opens the list that has them", async ({ page }) => {
  test.setTimeout(300_000);
  await pairAndSignIn(page, CASHIER_PIN);
  await takeaway(page);
  await withShift(async () => {
    await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Shift", exact: true }).click();
    await page.getByRole("button", { name: "Close shift", exact: true }).click();
    const item = page.getByRole("list", { name: "Before closing" }).getByRole("listitem").filter({ hasText: /open order/ });
    await expect(item).toContainText(/in Orders/);
    await item.getByRole("button", { name: /View/ }).click();
    await expect(page.getByRole("group", { name: "Which orders" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Takeaway / }).first()).toBeVisible();
  });
});

test("guest 3–5, D-1: steppers in the cart, the sent banner and the table's totals; a long note never widens the page", async ({ browser }) => {
  test.setTimeout(300_000);
  const { outletId, brandId } = devLocal();
  const floor = await register<{ data: { tables: { id: string; name: string; order: unknown }[] } }>("GET", `/v1/outlets/${outletId}/floor`);
  const table = floor.data.tables.filter((t) => !t.order).at(-2)!;
  await register("POST", "/v1/orders", { order_id: crypto.randomUUID(), order_type: "dine_in", table_id: table.id, pax: 2, outlet_id: outletId, brand_id: brandId });
  const qr = await register<{ data: { url: string } }>("POST", `/v1/tables/${table.id}/qr/rotate`, {});
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await phone.goto(`${GUEST}/t/${qr.data.url.split("/t/")[1]!}`);
    await phone.getByRole("button", { name: /^Kopi,/ }).click();
    const item = phone.getByRole("dialog", { name: "Kopi" });
    await item.getByRole("textbox").fill(`no sugar ${"x".repeat(160)}`);
    await item.getByRole("button", { name: /^Add to order/ }).click();
    await phone.getByRole("button", { name: /^View your order, 1 item/ }).click();
    await phone.getByRole("group", { name: "Quantity of Kopi" }).getByRole("button", { name: /^More/ }).click();
    await phone.getByRole("button", { name: "Send 2 items to the kitchen" }).click();
    await expect(phone.getByRole("heading", { name: "Order sent" })).toBeVisible();
    const totals = phone.getByRole("region", { name: "Table total" });
    await expect(totals).toContainText("Subtotal");
    await expect(totals).toContainText("Table total");
    expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  } finally {
    await phone.close();
    // Leave the floor as found: the shift close in pos.spec lists QR orders waiting.
    const rounds = await register<{ data: { id: string }[] }>("GET", `/v1/outlets/${outletId}/rounds?status=pending`);
    for (const r of rounds.data) await register("POST", `/v1/rounds/${r.id}/reject`, { reason: "End of an end-to-end test" }).catch(() => undefined);
  }
});
