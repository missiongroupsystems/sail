import type { Page } from "@playwright/test";
import { devLocal, expect, GUEST, register, SG_ADMIN, shot, test, WEB } from "./fixtures";

/**
 * An order cancelled because its only QR round was rejected owes nothing: the guest's phone does not ask them to pay,
 * and the back office shows no unpaid bill and no refund control for it.
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

test("a QR round rejected on the order it opened: the phone asks for no payment, the back office shows no bill to pay or refund", async ({ browser, page, watch }) => {
  test.setTimeout(300_000);
  const { outletId } = devLocal();
  const links = await register<{ data: { id: string; channel: string; outlet_id: string; open_on_first_scan: boolean }[] }>("GET", "/v1/channel-links");
  const link = links.data.find((l) => l.channel === "scan_to_order" && l.outlet_id === outletId)!;
  await register("PATCH", `/v1/channel-links/${link.id}`, { open_on_first_scan: true });
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  watch.attach(phone);
  let orderId = "";
  let orderNo = "";
  try {
    const floor = await register<{ data: { tables: { id: string; order: unknown }[] } }>("GET", `/v1/outlets/${outletId}/floor`);
    const table = floor.data.tables.find((t) => !t.order)!;
    const qr = await register<{ data: { url: string } }>("POST", `/v1/tables/${table.id}/qr/rotate`, {});
    await phone.goto(`${GUEST}/t/${qr.data.url.split("/t/")[1]!}`);
    await phone.getByRole("button", { name: /^Kopi,/ }).click();
    await phone.getByRole("dialog", { name: "Kopi" }).getByRole("button", { name: /^Add to order/ }).click();
    await phone.getByRole("button", { name: /^View your order, 1 item/ }).click();
    await phone.getByRole("button", { name: /^Send/ }).first().click();
    await expect(phone.getByRole("heading", { name: "Order sent" })).toBeVisible();
    // Before the rejection something is owed, and the phone says how to pay.
    await expect(phone.getByText("Pay at the counter or ask your server for the bill.")).toBeVisible();

    const rounds = await register<{ data: { id: string; order_id: string }[] }>("GET", `/v1/outlets/${outletId}/rounds?status=pending`);
    const seated = await register<{ data: { tables: { id: string; order: { id: string; order_no: string } | null }[] } }>("GET", `/v1/outlets/${outletId}/floor`);
    const order = seated.data.tables.find((t) => t.id === table.id)!.order!;
    orderId = order.id;
    orderNo = order.order_no;
    const round = rounds.data.find((r) => r.order_id === orderId)!;
    await register("POST", `/v1/rounds/${round.id}/reject`, { reason: "Sold out" });

    await test.step("the phone: not accepted, Order more, and no pay prompt", async () => {
      await expect(phone.getByRole("heading", { name: "Order not accepted" })).toBeVisible();
      await expect(phone.getByRole("button", { name: /Order more/ }).first()).toBeVisible();
      await expect(phone.getByText("Pay at the counter or ask your server for the bill.")).toHaveCount(0);
      await shot(phone, test.info().outputPath("phone-status.png"));
      await phone.reload();
      await expect(phone.getByRole("heading", { name: "Order not accepted" })).toBeVisible();
      await expect(phone.getByText("Pay at the counter or ask your server for the bill.")).toHaveCount(0);
      await phone.getByRole("button", { name: /^Our table/ }).click();
      await expect(phone.getByText("Pay at the counter or ask your server for the bill.")).toHaveCount(0);
      await shot(phone, test.info().outputPath("phone-our-table.png"));
    });
  } finally {
    await phone.close();
    await register("PATCH", `/v1/channel-links/${link.id}`, { open_on_first_scan: link.open_on_first_scan });
  }

  await test.step("the back office drawer: cancelled, no unpaid bill, no Refund", async () => {
    const o = await register<{ data: { status: string; paid_total: number } }>("GET", `/v1/orders/${orderId}`);
    expect(o.data.status).toBe("cancelled");
    await officeSignIn(page);
    await page.goto(`${WEB}/orders`);
    await page.getByRole("grid").getByRole("row").filter({ hasText: orderNo }).first().click();
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByText("Totals", { exact: true })).toBeVisible();
    await expect(drawer.getByText("Unpaid", { exact: true })).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: /^Refund/ })).toHaveCount(0);
    // Its only round was turned down, so it never went to the kitchen (it read "0 rounds", as if nothing was sent).
    await expect(drawer.getByText(/^not sent to the kitchen$/)).toBeVisible();
    await expect(drawer.getByText(/\b\d+ rounds?\b/)).toHaveCount(0);
    await shot(page, test.info().outputPath("drawer.png"));
  });
});

test("a cancelled order whose payment was reversed still shows that bill and payment, not as Unpaid and with no Refund", async ({ page }) => {
  test.setTimeout(300_000);
  const { outletId, brandId } = devLocal();
  const products = await register<{ data: { id: string; name: string }[] }>("GET", "/v1/products?limit=50");
  const kopi = products.data.find((p) => p.name === "Kopi")!;
  const tenders = await register<{ data: { id: string; is_cash: boolean; provider?: string | null }[] }>("GET", "/v1/tender-types");
  const byHand = tenders.data.find((t) => !t.is_cash && !t.provider)!;
  const order = await register<{ data: { id: string; order_no: string } }>("POST", "/v1/orders", { order_id: crypto.randomUUID(), order_type: "takeaway", takeaway_ref: "Reversed then cancelled", outlet_id: outletId, brand_id: brandId });
  const added = await register<{ data: { balance: number; checks: { id: string }[]; lines: { id: string }[] } }>("POST", `/v1/orders/${order.data.id}/lines`, { lines: [{ line_id: crypto.randomUUID(), product_id: kopi.id, quantity: 1 }] });
  await register("POST", `/v1/orders/${order.data.id}/fire`, {});
  await register("POST", `/v1/checks/${added.data.checks[0]!.id}/payments`, { payment_id: crypto.randomUUID(), tender_type_id: byHand.id, amount: added.data.balance });
  // Paid in full after sending, the order completes on its own (live-round3 uses the same path).
  await register("POST", `/v1/orders/${order.data.id}/complete`, {}).catch(() => undefined);
  // Reopening reverses the payment; the sent line is voided, and then the order can be cancelled.
  await register("POST", `/v1/orders/${order.data.id}/reopen`, { reason: "Wrong order" });
  await register("POST", `/v1/orders/${order.data.id}/lines/${added.data.lines[0]!.id}/void`, { reason_text: "Kitchen error" });
  await register("POST", `/v1/orders/${order.data.id}/cancel`, { reason: "Customer left" });

  await officeSignIn(page);
  await page.goto(`${WEB}/orders`);
  await page.getByRole("grid").getByRole("row").filter({ hasText: order.data.order_no }).first().click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByText("Bill 1", { exact: true })).toBeVisible();
  await expect(drawer.getByText(/· reversed/)).toBeVisible();
  // Sent once is the usual case, so the header says nothing about it; it must not read as never sent.
  await expect(drawer.getByText(/not sent to the kitchen/)).toHaveCount(0);
  await expect(drawer.getByText("Unpaid", { exact: true })).toHaveCount(0);
  await expect(drawer.getByRole("button", { name: /^Refund/ })).toHaveCount(0);
  await drawer.getByText("Bill 1", { exact: true }).scrollIntoViewIfNeeded();
  await shot(page, test.info().outputPath("drawer-reversed.png"));
});
