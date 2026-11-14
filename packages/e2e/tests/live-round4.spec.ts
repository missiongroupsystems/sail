import type { Locator, Page } from "@playwright/test";
import { API, devLocal, expect, pairAndSignIn, register, SG_ADMIN, signInToken, test, WEB } from "./fixtures";

/**
 * The fourth live test's findings that show on screen (tester S, `bda1270`, "Other things noticed"). The finding's id
 * is in each test's name. L2 and L6 are register and receipt findings: `server/test/live-round4.test.ts` and
 * `shared/src/escpos/escpos.test.ts`.
 */
const MANAGER_PIN = "222222";

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
  const created = await register<{ data: { id: string } }>("POST", "/v1/staff", { name: `Round Four ${suffix}`, email, role });
  const link = await register<{ data: { url: string | null } }>("POST", `/v1/staff/${created.data.id}/invite`, {});
  const token = new URL(link.data.url!).hash.replace(/^#token=/, "");
  await fetch(`${API}/v1/auth/links/accept`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ token, password }) });
  await signInToken(API, email, password);
  return { email, password };
}

/** Every field a person could type into, pick from or switch inside `scope`, and every chip's Remove, that is still on. */
function enabledFields(scope: Locator) {
  return scope.locator("input:not([type=hidden]):enabled, textarea:enabled, button[aria-haspopup=listbox]:enabled, button[aria-label^='Remove ']:enabled");
}

test("L1: Manager and Server open a table's details on Floor & QR, read only, and the intro matches what they can do", async ({ page }) => {
  test.setTimeout(300_000);
  for (const role of ["manager", "server"] as const) {
    const who = await loginFor(role);
    await officeSignIn(page, who.email, who.password);
    await page.goto(`${WEB}/floor`);
    await expect(page.getByText("Tap a table to see its name, seats and shape. The QR codes and their sheet need an Admin.")).toBeVisible();
    await expect(page.getByText(/Drag a table to move it/)).toHaveCount(0);
    const plan = page.getByRole("application", { name: /Floor plan/ });
    const table = plan.getByRole("button").first();
    const name = (await table.getAttribute("aria-label"))!.split(",")[0]!;
    await table.click();
    await expect(table).toHaveAttribute("aria-pressed", "true");
    const panel = page.locator("aside").filter({ has: page.getByRole("button", { name: "Save table" }) });
    await expect(panel.getByRole("heading", { name })).toBeVisible();
    await expect(panel.getByRole("textbox", { name: "Name" })).toHaveValue(name);
    await expect(panel.getByRole("textbox", { name: "Name" })).toBeDisabled();
    await expect(panel.getByRole("button", { name: "Save table" })).toBeDisabled();
    await expect(panel.getByRole("button", { name: /^(Archive|Restore)$/ })).toBeDisabled();
    await expect(panel.getByText("Changing this needs an Admin.")).toBeVisible();
    // The table's code itself is an Admin's (it lets a phone order at the table): the panel says where it is instead.
    await expect(panel.getByText(`The code on ${name} is printed on the QR sheet. Downloading the sheet and rotating a code need an Admin.`)).toBeVisible();
    await expect(enabledFields(panel)).toHaveCount(0);
    await page.context().clearCookies();
  }
  // An Admin still gets the editing intro and live fields.
  await officeSignIn(page);
  await page.goto(`${WEB}/floor`);
  await expect(page.getByText(/Drag a table to move it; tap it to edit/)).toBeVisible();
  await page.getByRole("application", { name: /Floor plan/ }).getByRole("button").first().click();
  await expect(page.getByRole("button", { name: "Save table" })).toBeVisible();
  await expect(page.locator("aside").getByRole("textbox", { name: "Name" })).toBeEnabled();
});

test("L3: for Manager, Finance, Cashier and Server, a sheet or form whose Save is off has every field off too", async ({ page, watch }) => {
  test.setTimeout(900_000);
  watch.allow({ status: 403, url: /\/team$/, why: "Team is a higher-role page for some of these roles" });
  // Pages with a record sheet behind a row, and the merchant settings form.
  const sheets = ["/team", "/menu/products", "/menu/categories", "/menu/modifiers", "/menu/availability", "/pricing/rules", "/pricing/customers", "/printing/printers", "/settings/outlets", "/settings/brands", "/settings/stations", "/settings/tax", "/settings/tenders", "/settings/void-reasons", "/settings/channels"];
  for (const role of ["manager", "finance", "cashier", "server"] as const) {
    const who = await loginFor(role);
    await officeSignIn(page, who.email, who.password);
    // The tester's case: the merchant settings' fields and the "Remove …" chips of the notes and coins.
    await page.goto(`${WEB}/settings/merchant`);
    await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await expect(page.getByRole("textbox", { name: "Name" })).toBeDisabled();
    await expect(page.getByRole("button", { name: /^Remove / }).first()).toBeDisabled();
    await expect(enabledFields(page.locator("main form"))).toHaveCount(0);
    // The product sheet's "Attach a modifier group".
    await page.goto(`${WEB}/menu/products`);
    await page.getByRole("grid").getByRole("row").nth(1).click();
    const product = page.getByRole("dialog");
    await expect(product.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await expect(product.getByRole("button", { name: /Attach a modifier group/ })).toBeDisabled();
    await expect(enabledFields(product)).toHaveCount(0);
    await page.keyboard.press("Escape");
    // Categories are a list of buttons, not a table.
    await page.goto(`${WEB}/menu/categories`);
    const categories = await register<{ data: { name: string; archived?: boolean }[] }>("GET", "/v1/categories");
    await page.getByRole("button", { name: categories.data.find((c) => !c.archived)!.name, exact: true }).first().click();
    await expect(page.getByRole("dialog").getByRole("button", { name: /^Save/ }).last()).toBeDisabled();
    await expect(enabledFields(page.getByRole("dialog"))).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: /^Move .+ (up|down)$/ })).toHaveCount(0);
    let walked = 0;
    for (const path of sheets) {
      await page.goto(`${WEB}${path}`);
      await expect(page.locator("main")).toBeVisible();
      const row = page.getByRole("grid").getByRole("row").nth(1);
      if (!(await row.isVisible().catch(() => false))) continue;
      // An empty table's only row is its empty state, which opens nothing.
      if (!(await row.click({ timeout: 3_000 }).then(() => true, () => false))) continue;
      const sheet = page.getByRole("dialog");
      if (!(await sheet.isVisible().catch(() => false))) continue;
      const save = sheet.getByRole("button", { name: /^Save/ }).last();
      // Only a sheet this role may not save is read only; a Cashier may still change a customer.
      // A sheet that offers only Close (Printers) is read only too.
      const readOnly = (await save.count()) ? (await save.isDisabled()) && (await sheet.getByText(/^Changing this needs /).count()) > 0 : (await sheet.getByRole("button", { name: "Close", exact: true }).count()) > 0;
      if (readOnly) {
        await expect.soft(enabledFields(sheet), `${role} ${path}`).toHaveCount(0, { timeout: 3_000 });
        walked++;
      }
      await page.keyboard.press("Escape");
      await expect(sheet).toHaveCount(0);
    }
    expect(walked, role).toBeGreaterThanOrEqual(8);
    await page.context().clearCookies();
  }
});

test("L4: at 390 wide the back office's Sign out and user menu are at least 44px tall", async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await officeSignIn(page);
  for (const button of [page.getByRole("button", { name: "Sign out" }), page.getByRole("button", { name: /Open user menu/ })]) {
    const box = (await button.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
  }
  for (const link of await page.getByRole("navigation").first().getByRole("link").all()) {
    const box = await link.boundingBox();
    if (box) expect(box.height, await link.getAttribute("aria-label") ?? "").toBeGreaterThanOrEqual(44);
  }
});

test("L5: the closed-shift card names who opened the shift and who closed it", async ({ page }) => {
  test.setTimeout(300_000);
  const { outletId, stationId } = devLocal();
  const shift = await register<{ data: { id: string; opened_by: string } }>("POST", "/v1/shifts", { outlet_id: outletId, station_id: stationId, float_cents: 10_000 });
  try {
    await pairAndSignIn(page, MANAGER_PIN);
    await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Shift", exact: true }).click();
    await page.getByRole("button", { name: "Close shift", exact: true }).click();
    const checklist = page.getByRole("list", { name: "Before closing" });
    for (const leave of await checklist.getByRole("button", { name: "Leave open" }).all()) await leave.click();
    await page.getByRole("button", { name: /^Next: count the cash/ }).click();
    await page.getByRole("textbox", { name: "Cash counted in the drawer" }).fill("100.00");
    await page.getByRole("button", { name: /^Close shift · counted \$100\.00/ }).click();
    await expect(page.getByRole("heading", { name: "Shift closed" })).toBeVisible();
    const opener = shift.data.opened_by;
    const line = page.getByText(new RegExp(`^Opened .+ by ${opener} · closed .+ by .+$`));
    await expect(line).toBeVisible();
    const closer = (await line.textContent())!.replace(/^.* · closed .+ by /, "");
    expect(closer).not.toBe(opener);
    await page.screenshot({ path: "test-results/pos-shift-closed-names.png" });
  } finally {
    await register("POST", `/v1/shifts/${shift.data.id}/close`, { counted_cash_cents: 10_000 }).catch(() => undefined);
  }
});
