import type { Page } from "@playwright/test";
import { API, devLocal, expect, GUEST, keyIn, pairAndSignIn, register, SG_ADMIN, signInToken, test, WEB } from "./fixtures";

/**
 * The second live test's findings that show on screen: each test holds a fix to the behaviour it gives. The finding's
 * tester and id ("A-N1") are in the test's name.
 */
const CASHIER_PIN = "333333";
const SERVER_PIN = "444444";

async function withShift<T>(fn: () => Promise<T>): Promise<T> {
  const { outletId } = devLocal();
  const shift = await register<{ data: { id: string } }>("POST", "/v1/shifts", { outlet_id: outletId, station_id: null, float_cents: 0 });
  try {
    return await fn();
  } finally {
    await register("POST", `/v1/shifts/${shift.data.id}/close`, { counted_cash_cents: 0, variance_reason: "End of an end-to-end test" }).catch(() => undefined);
  }
}

async function takeaway(page: Page) {
  await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Floor", exact: true }).click();
  await page.getByRole("button", { name: "Takeaway order", exact: true }).click();
  await page.getByRole("button", { name: /^Mee Goreng,/ }).click();
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
async function loginFor(role: "manager" | "server" | "cashier") {
  const suffix = `${role}${String(Date.now()).slice(-6)}`;
  const email = `${suffix}@sail.local`;
  // Not the email's name: the register refuses a password holding it (E-M13).
  const password = `quiet harbour lantern ${String(Date.now()).slice(-4)} round`;
  const created = await register<{ data: { id: string } }>("POST", "/v1/staff", { name: `Round Two ${suffix}`, email, role });
  const link = await register<{ data: { url: string | null } }>("POST", `/v1/staff/${created.data.id}/invite`, {});
  const token = new URL(link.data.url!).hash.replace(/^#token=/, "");
  await fetch(`${API}/v1/auth/links/accept`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ token, password }) });
  await signInToken(API, email, password);
  return { email, password };
}

test("A-R1-1, A and C notes: pairing types from a keyboard, opens on a clean lock screen, and Unpair ends the pairing on the register", async ({ page }) => {
  test.setTimeout(300_000);
  const { stationId, outletId } = devLocal();
  const code = (await register<{ data: { code: string } }>("POST", `/v1/stations/${stationId}/pairing-code`, {})).data.code;
  await page.goto(`${WEB}/pos`);
  await expect(page.getByRole("heading", { name: "Pair this iPad to a station" })).toBeVisible({ timeout: 180_000 });
  await page.locator("main").click({ position: { x: 5, y: 5 } });
  await page.keyboard.type(code);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Pair this iPad again" })).toBeVisible();
  await expect(page.getByText("Your session ended")).toHaveCount(0);
  const paired = async () => (await register<{ data: { id: string; paired: boolean }[] }>("GET", `/v1/outlets/${outletId}/stations`)).data.find((s) => s.id === stationId)!.paired;
  expect(await paired()).toBe(true);
  await page.getByRole("button", { name: "Pair this iPad again" }).click();
  await page.getByRole("button", { name: "Unpair this iPad" }).click();
  await expect(page.getByRole("heading", { name: "Pair this iPad to a station" })).toBeVisible();
  expect(await paired()).toBe(false);
  // Paired again, the PIN goes in from the keyboard too.
  const again = (await register<{ data: { code: string } }>("POST", `/v1/stations/${stationId}/pairing-code`, {})).data.code;
  await page.keyboard.type(again);
  await page.getByRole("button", { name: "Pair this iPad" }).click();
  await expect(page.getByRole("button", { name: "Pair this iPad again" })).toBeVisible();
  await page.keyboard.type(CASHIER_PIN);
  await expect(page.getByRole("navigation", { name: "Destinations" })).toBeVisible();
});

test("A-N1, A-N5: cash typed over the balance is the cash handed over, with the amount recorded and the change; the change waits for a tap", async ({ page }) => {
  test.setTimeout(300_000);
  await withShift(async () => {
    await pairAndSignIn(page, CASHIER_PIN);
    await takeaway(page);
    await page.getByRole("button", { name: "Send 1 to kitchen" }).click();
    await page.getByRole("button", { name: /^Pay \$/ }).click();
    await page.getByRole("group", { name: "Payment method" }).getByRole("button", { name: "Cash", exact: true }).click();
    await expect(page.getByText("The register will record")).toBeVisible();
    await keyIn(page, "Amount keys", "20000");
    const summary = page.getByRole("status").filter({ hasText: "Cash handed over" });
    await expect(summary).toContainText("$200.00");
    await expect(summary).toContainText("Change to give");
    await expect(page.getByRole("button", { name: /^Take \$200\.00 cash/ })).toBeEnabled();
    await page.getByRole("button", { name: /^Take \$200\.00 cash/ }).click();
    await expect(page.getByText(/^Change \$/)).toBeVisible();
    await page.waitForTimeout(6000);
    await expect(page.getByText(/^Change \$/)).toBeVisible();
  });
});

test("B-N5, B-N1: a Server's payment asks for a Cashier by name, lists what is charged, and a wrong PIN says which role", async ({ page, watch }) => {
  test.setTimeout(300_000);
  watch.allow({ status: 403, url: /\/v1\/overrides$/, why: "a wrong approval PIN on purpose" });
  await withShift(async () => {
    await pairAndSignIn(page, SERVER_PIN);
    await takeaway(page);
    await page.getByRole("button", { name: "Send 1 to kitchen" }).click();
    await page.getByRole("button", { name: /^Pay \$/ }).click();
    await page.getByRole("group", { name: "Payment method" }).getByRole("button", { name: "Cash", exact: true }).click();
    await page.getByRole("button", { name: /^Take \$[\d.,]+ cash/ }).click();
    const sheet = page.getByRole("dialog", { name: "Cashier approval" });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText(/Amount \$/);
    await expect(sheet).toContainText("A Cashier or above enters their PIN");
    await keyIn(page, "PIN keys", "987650");
    await expect(sheet).toContainText("PIN not recognised. Check the PIN, or ask a Cashier or above to enter theirs.");
    await page.keyboard.press("Escape");
  });
});

test("A-N3, C-3: the close is a blind count, with no figures beside it", async ({ page }) => {
  test.setTimeout(300_000);
  await withShift(async () => {
    await pairAndSignIn(page, CASHIER_PIN);
    await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Shift", exact: true }).click();
    await expect(page.getByText(/Z-report · figures so far/)).toBeVisible();
    await page.getByRole("button", { name: "Close shift", exact: true }).click();
    await expect(page.getByText("The figures are hidden while the drawer is counted.")).toBeVisible();
    await expect(page.getByText(/^Expected$/)).toHaveCount(0);
    await page.getByRole("button", { name: "Not now" }).click();
  });
});

test("E-M7: a Manager is not offered what needs an Admin, and a Server's refused pages are the higher-role page", async ({ page, watch }) => {
  test.setTimeout(300_000);
  watch.allow({ status: 403, url: /\/(reports|pricing)/, why: "a Server may not open these pages" });
  const manager = await loginFor("manager");
  await officeSignIn(page, manager.email, manager.password);
  await page.goto(`${WEB}/settings/tax`);
  await expect(page.getByRole("heading", { name: "Settings" }).or(page.getByRole("heading", { name: /Tax/ })).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Add tax class" })).toHaveCount(0);
  await page.goto(`${WEB}/settings/stations`);
  await expect(page.getByRole("button", { name: "Add station" })).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out" }).click().catch(() => undefined);
  await page.context().clearCookies();
  const server = await loginFor("server");
  await officeSignIn(page, server.email, server.password);
  await expect(page.getByText("Only a Cashier or above can do this")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Today so far" })).toHaveCount(0);
  for (const path of ["/reports/sales", "/pricing/simulator"]) {
    await page.goto(`${WEB}${path}`);
    await expect(page.getByRole("heading", { name: "This page needs a higher role" })).toBeVisible();
  }
});

test("E-N3, E-N4, E-N2: an overnight availability rule saves, is marked next day and can be deleted; a refusal clears when the sheet closes", async ({ page, watch }) => {
  test.setTimeout(300_000);
  watch.allow({ status: 400, url: /\/v1\/availability-rules/, why: "a window ending when it starts is refused on purpose" });
  await officeSignIn(page);
  await page.goto(`${WEB}/menu/availability`);
  const add = async (from: string, until: string) => {
    await page.getByRole("button", { name: "Add availability rule" }).click();
    const sheet = page.getByRole("dialog", { name: "New availability rule" });
    await sheet.getByRole("searchbox", { name: "Product" }).fill("Kopi");
    await sheet.getByRole("list", { name: "Results" }).getByRole("button").first().click();
    await sheet.getByLabel("From").fill(from);
    await sheet.getByLabel("Until").fill(until);
    await sheet.getByRole("button", { name: "Add rule" }).click();
    return sheet;
  };
  const refused = await add("10:00", "10:00");
  await expect(refused.getByText("The window ends when it starts")).toBeVisible();
  await refused.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Add availability rule" }).click();
  await expect(page.getByRole("dialog", { name: "New availability rule" }).getByText("The window ends when it starts")).toHaveCount(0);
  await page.getByRole("dialog", { name: "New availability rule" }).getByRole("button", { name: "Cancel" }).click();
  const saved = await add("22:00", "02:00");
  await expect(saved).toBeHidden();
  const row = page.getByRole("row").filter({ hasText: "(next day)" }).first();
  await expect(row).toBeVisible();
  await row.click();
  const edit = page.getByRole("dialog", { name: "Availability rule" });
  await edit.getByRole("button", { name: "Delete rule" }).click();
  await edit.getByRole("button", { name: "Delete rule" }).click();
  await expect(edit).toBeHidden();
  await expect(page.getByRole("row").filter({ hasText: "(next day)" })).toHaveCount(0);
});

test("E-N8, E-L13: the audit names actions in words and filters sign-ins and daily caps", async ({ page }) => {
  test.setTimeout(300_000);
  await officeSignIn(page);
  await page.goto(`${WEB}/audit`);
  await page.getByRole("button", { name: /Any action/ }).click();
  for (const name of ["Signed in", "Signed out", "Set a daily cap", "Created a category"]) await expect(page.getByRole("option", { name, exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText(/categorie\b/)).toHaveCount(0);
});

test("F-N4: the set-password page names the account the link is for", async ({ page }) => {
  test.setTimeout(300_000);
  const suffix = String(Date.now()).slice(-6);
  const created = await register<{ data: { id: string } }>("POST", "/v1/staff", { name: `Named Invitee ${suffix}`, email: `named.${suffix}@sail.local`, role: "server" });
  const link = await register<{ data: { url: string | null } }>("POST", `/v1/staff/${created.data.id}/invite`, {});
  await page.goto(`${WEB}/set-password${new URL(link.data.url!).hash}`);
  await expect(page.getByText(`Named Invitee ${suffix}`)).toBeVisible();
  await expect(page.getByText(`named.${suffix}@sail.local`)).toBeVisible();
});

test("D-N2, D-N3, D-N1: the review has a 44px Edit, flags a sold-out item and keeps Send off; after Rotate code the phone is told to scan again", async ({ browser, watch }) => {
  test.setTimeout(300_000);
  watch.allow({ status: 401, url: /\/v1\/(guest\/|channel-links\/)/, why: "the table's code is rotated on purpose" });
  const { outletId, brandId } = devLocal();
  const floor = await register<{ data: { tables: { id: string; name: string; order: unknown }[] } }>("GET", `/v1/outlets/${outletId}/floor`);
  const table = floor.data.tables.find((t) => !t.order);
  if (!table) throw new Error("No free table left in the demo outlet");
  await register("POST", "/v1/orders", { order_id: crypto.randomUUID(), order_type: "dine_in", table_id: table.id, pax: 2, outlet_id: outletId, brand_id: brandId });
  const qr = await register<{ data: { url: string } }>("POST", `/v1/tables/${table.id}/qr/rotate`, {});
  const token = qr.data.url.split("/t/")[1]!;
  const products = await register<{ data: { id: string; name: string }[] }>("GET", "/v1/products?limit=50");
  const kopi = products.data.find((p) => p.name === "Kopi")!;
  const phone = await browser.newPage({ viewport: { width: 360, height: 740 } });
  watch.attach(phone);
  try {
    await phone.goto(`${GUEST}/t/${token}`);
    await phone.getByRole("button", { name: /^Kopi,/ }).click();
    await phone.getByRole("dialog", { name: "Kopi" }).getByRole("button", { name: /^Add to order/ }).click();
    await phone.getByRole("button", { name: /^View your order/ }).click();
    const edit = phone.getByRole("button", { name: "Edit Kopi" });
    await expect(edit).toBeVisible();
    expect((await edit.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await register("POST", "/v1/stock/sold-out", { outlet_id: outletId, product_id: kopi.id, until: "indefinite" });
    await phone.reload();
    if (await phone.getByRole("button", { name: /^View your order/ }).isVisible().catch(() => false)) await phone.getByRole("button", { name: /^View your order/ }).click();
    await expect(phone.getByText("Sold out. Remove it to send the rest.")).toBeVisible();
    await expect(phone.getByRole("button", { name: /^Remove the sold-out item to send/ })).toBeDisabled();
    await register("POST", `/v1/tables/${table.id}/qr/rotate`, {});
    await phone.reload();
    await expect(phone.getByText("This table has a new QR code.")).toBeVisible();
    await expect(phone.getByRole("button", { name: "Start again" })).toHaveCount(0);
  } finally {
    await register("POST", "/v1/stock/restore", { outlet_id: outletId, product_id: kopi.id }).catch(() => undefined);
    await phone.close();
  }
});
