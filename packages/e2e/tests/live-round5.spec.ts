import type { Page } from "@playwright/test";
import { API, devLocal, expect, GUEST, pairAndSignIn, register, SG_ADMIN, signInToken, test, WEB } from "./fixtures";

/**
 * The fifth live test's findings that show on screen (tester S, `fa2dfd1`, "Other things noticed"). The finding's id
 * is in each test's name. M2 and M4 are also register findings: `server/test/live-round5.test.ts` and
 * `server/test/live-round5-receipt.test.ts`; M1 and M6 are also held by `ui` unit tests.
 */
const MANAGER_PIN = "222222";
const CASHIER_PIN = "333333";
const SERVER_PIN = "444444";

/** "$12.34" to cents. */
const cents = (text: string) => {
  const m = /\$([\d,]+)\.(\d\d)/.exec(text);
  if (!m) throw new Error(`no amount in "${text}"`);
  return Number(m[1]!.replace(/,/g, "")) * 100 + Number(m[2]);
};

async function officeSignIn(page: Page, email = SG_ADMIN, password = devLocal().admin_password) {
  await page.goto(`${WEB}/login`);
  await expect(async () => {
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click({ timeout: 10_000 });
    await page.waitForURL(`${WEB}/today`, { timeout: 30_000 });
  }).toPass({ timeout: 300_000 });
}

/** A back-office login for a new staff member of this role. */
async function loginFor(role: "manager") {
  const suffix = `${role}${String(Date.now()).slice(-6)}`;
  const email = `${suffix}@sail.local`;
  const password = `quiet harbour lantern ${String(Date.now()).slice(-4)} round`;
  const created = await register<{ data: { id: string } }>("POST", "/v1/staff", { name: `Round Five ${suffix}`, email, role });
  const link = await register<{ data: { url: string | null } }>("POST", `/v1/staff/${created.data.id}/invite`, {});
  const token = new URL(link.data.url!).hash.replace(/^#token=/, "");
  await fetch(`${API}/v1/auth/links/accept`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ token, password }) });
  await signInToken(API, email, password);
  return { email, password };
}

test("M1, M3: a line voided after it was sent reads Voided on the POS, one taken off before reads Removed; a display ticket is not 'printed'", async ({ page }) => {
  test.setTimeout(300_000);
  const { outletId, brandId } = devLocal();
  const products = await register<{ data: { id: string; name: string }[] }>("GET", "/v1/products?limit=50");
  const kopi = products.data.find((p) => p.name === "Kopi")!;
  const reasons = await register<{ data: { id: string; name: string }[] }>("GET", "/v1/void-reasons");
  const kitchenError = reasons.data.find((r) => r.name === "Kitchen error")!;
  const changedMind = reasons.data.find((r) => r.name === "Customer changed mind")!;
  const order = await register<{ data: { id: string; order_no: string } }>("POST", "/v1/orders", { order_id: crypto.randomUUID(), order_type: "takeaway", takeaway_ref: "Round five", outlet_id: outletId, brand_id: brandId });
  const sentLine = crypto.randomUUID();
  const unsentLine = crypto.randomUUID();
  await register("POST", `/v1/orders/${order.data.id}/lines`, { lines: [{ line_id: sentLine, product_id: kopi.id, quantity: 1 }, { line_id: crypto.randomUUID(), product_id: kopi.id, quantity: 1 }] });
  await register("POST", `/v1/orders/${order.data.id}/fire`, {});
  await register("POST", `/v1/orders/${order.data.id}/lines/${sentLine}/void`, { reason_id: kitchenError.id });
  await register("POST", `/v1/orders/${order.data.id}/lines`, { lines: [{ line_id: unsentLine, product_id: kopi.id, quantity: 1 }] });
  await register("POST", `/v1/orders/${order.data.id}/lines/${unsentLine}/void`, { reason_id: changedMind.id });

  await pairAndSignIn(page, MANAGER_PIN);
  await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Orders", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(`^Takeaway ${order.data.order_no}`) }).click();
  const panel = page.getByRole("region", { name: "Order" });
  await expect(panel.getByText("Voided · Kitchen error")).toBeVisible();
  await expect(panel.getByText("Removed · Customer changed mind")).toBeVisible();
  await expect(panel.getByText("Removed · Kitchen error")).toHaveCount(0);
  await page.screenshot({ path: "test-results/m1-pos-voided-removed.png" });

  // The back office says the same, and its events and Tickets agree: the demo has kitchen displays and no printer.
  await page.context().clearCookies();
  await officeSignIn(page);
  await page.goto(`${WEB}/orders`);
  await page.getByRole("grid").getByRole("row").filter({ hasText: order.data.order_no }).first().click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByText("Voided: Kitchen error")).toBeVisible();
  await expect(drawer.getByText("Removed: Customer changed mind")).toBeVisible();
  await expect(drawer.getByText("Shown on the kitchen display").first()).toBeVisible();
  await expect(drawer.getByText("Kitchen ticket printed")).toHaveCount(0);
  await expect(drawer.getByText("Nothing printed for this order: its tickets went to the kitchen display.")).toBeVisible();
  await drawer.getByText("Nothing printed for this order: its tickets went to the kitchen display.").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/m3-drawer-tickets-events.png" });
});

test("M2: rejecting the guest's only QR round on an order it opened frees the table, and the phone still shows the rejection", async ({ browser, page, watch }) => {
  test.setTimeout(300_000);
  const { outletId } = devLocal();
  const links = await register<{ data: { id: string; channel: string; outlet_id: string; open_on_first_scan: boolean }[] }>("GET", "/v1/channel-links");
  const link = links.data.find((l) => l.channel === "scan_to_order" && l.outlet_id === outletId)!;
  await register("PATCH", `/v1/channel-links/${link.id}`, { open_on_first_scan: true });
  try {
    const floor = await register<{ data: { tables: { id: string; name: string; order: unknown; status: string }[] } }>("GET", `/v1/outlets/${outletId}/floor`);
    const table = floor.data.tables.find((t) => !t.order)!;
    const qr = await register<{ data: { url: string } }>("POST", `/v1/tables/${table.id}/qr/rotate`, {});
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
    watch.attach(phone);
    await phone.goto(`${GUEST}/t/${qr.data.url.split("/t/")[1]!}`);
    await phone.getByRole("button", { name: /^Kopi,/ }).click();
    await phone.getByRole("dialog", { name: "Kopi" }).getByRole("button", { name: /^Add to order/ }).click();
    await phone.getByRole("button", { name: /^View your order, 1 item/ }).click();
    await phone.getByRole("button", { name: /^Send/ }).first().click();
    await expect(phone.getByRole("heading", { name: "Order sent" })).toBeVisible();
    const seated = await register<{ data: { tables: { id: string; status: string; order: unknown }[] } }>("GET", `/v1/outlets/${outletId}/floor`);
    expect(seated.data.tables.find((t) => t.id === table.id)!.order).toBeTruthy();

    await pairAndSignIn(page, SERVER_PIN);
    const rail = page.getByRole("complementary", { name: "Now" });
    const item = rail.getByRole("listitem").filter({ hasText: `Table ${table.name} · QR order` }).first();
    await item.getByRole("button", { name: "Reject" }).click();
    await page.getByRole("dialog", { name: "Reject QR order" }).getByRole("button", { name: "Sold out" }).click();
    await expect(rail.getByText(`Table ${table.name} · QR order`)).toHaveCount(0);

    // The table is free again on the register and on the POS floor, with no order left to cancel by hand.
    await expect(async () => {
      const after = await register<{ data: { tables: { id: string; status: string; order: unknown }[] } }>("GET", `/v1/outlets/${outletId}/floor`);
      const t = after.data.tables.find((x) => x.id === table.id)!;
      expect(t.order ?? null).toBeNull();
      expect(t.status).toBe("free");
    }).toPass({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: new RegExp(`^Table ${table.name}, free`, "i") })).toBeVisible();

    // The phone keeps its session and the rejection, with its reason and the item struck through.
    await expect(phone.getByRole("heading", { name: "Order not accepted" })).toBeVisible();
    await phone.reload();
    await expect(phone.getByText("This table session has ended.")).toHaveCount(0);
    await phone.screenshot({ path: "test-results/m2-phone-after-reject.png" });
    await page.screenshot({ path: "test-results/m2-pos-floor-after-reject.png" });
  } finally {
    await register("PATCH", `/v1/channel-links/${link.id}`, { open_on_first_scan: link.open_on_first_scan });
  }
});

test("M4, M5: after a tipped card payment the receipt sheet shows Tip and Charged, and the POS opens the invoice PDF", async ({ page }) => {
  test.setTimeout(300_000);
  await register("PATCH", "/v1/merchant/settings", { tips_enabled: true });
  try {
    await pairAndSignIn(page, CASHIER_PIN);
    await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Floor", exact: true }).click();
    await page.getByRole("button", { name: "Takeaway order", exact: true }).click();
    await page.getByRole("button", { name: /^Mee Goreng,/ }).click();
    await page.getByRole("button", { name: "Send 1 to kitchen" }).click();
    await page.getByRole("button", { name: /^Pay \$/ }).click();
    await page.getByRole("group", { name: "Payment method" }).getByRole("button", { name: "Card", exact: true }).click();
    await page.getByRole("button", { name: "Type the tip" }).click();
    await page.getByRole("group", { name: "Tip" }).getByRole("button", { name: "Tip 15%" }).click();
    const take = page.getByRole("button", { name: /^Take \$[\d.]+ by Card/ });
    await expect(take).toBeEnabled();
    await take.click();
    const paidLine = page.getByText(/^Tip \$[\d.,]+ · Charged \$[\d.,]+$/);
    await expect(paidLine).toBeVisible();

    // M5: Get invoice issues it, then its PDF opens from here.
    await page.getByRole("button", { name: "Get invoice" }).click();
    const pdfButton = page.getByRole("button", { name: /^Invoice INV-\d+ · PDF$/ });
    await expect(pdfButton).toBeVisible();
    await expect(page.getByText("The PDF is in the back office under the order.")).toHaveCount(0);
    const [download] = await Promise.all([page.waitForEvent("download"), pdfButton.click()]);
    expect(download.suggestedFilename()).toMatch(/^INV-\d+\.pdf$/);
    const head = (await (await import("node:fs/promises")).readFile(await download.path())).subarray(0, 4).toString();
    expect(head).toBe("%PDF");
    await page.getByRole("button", { name: "No receipt" }).click();

    // M4: the receipt sheet from the closed order shows the same figures; M5: the invoice issued before opens too.
    await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Orders", exact: true }).click();
    await page.getByRole("group", { name: "Which orders" }).getByRole("button", { name: "Today's closed" }).click();
    await page.getByRole("button", { name: /^Takeaway .*, Done$/ }).first().click();
    await page.getByRole("button", { name: "Receipt", exact: true }).first().click();
    const sheet = page.getByRole("dialog", { name: /^Receipt · Bill 1/ });
    const figures = sheet.getByText(/^Tip \$[\d.,]+ · Charged \$[\d.,]+$/);
    await expect(figures).toBeVisible();
    const paid = cents((await sheet.getByRole("region", { name: /^Paid · Bill 1 · / }).getAttribute("aria-label"))!);
    const [tip, charged] = ((await figures.textContent())!.match(/\$[\d.,]+/g) ?? []).map(cents);
    expect(tip).toBeGreaterThan(0);
    expect(charged).toBe(paid + tip!);
    const [again] = await Promise.all([page.waitForEvent("download"), sheet.getByRole("button", { name: /^Invoice INV-\d+ · PDF$/ }).click()]);
    expect(again.suggestedFilename()).toBe(download.suggestedFilename());
    await page.screenshot({ path: "test-results/m4-m5-receipt-sheet.png" });
  } finally {
    await register("PATCH", "/v1/merchant/settings", { tips_enabled: false });
  }
});

test("M6: in a read-only form the chips and their × are in the disabled ink, in the Day and Service themes", async ({ page }) => {
  test.setTimeout(300_000);
  const who = await loginFor("manager");
  await officeSignIn(page, who.email, who.password);
  // The back office's dark theme is "Service" (`data-theme="service"`), switched from the user menu.
  for (const scheme of ["light", "dark"] as const) {
    await page.goto(`${WEB}/settings/merchant`);
    await page.evaluate((dark) => {
      if (dark) document.documentElement.dataset.theme = "service";
      else delete document.documentElement.dataset.theme;
    }, scheme === "dark");
    const remove = page.getByRole("button", { name: /^Remove / }).first();
    await expect(remove).toBeDisabled();
    const [ink, disabled] = await remove.evaluate((el) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--ink-disabled)";
      document.body.appendChild(probe);
      const want = getComputedStyle(probe).color;
      probe.remove();
      return [getComputedStyle(el).color, want];
    });
    expect(ink, scheme).toBe(disabled);
    await remove.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/m6-locked-chips-${scheme}.png` });
  }
});
