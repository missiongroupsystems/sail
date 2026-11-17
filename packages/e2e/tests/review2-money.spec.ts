import type { Page } from "@playwright/test";
import { devLocal, expect, leaveChecklistOpen, pairAndSignIn, register, shot, test } from "./fixtures";

/**
 * Second review round, money (`fix/review2-money`): what the POS shows of a reopen the register refuses, the invoice
 * from a closed order, and the drawer count. The figures are held by `server/test/review2-money.test.ts`.
 */
const CASHIER_PIN = "333333";
const out = (name: string) => (process.env.REVIEW2_SHOTS ? `${process.env.REVIEW2_SHOTS}/${name}` : test.info().outputPath(name));

async function bothThemes(page: Page, name: string) {
  for (const theme of ["day", "service"] as const) {
    await page.evaluate((t) => (t === "service" ? (document.documentElement.dataset.theme = "service") : delete document.documentElement.dataset.theme), theme);
    await page.waitForTimeout(150);
    await shot(page, out(`${name}-${theme}.png`));
  }
  await page.evaluate(() => delete document.documentElement.dataset.theme);
}

type Order = { id: string; order_no: string; status: string; checks: { id: string; balance: number; invoice_no: string | null }[] };

/** A takeaway order with one Kopi, sent, and paid on the card terminal (the simulator approves it), so it is completed. */
async function paidOnTerminal(): Promise<Order> {
  const { outletId, brandId } = devLocal();
  const products = await register<{ data: { id: string; name: string }[] }>("GET", "/v1/products?limit=50");
  const kopi = products.data.find((p) => p.name === "Kopi")!;
  const tenders = await register<{ data: { id: string; provider?: string | null }[] }>("GET", "/v1/tender-types");
  const terminal = tenders.data.find((t) => t.provider)!;
  const o = await register<{ data: Order }>("POST", "/v1/orders", { order_id: crypto.randomUUID(), order_type: "takeaway", takeaway_ref: "R2", outlet_id: outletId, brand_id: brandId });
  const s = await register<{ data: Order }>("POST", `/v1/orders/${o.data.id}/lines`, { lines: [{ line_id: crypto.randomUUID(), product_id: kopi.id, quantity: 1 }] });
  await register("POST", `/v1/orders/${o.data.id}/fire`, {});
  await register("POST", `/v1/checks/${s.data.checks[0]!.id}/payment-intents`, { intent_id: crypto.randomUUID(), tender_type_id: terminal.id, amount: s.data.checks[0]!.balance });
  await expect.poll(async () => (await register<{ data: Order }>("GET", `/v1/orders/${o.data.id}`)).data.status, { timeout: 30_000 }).toBe("completed");
  return (await register<{ data: Order }>("GET", `/v1/orders/${o.data.id}`)).data;
}

/** Leave no kitchen ticket behind for the other specs. */
async function bumpTickets(orderId: string) {
  const tickets = await register<{ data: { id: string; order_id: string }[] }>("GET", `/v1/outlets/${devLocal().outletId}/kitchen-tickets`);
  for (const t of tickets.data.filter((x) => x.order_id === orderId)) await register("POST", `/v1/kitchen-tickets/${t.id}/bump`, {}).catch(() => undefined);
}

async function openClosedOrder(page: Page, orderNo: string) {
  await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Orders", exact: true }).click();
  await page.getByRole("group", { name: "Which orders" }).getByRole("button", { name: /^Today's closed/ }).click();
  await page.getByRole("button", { name: new RegExp(`^Takeaway ${orderNo},`) }).click();
}

test("N3: Orders → Today's closed → a terminal-paid order → Reopen says why at once, with no reason and no PIN", async ({ page, watch }) => {
  test.setTimeout(300_000);
  watch.allow({ status: 422, url: /\/v1\/orders\/[^/]+\/reopen$/, why: "the sheet's dry run: the register refuses to reopen a terminal-paid order, and the sheet says so" });
  const order = await paidOnTerminal();
  await pairAndSignIn(page, CASHIER_PIN);
  await openClosedOrder(page, order.order_no);
  await page.getByRole("region", { name: "Order" }).getByRole("button", { name: /^Reopen/ }).first().click();
  const sheet = page.getByRole("dialog", { name: "This order cannot be reopened" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("This order was paid on a card terminal, so it cannot be reopened")).toBeVisible();
  await expect(sheet.getByText(/Void the terminal payment/)).toBeVisible();
  // Nothing to choose, nothing to approve, and no word of reversing a payment the register will not reverse.
  await expect(page.getByRole("dialog").getByRole("button", { name: "Wrong items" })).toHaveCount(0);
  await expect(page.getByText(/reverses its payment/)).toHaveCount(0);
  await expect(page.getByRole("group", { name: "PIN keys" })).toHaveCount(0);
  await bothThemes(page, "N3-reopen-refused");
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);

  // N8: on the same closed order, Get invoice issues the invoice and opens its PDF.
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Get invoice", exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/^INV-\d+\.pdf$/);
  await expect(page.getByRole("button", { name: /^Invoice INV-\d+ · PDF$/ })).toBeVisible();
  await bothThemes(page, "N8-closed-order-invoice");
  const again = page.waitForEvent("download");
  await page.getByRole("button", { name: /^Invoice INV-\d+ · PDF$/ }).click();
  expect((await again).suggestedFilename()).toMatch(/^INV-\d+\.pdf$/);
  await bumpTickets(order.id);
});

test("N9: the drawer count's fields take what is typed, not what is typed after a 0", async ({ page }) => {
  test.setTimeout(300_000);
  await pairAndSignIn(page, CASHIER_PIN);
  await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Shift", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^(Open shift|Shift open)$/ })).toBeVisible();
  // A float the count below comes to exactly, so the close has no variance; opened here, so closed here too.
  const float = page.getByRole("textbox", { name: "Opening float" });
  const opened = await float.isVisible().catch(() => false);
  if (opened) {
    if (await page.getByRole("button", { name: "One total" }).isVisible().catch(() => false)) await page.getByRole("button", { name: "One total" }).click();
    await float.fill("32.00");
    await page.getByRole("button", { name: "Open shift with $32.00" }).click();
    await expect(page.getByRole("heading", { name: "Shift open" })).toBeVisible();
  }
  await page.getByRole("button", { name: "Close shift", exact: true }).click();
  await leaveChecklistOpen(page);
  await page.getByRole("button", { name: /^Next: count the cash/ }).click();
  await page.getByRole("button", { name: "Count notes and coins" }).click();
  // Tap a field and type, as on the iPad: the "0" does not stay in front of the digit.
  for (const [label, digit] of [["$10 count", "3"], ["$1 count", "2"]] as const) {
    const field = page.getByRole("textbox", { name: label });
    await expect(field).toHaveValue("");
    await field.click();
    await page.keyboard.type(digit);
    await expect(field).toHaveValue(digit);
  }
  // A field with a count is selected when tapped again, so typing replaces it.
  const tens = page.getByRole("textbox", { name: "$10 count" });
  await tens.click();
  await page.waitForTimeout(100);
  await page.keyboard.type("3");
  await expect(tens).toHaveValue("3");
  await bothThemes(page, "N9-count");
  if (opened) {
    await page.getByRole("button", { name: /^Close shift · counted \$32\.00/ }).click();
    await expect(page.getByRole("heading", { name: "Shift closed" })).toBeVisible();
  } else {
    await page.getByRole("button", { name: "Back to the checklist" }).click();
    await page.getByRole("button", { name: "Not now" }).click();
  }
});
