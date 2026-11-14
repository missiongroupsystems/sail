import type { Page } from "@playwright/test";
import { API, devLocal, expect, GUEST, keyIn, pairAndSignIn, register, SG_ADMIN, signInToken, test, WEB } from "./fixtures";

/**
 * The third live test's findings that show on screen (testers S and R, `a5de0c0`). The finding's id is in each test's
 * name.
 */
const CASHIER_PIN = "333333";
const MANAGER_PIN = "222222";
const SERVER_PIN = "444444";

async function withShift<T>(fn: () => Promise<T>): Promise<T> {
  const { outletId } = devLocal();
  const shift = await register<{ data: { id: string } }>("POST", "/v1/shifts", { outlet_id: outletId, station_id: null, float_cents: 10_000 });
  try {
    return await fn();
  } finally {
    await register("POST", `/v1/shifts/${shift.data.id}/close`, { counted_cash_cents: 10_000, variance_reason: "End of an end-to-end test" }).catch(() => undefined);
  }
}

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
async function loginFor(role: "manager" | "server" | "cashier" | "finance") {
  const suffix = `${role}${String(Date.now()).slice(-6)}`;
  const email = `${suffix}@sail.local`;
  const password = `quiet harbour lantern ${String(Date.now()).slice(-4)} round`;
  const created = await register<{ data: { id: string } }>("POST", "/v1/staff", { name: `Round Three ${suffix}`, email, role });
  const link = await register<{ data: { url: string | null } }>("POST", `/v1/staff/${created.data.id}/invite`, {});
  const token = new URL(link.data.url!).hash.replace(/^#token=/, "");
  await fetch(`${API}/v1/auth/links/accept`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ token, password }) });
  await signInToken(API, email, password);
  return { email, password };
}

async function signOut(page: Page) {
  await page.context().clearCookies();
}

test("S-9, R A-N3: while a shift is open the POS shows no expected cash, and the register does not send it to a Cashier", async ({ page }) => {
  test.setTimeout(300_000);
  await withShift(async () => {
    const answers: string[] = [];
    page.on("response", async (r) => {
      if (/\/z-report/.test(r.url()) && r.request().method() === "GET" && r.ok()) answers.push(await r.text().catch(() => ""));
    });
    await pairAndSignIn(page, CASHIER_PIN);
    await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Shift", exact: true }).click();
    const note = page.getByText(/The money figures are hidden while a shift is open/);
    await expect(note).toBeVisible();
    await expect(page.getByText(/expected so far/i)).toHaveCount(0);
    await page.getByRole("group", { name: "Shift section" }).getByRole("radio", { name: "Z-report" }).or(page.getByRole("button", { name: "Z-report", exact: true })).first().click();
    await expect(page.getByText(/The money figures are hidden while a shift is open/)).toBeVisible();
    await expect(page.getByText(/expected so far/i)).toHaveCount(0);
    expect(answers.length).toBeGreaterThan(0);
    for (const a of answers) {
      expect(a).toContain('"withheld":"open_shift"');
      expect(a).not.toContain('"expected"');
    }
  });
});

test("R new 2: the POS Z-report keeps one basis per block, with the back office's labels", async ({ page }) => {
  test.setTimeout(300_000);
  // No shift open: the Cashier sees the money figures.
  await pairAndSignIn(page, CASHIER_PIN);
  await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Shift", exact: true }).click();
  const figures = page.getByRole("region", { name: "Z-report · figures so far" });
  await expect(figures.getByRole("heading", { name: "Sales", exact: true })).toBeVisible();
  await expect(figures.getByRole("heading", { name: /^Refunds · \d+$/ })).toBeVisible();
  await expect(figures.getByRole("heading", { name: "After refunds", exact: true })).toBeVisible();
  for (const label of ["Net before refunds", "Collected", "Net refunded", "Net sales", "Collected after refunds"]) await expect(figures.getByText(label, { exact: true })).toBeVisible();
  // Net sales sits in the after-refunds block only, never beside the before-refunds Collected.
  await expect(figures.getByText("Refunds (before tax)", { exact: true })).toHaveCount(0);
});

test("R new 1, R new 3: Manager, Finance, Cashier and Server meet no control that ends in a refusal, and a Server's pricing rules finish loading", async ({ page, watch }) => {
  test.setTimeout(600_000);
  watch.allow({ status: 403, url: /\/(reports|pricing\/simulator|team|audit|menu\/import)/, why: "pages a lower role is refused, shown as the higher-role page" });
  const pages = ["/today", "/orders", "/floor", "/menu/products", "/menu/categories", "/menu/modifiers", "/menu/menus", "/menu/availability", "/menu/sold-out", "/menu/import", "/pricing/rules", "/pricing/customers", "/printing/printers", "/printing/jobs", "/printing/relays", "/settings/merchant", "/settings/outlets", "/settings/brands", "/settings/stations", "/settings/tax", "/settings/tenders", "/settings/void-reasons", "/settings/channels", "/team"];
  for (const role of ["manager", "finance", "cashier", "server"] as const) {
    const who = await loginFor(role);
    await officeSignIn(page, who.email, who.password);
    for (const path of pages) {
      await page.goto(`${WEB}${path}`);
      await expect(page.locator("main")).toBeVisible();
    }
    // The importer is an Admin's: its tab leads to the higher-role page, not to a form that fails.
    await page.goto(`${WEB}/menu/import`);
    await expect(page.getByRole("heading", { name: "This page needs a higher role" })).toBeVisible();
    // Floor & QR: only an Admin changes the plan.
    await page.goto(`${WEB}/floor`);
    await expect(page.getByRole("application", { name: /Floor plan/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add table" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Rename / })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add area" })).toHaveCount(0);
    await page.goto(`${WEB}/menu/menus`);
    await expect(page.getByRole("button", { name: "Add menu" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add section" })).toHaveCount(0);
    // A record's sheet offers no Archive the role cannot use (the rest of E-M7).
    await page.goto(`${WEB}/settings/stations`);
    await page.getByRole("row", { name: /Station 1/ }).click();
    await expect(page.getByRole("dialog", { name: "Station 1" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^(Archive|Restore) station/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Pair / })).toBeDisabled();
    await page.keyboard.press("Escape");
    await page.goto(`${WEB}/settings/merchant`);
    await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await expect(page.getByText("Changing this needs an Admin.").first()).toBeVisible();
    if (role === "server") {
      await page.goto(`${WEB}/menu/sold-out`);
      await expect(page.getByRole("button", { name: "Mark sold out" })).toHaveCount(0);
      await page.goto(`${WEB}/pricing/customers`);
      await expect(page.getByRole("button", { name: "Add customer" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Add group" })).toHaveCount(0);
      // R new 3: a Server reads the rules; the checks, which need a Manager, are left out rather than loading for ever.
      await page.goto(`${WEB}/pricing/rules`);
      await expect(page.getByRole("grid").or(page.getByRole("table")).first()).toBeVisible();
      await page.waitForTimeout(2_000);
      await expect(page.getByText("Checking the active rule set…")).toHaveCount(0);
    }
    await signOut(page);
  }
});

test("R new 4: a field's error clears when the field it depends on changes", async ({ page }) => {
  test.setTimeout(300_000);
  await officeSignIn(page);
  await page.goto(`${WEB}/menu/modifiers`);
  await page.getByRole("button", { name: "Add modifier group" }).click();
  const sheet = page.getByRole("dialog", { name: "New modifier group" });
  await sheet.getByLabel("Name").fill(`Round three ${Date.now()}`);
  await sheet.getByLabel("Minimum choices").fill("5");
  await sheet.getByLabel("Maximum choices").fill("2");
  await sheet.getByRole("button", { name: "Add modifier group" }).click();
  await expect(sheet.getByText("Maximum cannot be below the minimum")).toBeVisible();
  await sheet.getByLabel("Minimum choices").fill("0");
  await expect(sheet.getByText("Maximum cannot be below the minimum")).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("R B-N2: a reopened order says its payment was reversed on the order and the pay screen, until it is paid again", async ({ page }) => {
  test.setTimeout(300_000);
  const { outletId, brandId } = devLocal();
  const products = await register<{ data: { id: string; name: string }[] }>("GET", "/v1/products?limit=50");
  const kopi = products.data.find((p) => p.name === "Kopi")!;
  const tenders = await register<{ data: { id: string; name: string; is_cash: boolean; provider?: string | null }[] }>("GET", "/v1/tender-types");
  const byHand = tenders.data.find((t) => !t.is_cash && !t.provider)!;
  const order = await register<{ data: { id: string; order_no: string } }>("POST", "/v1/orders", { order_id: crypto.randomUUID(), order_type: "takeaway", takeaway_ref: "Round three", outlet_id: outletId, brand_id: brandId });
  const added = await register<{ data: { balance: number; checks: { id: string }[] } }>("POST", `/v1/orders/${order.data.id}/lines`, { lines: [{ line_id: crypto.randomUUID(), product_id: kopi.id, quantity: 1 }] });
  await register("POST", `/v1/orders/${order.data.id}/fire`, {});
  await register("POST", `/v1/checks/${added.data.checks[0]!.id}/payments`, { payment_id: crypto.randomUUID(), tender_type_id: byHand.id, amount: added.data.balance });
  await register("POST", `/v1/orders/${order.data.id}/complete`, {}).catch(() => undefined);
  await register("POST", `/v1/orders/${order.data.id}/reopen`, { reason: "Wrong order" });

  await pairAndSignIn(page, MANAGER_PIN);
  await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Orders", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(`^Takeaway ${order.data.order_no}`) }).click();
  const panel = page.getByRole("region", { name: "Order" });
  await expect(panel.getByRole("note")).toContainText(`Reopened: the payment of`);
  await expect(panel.getByRole("note")).toContainText(`was reversed. Take payment again for the balance.`);
  await page.getByRole("button", { name: /^Pay \$/ }).click();
  await expect(page.getByRole("region", { name: "Bill" }).getByRole("note")).toContainText("was reversed");
});

test("S-3: Enter sends a PIN short of six digits, on the lock screen and on the approval sheet, with the normal wrong-PIN message", async ({ page, watch }) => {
  test.setTimeout(300_000);
  watch.allow({ status: 401, url: /\/v1\/stations\/sessions$/, why: "a short PIN on purpose" });
  watch.allow({ status: 403, url: /\/v1\/overrides$/, why: "a short approval PIN on purpose" });
  const { stationId } = devLocal();
  const code = (await register<{ data: { code: string } }>("POST", `/v1/stations/${stationId}/pairing-code`, {})).data.code;
  await page.goto(`${WEB}/pos`);
  await expect(page.getByRole("heading", { name: "Pair this iPad to a station" })).toBeVisible({ timeout: 180_000 });
  await keyIn(page, "PIN keys", code);
  await page.getByRole("button", { name: "Pair this iPad" }).click();
  await expect(page.getByRole("button", { name: "Pair this iPad again" })).toBeVisible();
  // A physical keyboard, as the tester used: four digits, then Enter.
  await page.locator("main").click({ position: { x: 5, y: 5 } });
  await page.keyboard.type("1234");
  await page.keyboard.press("Enter");
  await expect(page.getByText("PIN not recognised")).toBeVisible();
  await keyIn(page, "PIN keys", SERVER_PIN);
  await expect(page.getByRole("navigation", { name: "Destinations" })).toBeVisible();
  await withShift(async () => {
    await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Floor", exact: true }).click();
    await page.getByRole("button", { name: "Takeaway order", exact: true }).click();
    await page.getByRole("button", { name: /^Mee Goreng,/ }).click();
    await page.getByRole("button", { name: "Send 1 to kitchen" }).click();
    await page.getByRole("button", { name: /^Pay \$/ }).click();
    await page.getByRole("group", { name: "Payment method" }).getByRole("button", { name: "Cash", exact: true }).click();
    await page.getByRole("button", { name: /^Take \$[\d.,]+ cash/ }).click();
    const sheet = page.getByRole("dialog", { name: "Cashier approval" });
    await expect(sheet).toBeVisible();
    await sheet.getByText(/enters their PIN/).click();
    await page.keyboard.type("12");
    await page.keyboard.press("Enter");
    await expect(sheet).toContainText("PIN not recognised. Check the PIN, or ask a Cashier or above to enter theirs.");
    await page.keyboard.press("Escape");
  });
});

test("R sizes: at 390 wide the report date fields and their Clear buttons are at least 44px tall", async ({ browser }) => {
  test.setTimeout(300_000);
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await officeSignIn(phone);
    await phone.goto(`${WEB}/reports/sales`);
    for (const name of ["Clear From", "Clear To"]) {
      const clear = phone.getByRole("button", { name });
      await expect(clear).toBeVisible();
      const box = (await clear.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
    }
    for (const name of ["From", "To"]) {
      const box = (await phone.getByLabel(name, { exact: true }).boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  } finally {
    await phone.close();
  }
});

test("S other: a sold-out line on the guest review cannot be increased", async ({ browser, watch }) => {
  test.setTimeout(300_000);
  const { outletId, brandId } = devLocal();
  const floor = await register<{ data: { tables: { id: string; name: string; order: unknown }[] } }>("GET", `/v1/outlets/${outletId}/floor`);
  const table = floor.data.tables.find((t) => !t.order);
  if (!table) throw new Error("No free table left in the demo outlet");
  await register("POST", "/v1/orders", { order_id: crypto.randomUUID(), order_type: "dine_in", table_id: table.id, pax: 2, outlet_id: outletId, brand_id: brandId });
  const qr = await register<{ data: { url: string } }>("POST", `/v1/tables/${table.id}/qr/rotate`, {});
  const token = qr.data.url.split("/t/")[1]!;
  const products = await register<{ data: { id: string; name: string }[] }>("GET", "/v1/products?limit=50");
  const kopi = products.data.find((p) => p.name === "Kopi")!;
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  watch.attach(phone);
  try {
    await phone.goto(`${GUEST}/t/${token}`);
    await phone.getByRole("button", { name: /^Kopi,/ }).click();
    await phone.getByRole("dialog", { name: "Kopi" }).getByRole("button", { name: /^Add to order/ }).click();
    await phone.getByRole("button", { name: /^View your order/ }).click();
    await expect(phone.getByRole("button", { name: "More quantity of kopi" })).toBeEnabled();
    await register("POST", "/v1/stock/sold-out", { outlet_id: outletId, product_id: kopi.id, until: "indefinite" });
    await phone.reload();
    if (await phone.getByRole("button", { name: /^View your order/ }).isVisible().catch(() => false)) await phone.getByRole("button", { name: /^View your order/ }).click();
    await expect(phone.getByText("Sold out. Remove it to send the rest.")).toBeVisible();
    await expect(phone.getByRole("button", { name: "More quantity of kopi" })).toBeDisabled();
  } finally {
    await register("POST", "/v1/stock/restore", { outlet_id: outletId, product_id: kopi.id }).catch(() => undefined);
    await phone.close();
  }
});
