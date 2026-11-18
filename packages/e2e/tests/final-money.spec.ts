import type { Page } from "@playwright/test";
import { API, devLocal, expect, GUEST, pairAndSignIn, register, SG_ADMIN, shot, test, WEB } from "./fixtures";

/**
 * Final review round, money (`fix/final-money`): the screens of what is charged, owed and told to the guest. The
 * register's figures are held by `server/test/final-money.test.ts`; these check what the POS, the back office and the
 * phone show of them, and take the shots for the report (both themes where the screen has two).
 */
const MANAGER_PIN = "222222";
const out = (name: string) => (process.env.FINAL_SHOTS ? `${process.env.FINAL_SHOTS}/${name}` : test.info().outputPath(name));

async function bothThemes(page: Page, name: string, target?: Parameters<typeof shot>[0]) {
  for (const theme of ["day", "service"] as const) {
    await page.evaluate((t) => (t === "service" ? (document.documentElement.dataset.theme = "service") : delete document.documentElement.dataset.theme), theme);
    await page.waitForTimeout(150);
    await shot(target ?? page, out(`${name}-${theme}.png`));
  }
  await page.evaluate(() => delete document.documentElement.dataset.theme);
}

/** A dine-in order on a free table with one Kopi, and a guest's QR round on it waiting for acceptance. */
async function tableWithWaitingRound() {
  const { outletId, brandId } = devLocal();
  const products = await register<{ data: { id: string; name: string }[] }>("GET", "/v1/products?limit=50");
  const kopi = products.data.find((p) => p.name === "Kopi")!;
  const floor = await register<{ data: { tables: { id: string; name: string; area_id: string; order: unknown }[] } }>("GET", `/v1/outlets/${outletId}/floor`);
  // A free table in the area the POS floor opens on, so its button is on screen.
  const area = floor.data.tables[0]!.area_id;
  const table = floor.data.tables.find((t) => !t.order && t.area_id === area) ?? floor.data.tables.find((t) => !t.order)!;
  const order = await register<{ data: { id: string; order_no: string } }>("POST", "/v1/orders", { order_id: crypto.randomUUID(), order_type: "dine_in", table_id: table.id, pax: 2, outlet_id: outletId, brand_id: brandId });
  await register("POST", `/v1/orders/${order.data.id}/lines`, { lines: [{ line_id: crypto.randomUUID(), product_id: kopi.id, quantity: 1 }] });
  await register("POST", `/v1/orders/${order.data.id}/fire`, {});
  const qr = await register<{ data: { url: string } }>("POST", `/v1/tables/${table.id}/qr/rotate`, {});
  const token = qr.data.url.split("/t/")[1]!;
  const session = await (await fetch(`${API}/v1/guest/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, device_id: `final-money-${crypto.randomUUID()}` }) })).json();
  const guest = session.data.guest_token as string;
  const r = await fetch(`${API}/v1/guest/rounds`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${guest}`, "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ round_id: crypto.randomUUID(), lines: [{ line_id: crypto.randomUUID(), product_id: kopi.id, quantity: 2 }] }) });
  expect(r.status, await r.clone().text()).toBe(201);
  return { order: order.data, table, token, guest };
}

/**
 * Leave nothing behind for the other specs: the order sent, paid and completed (its table free), and its kitchen
 * tickets bumped off the display.
 */
async function settle(orderId: string) {
  const rounds = await register<{ data: { id: string; order_id: string }[] }>("GET", `/v1/outlets/${devLocal().outletId}/rounds?status=pending`);
  for (const r of rounds.data.filter((x) => x.order_id === orderId)) await register("POST", `/v1/rounds/${r.id}/reject`, { reason: "Test over" }).catch(() => undefined);
  const o = await register<{ data: { status: string; checks: { id: string; balance: number }[] } }>("GET", `/v1/orders/${orderId}`);
  if (o.data.status !== "completed" && o.data.status !== "cancelled") {
    await register("POST", `/v1/orders/${orderId}/fire`, {}).catch(() => undefined);
    const tenders = await register<{ data: { id: string; is_cash: boolean; provider?: string | null }[] }>("GET", "/v1/tender-types");
    const byHand = tenders.data.find((t) => !t.is_cash && !t.provider)!;
    const now = await register<{ data: { checks: { id: string; balance: number }[] } }>("GET", `/v1/orders/${orderId}`);
    for (const c of now.data.checks.filter((x) => x.balance > 0)) await register("POST", `/v1/checks/${c.id}/payments`, { payment_id: crypto.randomUUID(), tender_type_id: byHand.id, amount: c.balance });
    await register("POST", `/v1/orders/${orderId}/complete`, {}).catch(() => undefined);
  }
  const tickets = await register<{ data: { id: string; order_id: string }[] }>("GET", `/v1/outlets/${devLocal().outletId}/kitchen-tickets`);
  for (const t of tickets.data.filter((x) => x.order_id === orderId)) await register("POST", `/v1/kitchen-tickets/${t.id}/bump`, {}).catch(() => undefined);
}

async function openTable(page: Page, tableName: string) {
  await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Floor", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(`^Table ${tableName},`) }).first().click();
}

test("M1: a waiting QR order is on no bill; Pay asks about it first, and Accept puts it on the bill", async ({ page }) => {
  test.setTimeout(300_000);
  const { order, table } = await tableWithWaitingRound();
  const before = await register<{ data: { balance: number } }>("GET", `/v1/orders/${order.id}`);
  await pairAndSignIn(page, MANAGER_PIN);
  await openTable(page, table.name);
  const panel = page.getByRole("region", { name: "Order" });
  await expect(panel.getByText("QR order waiting")).toBeVisible();
  await bothThemes(page, "M1-order-waiting");
  await page.getByRole("button", { name: /^Pay / }).first().click();
  const sheet = page.getByRole("dialog", { name: "A QR order is waiting" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("its items are not on the bill until you accept them", { exact: false })).toBeVisible();
  await bothThemes(page, "M1-waiting-sheet");
  await sheet.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(panel.getByText("QR order waiting")).toHaveCount(0);
  await expect.poll(async () => (await register<{ data: { balance: number } }>("GET", `/v1/orders/${order.id}`)).data.balance).toBeGreaterThan(before.data.balance);
  await settle(order.id);
});

test("M8: rejecting a QR order as Sold out asks which of its items are sold out", async ({ page }) => {
  test.setTimeout(300_000);
  const { table, order } = await tableWithWaitingRound();
  test.info().annotations.push({ type: "order", description: order.id });
  await pairAndSignIn(page, MANAGER_PIN);
  await openTable(page, table.name);
  await page.getByRole("region", { name: "Order" }).getByRole("button", { name: "Reject", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Reject QR order" });
  await sheet.getByRole("button", { name: "Sold out", exact: true }).click();
  // The round has one item, so it is ticked; with more, none would be (final2 C-2).
  const choice = sheet.getByRole("group", { name: "Which items are sold out?" });
  await expect(choice.getByRole("checkbox", { name: "Kopi" })).toBeChecked();
  await bothThemes(page, "M8-reject-sheet");
  // Unticked and another reason chosen here, so the demo's Kopi stays on sale for the other specs.
  await choice.getByText("Kopi").click();
  await expect(choice.getByRole("checkbox", { name: "Kopi" })).not.toBeChecked();
  await sheet.getByRole("button", { name: "Choose another reason" }).click();
  await sheet.getByRole("button", { name: "Kitchen is closing" }).click();
  await expect(sheet).toHaveCount(0);
  await settle(order.id);
});

test("M2, M16, M20: the POS Z-report gives each tender's net and how the payments come to the sales", async ({ page }) => {
  test.setTimeout(300_000);
  await pairAndSignIn(page, MANAGER_PIN);
  await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Shift", exact: true }).click();
  await page.getByRole("group", { name: "Shift section" }).getByRole("button", { name: "Z-report" }).click();
  await expect(page.getByRole("heading", { name: "Z-report" })).toBeVisible();
  await page.getByRole("group", { name: "Report scope" }).getByRole("button", { name: "Whole outlet" }).click();
  await page.waitForTimeout(500);
  await bothThemes(page, "M2-pos-z-report");
});

test("M2, M3, M11: the back office Z-report, Today and the order drawer", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto(`${WEB}/login`);
  await expect(async () => {
    await page.getByLabel("Email").fill(SG_ADMIN);
    await page.getByLabel("Password").fill(devLocal().admin_password);
    await page.getByRole("button", { name: "Sign in" }).click({ timeout: 10_000 });
    await page.waitForURL(`${WEB}/today`, { timeout: 30_000 });
  }).toPass({ timeout: 300_000 });
  await expect(page.getByText(/^Business day /).first()).toBeVisible();
  await page.waitForTimeout(800);
  await shot(page, out("M3-today.png"));
  await page.goto(`${WEB}/reports/z-report`);
  await expect(page.getByRole("heading", { name: "Payments", exact: true })).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: out("M2-office-z-report.png"), fullPage: true });
  const { outletId, brandId } = devLocal();
  const kopi = (await register<{ data: { id: string; name: string }[] }>("GET", "/v1/products?limit=50")).data.find((p) => p.name === "Kopi")!;
  const o = await register<{ data: { id: string; order_no: string; checks: { id: string }[]; balance: number } }>("POST", "/v1/orders", { order_id: crypto.randomUUID(), order_type: "takeaway", takeaway_ref: "Final money", outlet_id: outletId, brand_id: brandId });
  const withLine = await register<{ data: { checks: { id: string }[]; balance: number } }>("POST", `/v1/orders/${o.data.id}/lines`, { lines: [{ line_id: crypto.randomUUID(), product_id: kopi.id, quantity: 2 }] });
  const tenders = await register<{ data: { id: string; is_cash: boolean; provider?: string | null }[] }>("GET", "/v1/tender-types");
  await register("POST", `/v1/checks/${withLine.data.checks[0]!.id}/payments`, { payment_id: crypto.randomUUID(), tender_type_id: tenders.data.find((t) => !t.is_cash && !t.provider)!.id, amount: withLine.data.balance });
  await register("POST", `/v1/orders/${o.data.id}/fire`, {});
  await settle(o.data.id);
  await page.goto(`${WEB}/orders`);
  await page.getByRole("grid").getByRole("row").filter({ hasText: o.data.order_no }).first().click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByText("Totals")).toBeVisible();
  await page.waitForTimeout(500);
  await shot(page, out("M11-drawer.png"));
  await drawer.getByText("Audit").scrollIntoViewIfNeeded();
  await shot(page, out("M11-drawer-audit.png"));
});

test("M10: a paid table thanks the guest; the menu banner follows the round's real state", async ({ browser }) => {
  test.setTimeout(300_000);
  const { order, token } = await tableWithWaitingRound();
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await phone.goto(`${GUEST}/t/${token}`);
  await phone.getByRole("button", { name: /^Kopi,/ }).click({ timeout: 120_000 });
  await phone.getByRole("dialog", { name: "Kopi" }).getByRole("button", { name: /^Add to order/ }).click();
  await phone.getByRole("button", { name: /^View your order, 1 item/ }).click();
  await phone.getByRole("button", { name: /^Send/ }).first().click();
  await expect(phone.getByRole("heading", { name: "Order sent" })).toBeVisible();
  await phone.getByRole("button", { name: /^Back to the menu|^Menu/ }).first().click().catch(() => undefined);
  await phone.goto(`${GUEST}/t/${token}`);
  const rounds = await register<{ data: { id: string; order_id: string }[] }>("GET", `/v1/outlets/${devLocal().outletId}/rounds?status=pending`);
  for (const r of rounds.data.filter((x) => x.order_id === order.id)) await register("POST", `/v1/rounds/${r.id}/reject`, { reason: "Sold out" });
  // The menu's banner says the round was not accepted, not "Sent".
  await expect(phone.getByText("Your order · Not accepted")).toBeVisible({ timeout: 30_000 });
  await shot(phone, out("M10-guest-banner.png"));
  const tenders = await register<{ data: { id: string; is_cash: boolean; provider?: string | null }[] }>("GET", "/v1/tender-types");
  const byHand = tenders.data.find((t) => !t.is_cash && !t.provider)!;
  const o = await register<{ data: { balance: number; checks: { id: string }[] } }>("GET", `/v1/orders/${order.id}`);
  await register("POST", `/v1/checks/${o.data.checks[0]!.id}/payments`, { payment_id: crypto.randomUUID(), tender_type_id: byHand.id, amount: o.data.balance });
  await expect(phone.getByText("Your bill is paid.")).toBeVisible({ timeout: 30_000 });
  await shot(phone, out("M10-guest-paid.png"));
  await phone.close();
  await settle(order.id);
});
