import type { Page } from "@playwright/test";
import { API, devLocal, expect, GUEST, keyIn, pairAndSignIn, register, SG_ADMIN, signInToken, test, WEB } from "./fixtures";

/**
 * Screen findings from the live test of the deployed demo (testers A–F), each held to the behaviour the fix gives.
 * The finding's id is in each test's name.
 */

const CASHIER_PIN = "333333";
const SERVER_PIN = "444444";

test.use({ viewport: { width: 1180, height: 820 } });

async function signIn(page: Page, email = SG_ADMIN, password = devLocal().admin_password, landing = `${WEB}/today`) {
  await expect(async () => {
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click({ timeout: 10_000 });
    await page.waitForURL(landing, { timeout: 30_000 });
  }).toPass({ timeout: 300_000 });
}

async function takeaway(page: Page) {
  await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Floor", exact: true }).click();
  await page.getByRole("button", { name: "Takeaway order", exact: true }).click();
  await page.getByRole("button", { name: /^Mee Goreng,/ }).click();
  await expect(page.getByRole("button", { name: "Send 1 to kitchen" })).toBeVisible();
}

type Product = { id: string; name: string };

test("E-H1: an item sold out until restored lists on the Sold out page, and is restored from it", async ({ page }) => {
  test.setTimeout(300_000);
  const { outletId } = devLocal();
  const products = await register<{ data: Product[] }>("GET", "/v1/products?limit=50");
  const product = products.data.find((p) => p.name === "Kopi")!;
  await register("POST", "/v1/stock/sold-out", { outlet_id: outletId, product_id: product.id, until: "indefinite" });
  try {
    await page.goto(`${WEB}/login?next=%2Fmenu%2Fsold-out`);
    await signIn(page, SG_ADMIN, devLocal().admin_password, `${WEB}/menu/sold-out`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Menu");
    const row = page.getByRole("row").filter({ hasText: "Kopi" });
    await expect(row).toContainText("Sold out until restored");
  } finally {
    await register("POST", "/v1/stock/restore", { outlet_id: outletId, product_id: product.id });
  }
});

test("F-2, E-L8: sign-in goes only to a page of this site, and keeps the deep link's query", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto(`${WEB}/login?next=%2F%5Cexample.com`);
  await signIn(page);
  expect(new URL(page.url()).origin).toBe(WEB);

  const fresh = await page.context().browser()!.newPage();
  await fresh.goto(`${WEB}/orders?view=all`);
  await fresh.waitForURL(/\/login/);
  await signIn(fresh, SG_ADMIN, devLocal().admin_password, `${WEB}/orders?view=all`);
  await fresh.close();
});

test("A-1: the lock screen asks before it unpairs the iPad", async ({ page }) => {
  test.setTimeout(300_000);
  await pairAndSignIn(page, CASHIER_PIN);
  await page.getByRole("banner").getByRole("button", { name: "Lock", exact: true }).click();
  await page.getByRole("button", { name: "Pair this iPad again" }).click();
  // One tap only asks; the iPad stays paired and the PIN pad stays up.
  await expect(page.getByRole("heading", { name: "Pair this iPad to a station" })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "PIN keys" })).toBeVisible();
  await page.getByRole("button", { name: "Keep this iPad paired" }).click();
  await keyIn(page, "PIN keys", CASHIER_PIN);
  await expect(page.getByRole("navigation", { name: "Destinations" })).toBeVisible();
});

test("A-3: a double tap on Send sends once and shows no conflict", async ({ page }) => {
  test.setTimeout(300_000);
  await pairAndSignIn(page, CASHIER_PIN);
  await takeaway(page);
  const fires: number[] = [];
  page.on("response", (r) => {
    if (/\/v1\/orders\/[^/]+\/fire$/.test(r.url())) fires.push(r.status());
  });
  await page.getByRole("button", { name: "Send 1 to kitchen" }).dblclick();
  await expect(page.getByRole("region", { name: "Order" }).getByText(/^Sent /)).toBeVisible();
  await page.waitForTimeout(1500);
  expect(fires).toEqual([200]);
  await expect(page.getByText("The order changed on another station")).toHaveCount(0);
  // pos-2 item 2: the Send is confirmed on screen.
  await expect(page.getByText("Sent to the kitchen")).toBeVisible();
});

test("A-2: a closed order's receipt can still be shown as a QR code or sent", async ({ page }) => {
  test.setTimeout(300_000);
  await pairAndSignIn(page, CASHIER_PIN);
  await takeaway(page);
  await page.getByRole("button", { name: "Send 1 to kitchen" }).click();
  await page.getByRole("button", { name: /^Pay \$/ }).click();
  await page.getByRole("group", { name: "Payment method" }).getByRole("button", { name: "Card", exact: true }).click();
  await page.getByRole("button", { name: /^Paid by Card/ }).click();
  await page.getByRole("button", { name: "No receipt" }).click();
  await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Orders", exact: true }).click();
  await page.getByRole("button", { name: "Today's closed" }).click();
  await page.getByRole("button", { name: /^Takeaway .*, (Done|Completed|Paid)/ }).first().click();
  await page.getByRole("button", { name: "Receipt", exact: true }).first().click();
  await page.getByRole("button", { name: "QR on screen" }).click();
  await expect(page.getByRole("img", { name: "Receipt link as a QR code" })).toBeVisible();
});

test("B-F12: a Server's Z-report says who may see it instead of loading for ever", async ({ page, watch }) => {
  test.setTimeout(300_000);
  watch.allow({ status: 403, url: /\/z-report/, why: "a Server may not read the Z-report" });
  await pairAndSignIn(page, SERVER_PIN);
  await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Shift", exact: true }).click();
  await page.getByRole("button", { name: /^Z-report/ }).first().click();
  // The report's own refusal, in place of the figures: not the close-day line, which shows whatever the report does.
  await expect(page.getByRole("alert").filter({ hasText: /Cashier or above/ })).toBeVisible();
});

test("A-4, B-F6: with the tip keypad open the take button stays on screen", async ({ page }) => {
  test.setTimeout(300_000);
  await register("PATCH", "/v1/merchant/settings", { tips_enabled: true });
  try {
    await pairAndSignIn(page, CASHIER_PIN);
    await takeaway(page);
    await page.getByRole("button", { name: "Send 1 to kitchen" }).click();
    await page.getByRole("button", { name: /^Pay \$/ }).click();
    await page.getByRole("group", { name: "Payment method" }).getByRole("button", { name: "Card", exact: true }).click();
    await page.getByRole("button", { name: "Type the tip" }).click();
    await keyIn(page, "Amount keys", "200");
    const take = page.getByRole("button", { name: /^Take \$/ });
    await expect(take).toBeInViewport({ ratio: 1 });
    await page.getByRole("group", { name: "Payment method" }).getByRole("button", { name: "Cash", exact: true }).click();
    await expect(page.getByRole("button", { name: /^Take \$.* cash/ })).toBeInViewport({ ratio: 1 });
  } finally {
    await register("PATCH", "/v1/merchant/settings", { tips_enabled: false });
  }
});

test("F-4, E-L14: a new staff member can be added without a PIN", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto(`${WEB}/login?next=%2Fteam`);
  await signIn(page, SG_ADMIN, devLocal().admin_password, `${WEB}/team`);
  await page.getByRole("button", { name: "Add staff" }).click();
  const sheet = page.getByRole("dialog");
  const suffix = String(Date.now()).slice(-6);
  await sheet.getByLabel("Name").fill(`No PIN ${suffix}`);
  await sheet.getByRole("button", { name: /^(Add|Save)/ }).last().click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole("row").filter({ hasText: `No PIN ${suffix}` })).toBeVisible();
});

test("E-M4: a double click on Save adds one record", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto(`${WEB}/login?next=%2Fteam`);
  await signIn(page, SG_ADMIN, devLocal().admin_password, `${WEB}/team`);
  const before = (await register<{ data: unknown[] }>("GET", "/v1/staff?include_inactive=true")).data.length;
  await page.getByRole("button", { name: "Add staff" }).click();
  const sheet = page.getByRole("dialog");
  const suffix = String(Date.now()).slice(-6);
  await sheet.getByLabel("Name").fill(`Twice ${suffix}`);
  // Enter twice in the form, as fast as a keyboard repeats: both submits reach the register before the sheet closes.
  await sheet.getByLabel("Name").press("Enter");
  await sheet.getByLabel("Name").press("Enter");
  await expect(sheet).toBeHidden();
  await page.waitForTimeout(1500);
  const after = (await register<{ data: { name: string }[] }>("GET", "/v1/staff?include_inactive=true")).data;
  expect(after.filter((s) => s.name === `Twice ${suffix}`)).toHaveLength(1);
  expect(after.length).toBe(before + 1);
});

test("E-M7: a Cashier opening Team or Audit in the back office is told why, not shown an error", async ({ page, watch }) => {
  test.setTimeout(300_000);
  watch.allow({ status: 403, url: /\/(team|audit)/, why: "a Cashier may not open these pages" });
  const suffix = String(Date.now()).slice(-6);
  const email = `cashier.${suffix}@sail.local`;
  const password = `quiet harbour lantern ${suffix}`;
  const created = await register<{ data: { id: string } }>("POST", "/v1/staff", { name: `Office Cashier ${suffix}`, email, role: "cashier" });
  const link = await register<{ data: { url: string | null } }>("POST", `/v1/staff/${created.data.id}/invite`, {});
  const token = new URL(link.data.url!).hash.replace(/^#token=/, "");
  await fetch(`${API}/v1/auth/links/accept`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ token, password }) });
  await signInToken(API, email, password);
  await page.goto(`${WEB}/login`);
  await signIn(page, email, password);
  for (const path of ["/team", "/audit"]) {
    await page.goto(`${WEB}${path}`);
    await expect(page.getByText(/needs a Manager or above/).first()).toBeVisible();
    await expect(page.getByText("The register did not reply")).toHaveCount(0);
  }
});

test("F-3: an invite link opened while signed in says whose password it sets", async ({ page }) => {
  test.setTimeout(300_000);
  const suffix = String(Date.now()).slice(-6);
  const created = await register<{ data: { id: string } }>("POST", "/v1/staff", { name: `Invitee ${suffix}`, email: `invitee.${suffix}@sail.local`, role: "manager" });
  const link = await register<{ data: { url: string | null } }>("POST", `/v1/staff/${created.data.id}/invite`, {});
  await page.goto(`${WEB}/login`);
  await signIn(page);
  await page.goto(`${WEB}/set-password${new URL(link.data.url!).hash}`);
  await expect(page.getByText(/signed in as/i)).toBeVisible();
  const before = (await page.context().cookies(WEB)).find((c) => c.name === "sail_session")!.value;
  await page.getByLabel("New password").fill(`a fresh invitee password ${suffix}`);
  await page.getByLabel("Type it again").fill(`a fresh invitee password ${suffix}`);
  await page.getByRole("button", { name: /^Sign out of .* and set the password/ }).click();
  await page.waitForURL(`${WEB}/today`);
  // The Admin's session ended on the register, not only in this browser.
  expect((await fetch(`${API}/v1/me`, { headers: { authorization: `Bearer ${before}` } })).status).toBe(401);
});

test("C-2: a kitchen ticket wraps a long note and keeps the order number", async ({ page }) => {
  test.setTimeout(300_000);
  const { outletId, brandId } = devLocal();
  const products = await register<{ data: Product[] }>("GET", "/v1/products?limit=50");
  const product = products.data.find((p) => p.name === "Kopi")!;
  const orderId = crypto.randomUUID();
  const customer = "Alexandria Constantinople-Featherstoneh";
  const opened = await register<{ data: { order_no: string } }>("POST", "/v1/orders", { order_id: orderId, order_type: "takeaway", outlet_id: outletId, brand_id: brandId, takeaway_ref: customer });
  await register("POST", `/v1/orders/${orderId}/lines`, { lines: [{ line_id: crypto.randomUUID(), product_id: product.id, quantity: 1, notes: "N".repeat(180) }] });
  await register("POST", `/v1/orders/${orderId}/fire`, {});
  const stations = await register<{ data: { id: string; kind: string }[] }>("GET", `/v1/outlets/${outletId}/stations`);
  const display = stations.data.find((s) => s.kind === "display")!;
  const { data } = await register<{ data: { code: string } }>("POST", `/v1/stations/${display.id}/pairing-code`, {});
  await page.goto(`${WEB}/kds`);
  await keyIn(page, "PIN keys", data.code);
  await page.getByRole("button", { name: "Pair this screen" }).click();
  const card = page.getByRole("button", { name: new RegExp(`${opened.data.order_no}`) }).first();
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card).toContainText(opened.data.order_no);
  const overflow = await card.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("guest-sizes 5–7: Check again opens a just-seated table, Send counts the items, a staff request stays confirmed", async ({ browser, watch }) => {
  test.setTimeout(300_000);
  watch.allow({ status: 409, url: /\/v1\/guest\/stream/, why: "the table has no open order until staff seat it (D-14)" });
  const { outletId, brandId } = devLocal();
  const floor = await register<{ data: { tables: { id: string; name: string; order: unknown }[] } }>("GET", `/v1/outlets/${outletId}/floor`);
  const table = floor.data.tables.filter((t) => !t.order).at(-1)!;
  const qr = await register<{ data: { url: string } }>("POST", `/v1/tables/${table.id}/qr/rotate`, {});
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  watch.attach(phone);
  await phone.goto(`${GUEST}/t/${qr.data.url.split("/t/")[1]!}`);
  await expect(phone.getByText(/isn.t ready for ordering yet/)).toBeVisible();
  await register("POST", "/v1/orders", { order_id: crypto.randomUUID(), order_type: "dine_in", table_id: table.id, pax: 2, outlet_id: outletId, brand_id: brandId });
  await phone.getByRole("button", { name: "Check again" }).click();
  await expect(phone.getByText(/isn.t ready for ordering yet/)).toHaveCount(0);

  await phone.getByRole("button", { name: /^Kopi,/ }).click();
  await phone.getByRole("dialog", { name: "Kopi" }).getByRole("button", { name: /^Add to order/ }).click();
  await phone.getByRole("button", { name: /^View your order, 1 item/ }).click();
  await expect(phone.getByRole("button", { name: "Send 1 item to the kitchen" })).toBeVisible();
  await phone.getByRole("button", { name: /^Back|Menu/ }).first().click();

  await phone.getByRole("button", { name: /Call staff/ }).first().click();
  const sheet = phone.getByRole("dialog", { name: "Call staff" });
  await sheet.getByRole("button", { name: /Ask for the bill/ }).click();
  await expect(sheet.getByText(/^Sent\./)).toBeVisible();
  await phone.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(phone.getByRole("status").filter({ hasText: /sent\. Someone will be with you shortly/ })).toBeVisible();
  // Leave the outlet as found: the shift close in pos.spec lists open table requests.
  const open = await register<{ data: { id: string; status?: string }[] }>("GET", `/v1/outlets/${outletId}/service-requests`);
  for (const r of open.data.filter((x) => x.status !== "acknowledged")) await register("POST", `/v1/service-requests/${r.id}/acknowledge`, {}).catch(() => undefined);
});
