import { devLocal, expect, GUEST, pairAndSignIn, register, test, textContrast } from "./fixtures";

const SERVER_PIN = "444444"; // Sam Server accepts QR orders

test("guest: a QR order from the table arrives on the POS, is accepted, and shows on the phone under its round", async ({ browser, page, watch }) => {
  test.setTimeout(300_000);
  const { outletId, brandId } = devLocal();

  // Staff seat a free table and show its QR code (back-office steps, through the register).
  const floor = await register<{ data: { tables: { id: string; name: string; order: unknown }[] } }>("GET", `/v1/outlets/${outletId}/floor`);
  const table = floor.data.tables.find((t) => !t.order);
  if (!table) throw new Error("No free table left in the demo outlet");
  await register("POST", "/v1/orders", { order_id: crypto.randomUUID(), order_type: "dine_in", table_id: table.id, pax: 2, outlet_id: outletId, brand_id: brandId });
  const qr = await register<{ data: { url: string } }>("POST", `/v1/tables/${table.id}/qr/rotate`, {});
  const token = qr.data.url.split("/t/")[1]!;

  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  watch.attach(phone);

  await test.step("the guest opens the menu: no open-price item, readable names", async () => {
    await phone.goto(`${GUEST}/t/${token}`);
    await expect(phone.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(phone.getByRole("button", { name: /^Laksa,/ })).toBeVisible();
    await expect(phone.getByRole("button", { name: /^Open item,/ })).toHaveCount(0);
    const { ratio, color, background } = await textContrast(phone, 'button[aria-label^="Laksa,"] .font-display');
    expect(ratio, `menu item name ${color} on ${background}`).toBeGreaterThanOrEqual(4.5);
  });

  await test.step("the guest orders Laksa with the default protein, and a Kopi", async () => {
    await phone.getByRole("button", { name: /^Laksa,/ }).click();
    const sheet = phone.getByRole("dialog", { name: "Laksa" });
    await expect(sheet.getByRole("radio", { name: /^Prawn/ })).toBeChecked();
    await sheet.getByRole("button", { name: /^Add to order/ }).click();
    await expect(sheet).toBeHidden();
    await phone.getByRole("button", { name: /^Kopi,/ }).click();
    await phone.getByRole("dialog", { name: "Kopi" }).getByRole("button", { name: /^Add to order/ }).click();
    await phone.getByRole("button", { name: /^Review 2 items/ }).click();
    await phone.getByRole("button", { name: /^Send/ }).first().click();
    await expect(phone.getByRole("heading", { name: "Order sent" })).toBeVisible();
  });

  await test.step("staff accept it from the POS Now rail", async () => {
    await pairAndSignIn(page, SERVER_PIN);
    const rail = page.getByRole("complementary", { name: "Now" });
    const item = rail.getByRole("listitem").filter({ hasText: `Table ${table.name} · QR order` }).first();
    await expect(item).toBeVisible();
    await item.getByRole("button", { name: "Accept" }).click();
    await expect(rail.getByText(`Table ${table.name} · QR order`)).toHaveCount(0);
  });

  await test.step("the phone shows the round accepted, its lines under the round and marked as the guest's", async () => {
    await expect(phone.getByRole("list", { name: "Order progress" })).toBeVisible();
    await phone.getByRole("button", { name: /^Our table/ }).click();
    const round = phone.getByRole("region", { name: /^Order sent / });
    await expect(round).toContainText("Laksa (Prawn)");
    await expect(round).toContainText("Kopi");
    await expect(phone.getByRole("region", { name: "Added by staff" })).toHaveCount(0);
  });
});
