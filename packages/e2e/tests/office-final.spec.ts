import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { API, devLocal, expect, register, SG_ADMIN, signInToken, test, WEB } from "./fixtures";

/** The final office round's checks (back office: reports, import and export, pickers, archive, sign-in). */

async function signIn(page: Page, email = SG_ADMIN, password = devLocal().admin_password) {
  await page.goto(`${WEB}/login`);
  await expect(async () => {
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click({ timeout: 10_000 });
    await page.waitForURL(`${WEB}/today`, { timeout: 30_000 });
  }).toPass({ timeout: 300_000 });
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
}

/** A back-office login for a new staff member of this role. */
async function loginFor(role: "manager" | "finance" | "cashier") {
  const suffix = `${role}${String(Date.now()).slice(-6)}`;
  const email = `office.${suffix}@sail.local`;
  const password = `quiet harbour lantern ${String(Date.now()).slice(-4)} office`;
  const created = await register<{ data: { id: string } }>("POST", "/v1/staff", { name: `Office ${suffix}`, email, role });
  const link = await register<{ data: { url: string | null } }>("POST", `/v1/staff/${created.data.id}/invite`, {});
  const token = new URL(link.data.url!).hash.replace(/^#token=/, "");
  await fetch(`${API}/v1/auth/links/accept`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ token, password }) });
  await signInToken(API, email, password);
  return { email, password, id: created.data.id };
}

/** A paid takeaway Kopi on the Singapore demo outlet, by a tender that is neither cash nor a terminal. */
async function paidOrder() {
  const { outletId, brandId } = devLocal();
  const products = await register<{ data: { id: string; name: string }[] }>("GET", "/v1/products?limit=50");
  const kopi = products.data.find((p) => p.name === "Kopi")!;
  const tenders = await register<{ data: { id: string; name: string; is_cash: boolean; provider?: string | null }[] }>("GET", "/v1/tender-types");
  const byHand = tenders.data.find((t) => !t.is_cash && !t.provider)!;
  const order = await register<{ data: { id: string; order_no: string } }>("POST", "/v1/orders", { order_id: crypto.randomUUID(), order_type: "takeaway", takeaway_ref: "Export", outlet_id: outletId, brand_id: brandId });
  const added = await register<{ data: { balance: number; checks: { id: string }[] } }>("POST", `/v1/orders/${order.data.id}/lines`, { lines: [{ line_id: crypto.randomUUID(), product_id: kopi.id, quantity: 2 }] });
  await register("POST", `/v1/orders/${order.data.id}/fire`, {});
  await register("POST", `/v1/checks/${added.data.checks[0]!.id}/payments`, { payment_id: crypto.randomUUID(), tender_type_id: byHand.id, amount: added.data.balance });
  await register("POST", `/v1/orders/${order.data.id}/complete`, {}).catch(() => undefined);
  return { order: order.data, tender: byHand.name };
}

async function downloadCsv(page: Page): Promise<{ name: string; rows: string[][] }> {
  await page.getByRole("button", { name: "Export" }).click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: "Download CSV" }).click()]);
  const text = readFileSync((await download.path())!, "utf8").replace(/^﻿/, "");
  // The cells in these tests hold no commas or quotes, so a plain split reads them.
  return { name: download.suggestedFilename(), rows: text.split("\r\n").map((l) => (l ? l.split(",") : [])) };
}

/** A shown amount ("$3.50", "-$0.20", "S$ 1.234,50") as the plain decimal the CSV holds. */
function plain(shown: string): string {
  const negative = /[-−]/.test(shown);
  const digits = shown.replace(/[^\d]/g, "");
  const n = digits.padStart(3, "0");
  return `${negative && Number(digits) !== 0 ? "-" : ""}${String(Number(n.slice(0, -2)))}.${n.slice(-2)}`;
}

test.describe("O1 (A P3): every report downloads as CSV with the screen's figures, and prints without the app around it", () => {
  test("Sales: the CSV has the page's rows and totals, ISO dates, plain decimals and the currency; the range is in the address", async ({ page }) => {
    test.setTimeout(300_000);
    const { tender } = await paidOrder();
    await signIn(page);
    await page.goto(`${WEB}/reports/sales`);
    await expect(page.getByRole("grid", { name: "Sales by payment method" }).getByRole("rowheader", { name: tender })).toBeVisible();
    await expect(page).toHaveURL(/from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
    const from = new URL(page.url()).searchParams.get("from")!;

    const collected = await page.locator("dl > div", { has: page.locator("dt", { hasText: /^Collected$/ }) }).first().locator("dd").innerText();
    const tenderAmount = await page.getByRole("grid", { name: "Sales by payment method" }).getByRole("row", { name: new RegExp(tender) }).getByRole("gridcell").nth(1).innerText();
    const { name, rows } = await downloadCsv(page);
    expect(name).toBe(`sales-${from}-${from}.csv`);
    expect(rows[0]).toEqual(["Sales"]);
    expect(rows).toContainEqual(["From", from]);
    expect(rows).toContainEqual(["Currency", "SGD"]);
    expect(rows).toContainEqual(["Collected", plain(collected)]);
    const header = rows.findIndex((r) => r[0] === "Payment method");
    expect(rows[header]).toEqual(expect.arrayContaining(["Payment method", "Payments", "Amount"]));
    const tenderRow = rows.slice(header + 1).find((r) => r[0] === tender)!;
    expect(tenderRow[rows[header]!.indexOf("Amount")]).toBe(plain(tenderAmount));
    const byDay = rows.findIndex((r) => r[0] === "Business date");
    expect(rows[byDay + 1]![0]).toBe(from);

    // A refresh keeps a range the owner chose (A P14).
    await page.goto(`${WEB}/reports/sales?from=2026-01-01&to=${from}`);
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`from=2026-01-01&to=${from}`));
    await expect(page.getByRole("grid", { name: "Sales by day" })).toBeVisible();
    expect((await downloadCsv(page)).rows).toContainEqual(["From", "2026-01-01"]);

    // The print view: no rail, no filters, the report's own title and range on top.
    await page.emulateMedia({ media: "print" });
    await expect(page.getByRole("navigation").first()).toBeHidden();
    await expect(page.getByRole("button", { name: "Export" })).toBeHidden();
    await expect(page.getByRole("heading", { name: "Sales", exact: true })).toBeVisible();
    await page.emulateMedia({ media: "screen" });
  });

  test("Z-report, Items, Shifts and Print health each export their figures", async ({ page }) => {
    test.setTimeout(300_000);
    await signIn(page);
    await page.goto(`${WEB}/reports/z-report`);
    await expect(page.getByRole("heading", { name: "Cash drawer" })).toBeVisible();
    const expected = await page.locator("dl > div", { has: page.locator("dt", { hasText: /^Expected in the drawer$/ }) }).locator("dd").innerText();
    let csv = await downloadCsv(page);
    expect(csv.rows[0]).toEqual(["Z-report"]);
    expect(csv.rows).toContainEqual(["Cash drawer"]);
    expect(csv.rows).toContainEqual(["Expected in the drawer", plain(expected)]);
    await expect(page).toHaveURL(/date=\d{4}-\d{2}-\d{2}/);

    await page.goto(`${WEB}/reports/items`);
    await expect(page.getByRole("grid", { name: "Items sold" }).getByRole("rowheader", { name: "Kopi" })).toBeVisible();
    const kopiNet = await page.getByRole("grid", { name: "Items sold" }).getByRole("row", { name: /Kopi/ }).getByRole("gridcell").nth(4).innerText();
    csv = await downloadCsv(page);
    const head = csv.rows.findIndex((r) => r[0] === "Name");
    expect(csv.rows[head]).toEqual(["Name", "Sold", "Gross", "Discounts", "Refunds", "Net", "Share of net"]);
    expect(csv.rows.find((r) => r[0] === "Kopi")![5]).toBe(plain(kopiNet));

    await page.goto(`${WEB}/reports/shifts`);
    await expect(page.getByRole("grid", { name: "Shifts" })).toBeVisible();
    csv = await downloadCsv(page);
    expect(csv.rows).toContainEqual(["Opened", "Business date", "Shift", "Opened by", "Status", "Float", "Expected", "Counted", "Variance", "Closed", "Closed by"]);
    // A closed shift's row: the close time and the closer in their own columns, the time an ISO instant (review 5, V5).
    const shiftsHead = csv.rows.findIndex((r) => r[0] === "Opened" && r.at(-1) === "Closed by");
    for (const r of csv.rows.slice(shiftsHead + 1).filter((x) => x[4] === "Closed")) {
      expect(r[9], r.join(",")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
      expect(r[10], r.join(",")).not.toMatch(/\d{4}-\d{2}/);
    }

    await page.goto(`${WEB}/reports/print-health`);
    await expect(page.getByRole("grid", { name: "Print health by printer" })).toBeVisible();
    csv = await downloadCsv(page);
    expect(csv.rows[0]).toEqual(["Print health"]);
    expect(csv.rows.some((r) => r[0] === "Printer")).toBe(true);
  });
});

test.describe("O3 (A P13, P7): the import page", () => {
  test("history has the page's width and follows the report; a run with nothing to apply cannot be applied", async ({ page }, info) => {
    test.setTimeout(300_000);
    await signIn(page);
    await page.goto(`${WEB}/menu/import`);
    const file = info.outputPath("products.csv");
    // Every row refused: nothing to create or update.
    writeFileSync(file, "sku,name,price,kind\nX-1,,abc,widget\n");
    await page.locator("input[type=file]").setInputFiles(file);
    await page.getByRole("button", { name: /Run a dry run/ }).click();
    const apply = page.getByRole("button", { name: /^Apply 0 changes$/ });
    await expect(apply).toBeDisabled();
    await expect(page.getByText("Nothing to apply: every row is unchanged or rejected.")).toBeVisible();
    // The rejected row says every problem it has.
    const reason = page.getByRole("grid", { name: "Rejected rows" }).getByRole("row").nth(1);
    await expect(reason).toContainText("name is required");
    await expect(reason).toContainText('kind "widget" is not product or component');
    // The history row says what the report says as soon as the report has it.
    const latest = page.getByRole("grid", { name: "Import jobs" }).getByRole("row").nth(1);
    await expect(latest).toContainText("Dry run complete", { timeout: 2_000 });
    // Five readable columns: the history spans the page, not a crushed side column.
    const grid = await page.getByRole("grid", { name: "Import jobs" }).boundingBox();
    expect(grid!.width).toBeGreaterThan(800);
    const result = await latest.getByRole("gridcell").last().boundingBox();
    expect(result!.height).toBeLessThan(60);
  });

  test("a Manager is not offered the Import tab, and the page names the role it needs", async ({ page, watch }) => {
    test.setTimeout(300_000);
    watch.allow({ status: 403, url: /\/menu\/import/, why: "a Manager may not open the importer" });
    const { email, password } = await loginFor("manager");
    await signIn(page, email, password);
    await page.goto(`${WEB}/menu/products`);
    const tabs = page.getByRole("navigation", { name: "Menu sections" });
    await expect(tabs.getByRole("link", { name: "Products" })).toBeVisible();
    await expect(tabs.getByRole("link", { name: "Import" })).toHaveCount(0);
    await page.goto(`${WEB}/menu/import`);
    await expect(page.getByText("You are signed in with the Manager role. This page needs an Admin.")).toBeVisible();
  });
});

test("O6 (A P12): the rail has no destination that does nothing; Changes is the audit log", async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);
  const rail = page.getByRole("navigation", { name: "Sections" });
  await expect(rail.getByRole("link", { name: "Assistants" })).toHaveCount(0);
  await rail.getByRole("link", { name: "Changes" }).click();
  await expect(page).toHaveURL(`${WEB}/audit`);
  await expect(page.getByRole("heading", { level: 1, name: "Changes" })).toBeVisible();
  await expect(page.getByText(/arrives in a later phase/)).toHaveCount(0);
  await page.goto(`${WEB}/changes`);
  await expect(page).toHaveURL(`${WEB}/audit`);
});

test.describe("O4 (A P9, P16): pickers", () => {
  test("Enter adds the highlighted option and keeps the sheet open; an added product says so; the search clears; an empty group says why it cannot save", async ({ page }) => {
    test.setTimeout(300_000);
    await signIn(page);
    await page.goto(`${WEB}/menu/modifiers`);
    await page.getByRole("button", { name: "Add modifier group" }).first().click();
    const sheet = page.getByRole("dialog");
    await sheet.getByLabel("Name").fill(`Picker ${Date.now()}`);
    const search = sheet.getByRole("searchbox", { name: "Add an option" });
    await search.fill("Kopi");
    await expect(sheet.getByRole("list", { name: "Results" }).getByRole("button", { name: /Kopi/ }).first()).toBeVisible();
    await search.press("Enter");
    // The sheet stays, the option is in, and the search is empty for the next one.
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Remove Kopi" })).toBeVisible();
    await expect(search).toHaveValue("");
    // Searching it again says it is already added, not that nothing matches.
    await search.fill("Kopi");
    const again = sheet.getByRole("list", { name: "Results" }).getByRole("button", { name: /^Kopi/ }).first();
    await expect(again).toContainText("Already added");
    await expect(again).toBeDisabled();
    await expect(sheet.getByText(/No products match/)).toHaveCount(0);
    // An empty group cannot be saved, and says why.
    await search.fill("");
    await sheet.getByRole("button", { name: "Remove Kopi" }).click();
    await sheet.getByRole("button", { name: "Add modifier group" }).click();
    await expect(sheet.getByText("Add at least one option: a group without options gives nothing to choose.")).toBeVisible();
    await expect(sheet).toBeVisible();
  });
});

test.describe("O8 (A P15), O11 (round 8 S-6): archive and remove ask once", () => {
  test("Archive menu is in the row's overflow and asks, naming the POS and the guest menu; a section with products asks before it goes", async ({ page }) => {
    test.setTimeout(300_000);
    await signIn(page);
    await page.goto(`${WEB}/menu/menus`);
    await expect(page.getByRole("button", { name: "Archive menu" })).toHaveCount(0);
    await page.getByRole("button", { name: "More for this menu" }).click();
    await page.getByRole("menuitem", { name: "Archive menu" }).click();
    const ask = page.getByRole("alertdialog");
    await expect(ask).toContainText("It stops showing on the POS and the guest menu");
    await ask.getByRole("button", { name: "Keep the menu" }).click();
    await expect(ask).toBeHidden();
    await expect(page.getByRole("button", { name: "More for this menu" })).toBeVisible();

    // A section that holds products asks once; keeping it changes nothing.
    const remove = page.getByRole("button", { name: /^Remove (?!.* from )/ }).first();
    await remove.click();
    await expect(ask).toContainText("The products themselves stay.");
    await ask.getByRole("button", { name: "Keep it" }).click();
    await expect(page.getByRole("button", { name: "Saved" })).toBeVisible();

    // A product already in another section shows where, in an open search list.
    await page.getByRole("button", { name: "Products" }).nth(1).click();
    const firstItem = (await page.locator("ol ol li").first().innerText()).split("\n")[0]!.trim();
    await page.getByRole("searchbox").fill(firstItem.slice(0, 4));
    await expect(page.getByRole("list", { name: "Results" })).toContainText(/In |Already added/);
  });

  test("Archive product asks once and says what disappears", async ({ page }) => {
    test.setTimeout(300_000);
    await signIn(page);
    await page.goto(`${WEB}/menu/products`);
    await page.getByRole("grid").getByRole("row").nth(1).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("button", { name: "Archive product" }).click();
    const ask = page.getByRole("alertdialog");
    await expect(ask).toContainText("It stops showing on the POS and the guest menu at once.");
    await ask.getByRole("button", { name: "Keep the product" }).click();
    await expect(sheet.getByRole("button", { name: "Archive product" })).toBeVisible();
  });
});

test("O5 (A P11): Forgotten your password? says how to get a reset link without an Admin above you", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto(`${WEB}/login`);
  await page.getByRole("link", { name: "Forgotten your password?" }).click();
  // A link is a client-side navigation, and the dev server compiles the page on its first visit: allow it the time
  // a `goto` gets, not the 15 s of an ordinary check.
  await expect(page).toHaveURL(`${WEB}/forgot-password`, { timeout: 120_000 });
  await expect(page.getByRole("heading", { level: 1, name: "Forgotten your password?" })).toBeVisible();
  await expect(page.getByText("MIGRATE_DATABASE_URL=… WEB_APP_URL=… pnpm --filter @sail/server reset-link you@example.com")).toBeVisible();
  await expect(page.getByText(/Ask an Admin for a reset link/)).toHaveCount(0);
  await page.getByRole("link", { name: "Back to sign in" }).click();
  await expect(page).toHaveURL(`${WEB}/login`);
});

test("O7 (A P14): an open order is in the address, so a refresh keeps it and the link opens it", async ({ page }) => {
  test.setTimeout(300_000);
  const { order } = await paidOrder();
  await signIn(page);
  await page.goto(`${WEB}/orders`);
  await page.getByRole("grid").getByRole("row", { name: new RegExp(order.order_no) }).first().click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toContainText(order.order_no);
  await expect(page).toHaveURL(new RegExp(`order=${order.id}`));
  await page.reload();
  await expect(page.getByRole("dialog")).toContainText(order.order_no);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page).not.toHaveURL(/order=/);
});

test("O10 (round 8 check 8): Sign out pressed before the page has hydrated still signs out; the rail's menus say they are not ready", async ({ page, watch }) => {
  test.setTimeout(300_000);
  await signIn(page);
  // The page's scripts never arrive: what is pressed is the server-rendered markup alone.
  watch.allowConsole(/./);
  await page.route(/\/_next\/static\/.*\.js/, (route) => route.abort());
  await page.goto(`${WEB}/pricing/rules`);
  await expect(page.getByRole("button", { name: /Open user menu/ })).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByRole("button", { name: /^Scope:/ }).first()).toHaveAttribute("aria-disabled", "true");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(/\/login/);
  await page.unroute(/\/_next\/static\/.*\.js/);
  // The session is over: the back office sends the browser to sign in again.
  await page.goto(`${WEB}/today`);
  await expect(page).toHaveURL(/\/login/);
});

test.describe("O9 (A P17–P20): small back-office fixes", () => {
  test("Team: a Manager is told who adds staff; a PIN someone else uses is said once, at the PIN field", async ({ page, watch }) => {
    test.setTimeout(300_000);
    watch.allow({ status: 409, url: /\/v1\/staff$/, why: "the PIN is taken on purpose" });
    await signIn(page);
    await page.goto(`${WEB}/team`);
    await page.getByRole("button", { name: "Add staff member" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByLabel("Name").fill(`Pin Clash ${Date.now()}`);
    // The seeded Admin's PIN.
    await sheet.getByLabel("PIN (optional)").fill("123456");
    await sheet.getByRole("button", { name: "Add staff member" }).click();
    const said = sheet.getByText("Someone at this business already uses that PIN");
    await expect(said).toHaveCount(1);
    await expect(said).toBeInViewport();
    await page.keyboard.press("Escape");

    await page.context().clearCookies();
    const { email, password } = await loginFor("manager");
    await signIn(page, email, password);
    await page.goto(`${WEB}/team`);
    await expect(page.getByText("Adding staff needs an Admin.")).toBeVisible();
  });

  test("Payment methods show their order as 1, 2, 3 and how each is taken; Products sort by column with steady widths; the cutoff help reads the right way", async ({ page }) => {
    test.setTimeout(300_000);
    await signIn(page);
    await page.goto(`${WEB}/settings/payment-methods`);
    const orders = await page.getByRole("grid").getByRole("row").locator("td, th").first().allInnerTexts();
    expect(orders).toBeTruthy();
    const firstCells = await page.getByRole("grid").getByRole("row").evaluateAll((rows) => rows.slice(1).map((r) => r.querySelector("td,th")?.textContent?.trim()));
    expect(firstCells.slice(0, 3)).toEqual(["1", "2", "3"]);
    await expect(page.getByRole("grid")).toContainText("Recorded by hand");

    await page.goto(`${WEB}/menu/products`);
    const grid = page.getByRole("grid", { name: "Products" });
    await expect(grid.getByRole("row").nth(1)).toBeVisible();
    const priceHeader = grid.getByRole("columnheader", { name: /Price/ });
    await priceHeader.click();
    await expect(priceHeader).toHaveAttribute("aria-sort", "ascending");
    const before = (await priceHeader.boundingBox())!.width;
    // Fewer rows under a filter keep the same column widths.
    await page.getByRole("searchbox", { name: "Search products" }).fill("Kopi");
    await expect(grid.getByRole("row")).not.toHaveCount(1);
    expect(Math.abs((await priceHeader.boundingBox())!.width - before)).toBeLessThan(2);
    await page.getByRole("searchbox", { name: "Search products" }).fill("zzzz-nothing");
    await expect(page.getByText("No products match")).toBeVisible();
    await expect(page.getByText(/0 of 0/)).toHaveCount(0);
    await page.getByRole("searchbox", { name: "Search products" }).fill("");
    await expect(grid.getByRole("row").nth(1)).toBeVisible();
    expect(Math.abs((await priceHeader.boundingBox())!.width - before)).toBeLessThan(2);

    await page.goto(`${WEB}/settings/merchant`);
    await expect(page.getByText(/Sales before this time count towards the day before/)).toBeVisible();
  });
});

test("O9 (A P19): an amount typed with the other decimal mark is read (3,40 is 3.40 in en-SG); the simulator does not call tax-inclusive amounts net", async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);
  await page.goto(`${WEB}/menu/products`);
  await page.getByRole("grid", { name: "Products" }).getByRole("row").nth(1).click();
  const sheet = page.getByRole("dialog");
  const price = sheet.getByRole("textbox", { name: "Base price" });
  await price.fill("3,40");
  await price.press("Tab");
  await expect(price).toHaveValue("3.40");
  await expect(sheet.getByRole("button", { name: "Save changes" })).toBeEnabled();
  await page.keyboard.press("Escape");

  await page.context().clearCookies();
  await signIn(page, "admin.eu@sail.local");
  await page.goto(`${WEB}/pricing/simulator`);
  await page.getByRole("searchbox", { name: "Add to basket" }).fill("Kaffee");
  await page.getByRole("list", { name: "Results" }).getByRole("button", { name: /^Kaffee/ }).first().click();
  await page.getByRole("button", { name: "Price this basket" }).click();
  await expect(page.getByText("After discounts, tax included")).toBeVisible();
  await expect(page.getByText("Net subtotal")).toHaveCount(0);
});
