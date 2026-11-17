import { devLocal, expect, GUEST, register, test } from "./fixtures";

/** Final review, front of house: the guest's phone, the POS floor and order screens, the kitchen display. */

async function seatedTableToken(): Promise<{ token: string; tableId: string; tableName: string }> {
  const { outletId, brandId } = devLocal();
  const floor = await register<{ data: { tables: { id: string; name: string; order: unknown }[] } }>("GET", `/v1/outlets/${outletId}/floor`);
  const table = floor.data.tables.find((t) => !t.order);
  if (!table) throw new Error("No free table left in the demo outlet");
  await register("POST", "/v1/orders", { order_id: crypto.randomUUID(), order_type: "dine_in", table_id: table.id, pax: 2, outlet_id: outletId, brand_id: brandId });
  const qr = await register<{ data: { url: string } }>("POST", `/v1/tables/${table.id}/qr/rotate`, {});
  return { token: qr.data.url.split("/t/")[1]!, tableId: table.id, tableName: table.name };
}

test("guest: the register's totals before sending, and the tax note from the first scan (C-6, C-7)", async ({ browser, watch }) => {
  test.setTimeout(240_000);
  const { token } = await seatedTableToken();
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  watch.attach(phone);
  await phone.goto(`${GUEST}/t/${token}`);

  await test.step("the price note says the GST is added, before anything is ordered", async () => {
    await expect(phone.getByText("GST is added to your bill, with any service charge.")).toBeVisible();
  });

  await test.step("the item sheet carries the line's total: Laksa with prawn, two of them", async () => {
    await phone.getByRole("button", { name: /^Laksa,/ }).click();
    const sheet = phone.getByRole("dialog", { name: "Laksa" });
    await expect(sheet.getByRole("button", { name: "Add to order · $18.00" })).toBeVisible();
    await sheet.getByRole("button", { name: "More quantity" }).click();
    await expect(sheet.getByRole("button", { name: "Add 2 to order · $36.00" })).toBeVisible();
    await sheet.getByRole("button", { name: /^Add 2 to order/ }).click();
    await expect(sheet).toBeHidden();
    await phone.getByRole("button", { name: /^Kopi,/ }).click();
    await phone.getByRole("dialog", { name: "Kopi" }).getByRole("button", { name: "Add to order · $1.80" }).click();
  });

  await test.step("the cart bar and the review show the register's total; the review each line's amount", async () => {
    const bar = phone.getByRole("button", { name: "View your order, 3 items, $37.80" });
    await expect(bar).toBeVisible();
    await bar.click();
    const items = phone.getByRole("list", { name: "Your items" });
    await expect(items.getByRole("listitem").filter({ hasText: "Laksa" }).first()).toContainText("$36.00");
    await expect(items.getByRole("listitem").filter({ hasText: "Kopi" }).first()).toContainText("$1.80");
    await expect(phone.getByText("Total", { exact: true })).toBeVisible();
    await expect(phone.locator("main")).toContainText("$37.80");
    await expect(phone.getByText("GST is added to your bill, with any service charge.")).toBeVisible();
  });

  await test.step("after sending, the table shows the same amounts for those lines", async () => {
    await phone.getByRole("button", { name: /^Send 3 items/ }).click();
    await expect(phone.getByRole("heading", { name: "Order sent" })).toBeVisible();
    await phone.getByRole("button", { name: /^Our table/ }).click();
    const round = phone.getByRole("region", { name: /^Order sent / });
    await expect(round).toContainText("$36.00");
    await expect(round).toContainText("$1.80");
  });
});
