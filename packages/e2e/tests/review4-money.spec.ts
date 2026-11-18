import type { Page } from "@playwright/test";
import { devLocal, EU_ADMIN, expect, pairAndSignIn, register, SG_ADMIN, shot, test, WEB } from "./fixtures";

/**
 * Fourth review round, money (`fix/review4-money`): one request per click in the back-office order drawer, and the
 * Z-report and Sales layout. The figures are held by `server/test/review4-money.test.ts`.
 */
const out = (name: string) => (process.env.REVIEW4_SHOTS ? `${process.env.REVIEW4_SHOTS}/${name}` : test.info().outputPath(name));

async function officeSignIn(page: Page, email = SG_ADMIN) {
  await page.goto(`${WEB}/login`);
  await expect(async () => {
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(devLocal().admin_password);
    await page.getByRole("button", { name: "Sign in" }).click({ timeout: 10_000 });
    await page.waitForURL(`${WEB}/today`, { timeout: 30_000 });
  }).toPass({ timeout: 300_000 });
}

type Tender = { id: string; is_cash: boolean; provider?: string | null };
type Order = { id: string; order_no: string; status: string; balance: number; checks: { id: string; balance: number }[] };


async function bothThemes(page: Page, name: string, fullPage = false) {
  for (const theme of ["day", "service"] as const) {
    await page.evaluate((t) => (t === "service" ? (document.documentElement.dataset.theme = "service") : delete document.documentElement.dataset.theme), theme);
    await page.waitForTimeout(150);
    if (fullPage) await page.screenshot({ path: out(`${name}-${theme}.png`), fullPage: true });
    else await shot(page, out(`${name}-${theme}.png`));
  }
  await page.evaluate(() => delete document.documentElement.dataset.theme);
}

/** Pay what is owed with the keyed card (no drawer, no terminal), send what is unsent and bump its tickets. */
async function payAndClear(orderId: string, admin = SG_ADMIN) {
  const outletId = admin === EU_ADMIN ? devLocal().eu.outletId : devLocal().outletId;
  const tenders = await register<{ data: Tender[] }>("GET", "/v1/tender-types", undefined, admin);
  const byHand = tenders.data.find((t) => !t.is_cash && !t.provider)!;
  await register("POST", `/v1/orders/${orderId}/fire`, {}, admin).catch(() => undefined);
  const now = await register<{ data: Order }>("GET", `/v1/orders/${orderId}`, undefined, admin);
  for (const c of now.data.checks.filter((x) => x.balance > 0)) await register("POST", `/v1/checks/${c.id}/payments`, { payment_id: crypto.randomUUID(), tender_type_id: byHand.id, amount: c.balance }, admin);
  await register("POST", `/v1/orders/${orderId}/complete`, {}, admin).catch(() => undefined);
  const tickets = await register<{ data: { id: string; order_id: string }[] }>("GET", `/v1/outlets/${outletId}/kitchen-tickets`, undefined, admin);
  for (const t of tickets.data.filter((x) => x.order_id === orderId)) await register("POST", `/v1/kitchen-tickets/${t.id}/bump`, {}, admin).catch(() => undefined);
}

/** A takeaway paid by keyed card, with a card refund of one item from the back office and a reopened, re-paid order beside it. */
async function dayWithRefundAndReversal(admin: string, products: string[]) {
  const { outletId, brandId } = admin === EU_ADMIN ? devLocal().eu : devLocal();
  const all = (await register<{ data: { id: string; name: string }[] }>("GET", "/v1/products?limit=50", undefined, admin)).data;
  const ids = products.map((n) => all.find((p) => p.name === n)!.id);
  const orders: Order[] = [];
  for (const _ of [0, 1]) {
    const o = await register<{ data: Order }>("POST", "/v1/orders", { order_id: crypto.randomUUID(), order_type: "takeaway", takeaway_ref: "Review 4", outlet_id: outletId, brand_id: brandId }, admin);
    await register("POST", `/v1/orders/${o.data.id}/lines`, { lines: ids.map((product_id) => ({ line_id: crypto.randomUUID(), product_id, quantity: 1 })) }, admin);
    await payAndClear(o.data.id, admin);
    orders.push((await register<{ data: Order & { lines: { id: string }[] } }>("GET", `/v1/orders/${o.data.id}`, undefined, admin)).data);
  }
  const first = orders[0] as Order & { lines: { id: string }[] };
  await register("POST", `/v1/checks/${first.checks[0]!.id}/refunds`, { refund_id: crypto.randomUUID(), request: { kind: "lines", lines: [{ line_id: first.lines[0]!.id, quantity: 1 }] }, reason: "Wrong item keyed", print: false }, admin);
  await register("POST", `/v1/orders/${orders[1]!.id}/reopen`, { reason: "Wrong payment method" }, admin);
  await payAndClear(orders[1]!.id, admin);
}

test("T2: one click on Reopen order sends one reopen; the sheet's check is a dry run, sent once as it opens", async ({ page }) => {
  test.setTimeout(300_000);
  const { outletId, brandId } = devLocal();
  const kopi = (await register<{ data: { id: string; name: string }[] }>("GET", "/v1/products?limit=50")).data.find((p) => p.name === "Kopi")!;
  const o = await register<{ data: Order }>("POST", "/v1/orders", { order_id: crypto.randomUUID(), order_type: "takeaway", takeaway_ref: "Review 4", outlet_id: outletId, brand_id: brandId });
  await register("POST", `/v1/orders/${o.data.id}/lines`, { lines: [{ line_id: crypto.randomUUID(), product_id: kopi.id, quantity: 1 }] });
  await payAndClear(o.data.id);
  expect((await register<{ data: Order }>("GET", `/v1/orders/${o.data.id}`)).data.status).toBe("completed");

  const reopens: { dryRun: boolean; at: number }[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/v1\/orders\/[^/]+\/reopen$/.test(r.url())) reopens.push({ dryRun: Boolean((r.postDataJSON() as { dry_run?: boolean } | null)?.dry_run), at: Date.now() });
  });
  // The preview answered in about a second; the drawer must still send one reopen per click when the register is slow.
  await page.route(/\/v1\/orders\/[^/]+(\/reopen)?$/, async (route) => {
    await new Promise((r) => setTimeout(r, 1_000));
    await route.continue();
  });
  try {
    await officeSignIn(page);
    await page.goto(`${WEB}/orders`);
    await page.getByRole("group", { name: "Which orders" }).getByRole("button", { name: /^Today's closed/ }).click().catch(() => undefined);
    await page.getByRole("grid").getByRole("row").filter({ hasText: o.data.order_no }).first().click();
    const drawer = page.getByRole("dialog");
    await drawer.getByRole("button", { name: "Reopen order", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: `Reopen ${o.data.order_no}` });
    await sheet.getByLabel("Reason").fill("Wrong items were paid for");
    await expect.poll(() => reopens.length).toBe(1);
    expect(reopens[0]!.dryRun).toBe(true);
    await sheet.getByRole("button", { name: "Reopen order" }).click();
    await expect(page.getByText("Order reopened. Its payments are reversed and the bills are open again.")).toBeVisible();
    // The drawer reloads the order; nothing asks the register to reopen it again (the reviewer saw 200, 200, 409).
    await page.waitForTimeout(3_000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForTimeout(1_000);
    expect(reopens.map((r) => r.dryRun)).toEqual([true, false]);
    await shot(page, out("T2-reopened-drawer.png"));
  } finally {
    await payAndClear(o.data.id);
  }
});

for (const merchant of ["sg", "eu"] as const) {
  test(`T3 (${merchant}): the back-office Z-report and Sales read top to bottom; a reversed payment is not under a net`, async ({ page }) => {
    test.setTimeout(300_000);
    const admin = merchant === "eu" ? EU_ADMIN : SG_ADMIN;
    await dayWithRefundAndReversal(admin, merchant === "eu" ? ["Kaffee", "Apfelstrudel"] : ["Kopi"]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await officeSignIn(page, admin);
    await page.goto(`${WEB}/reports/z-report`);
    await expect(page.getByRole("heading", { name: "Payments", exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("Reversed, not counted")).toHaveCount(0);
    if (merchant === "eu") {
      await expect(page.getByText("Of which net before refunds", { exact: true })).toBeVisible();
      await expect(page.getByText("Tax in prices", { exact: true })).toHaveCount(0);
    } else await expect(page.getByText("Net before refunds", { exact: true })).toBeVisible();
    // The keyed card is not a terminal: its net does not claim to be what a terminal shows.
    await expect(page.getByText("Card net, as the terminal shows", { exact: true })).toHaveCount(0);
    await page.waitForTimeout(500);
    await bothThemes(page, `T3-${merchant}-office-z-report`, true);
    await page.goto(`${WEB}/reports/sales`);
    await expect(page.getByText("Collected after refunds", { exact: true })).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(500);
    await bothThemes(page, `T3-${merchant}-office-sales`, true);
  });
}

test("T3 (eu): the POS Z-report has the same rows, and a reversed payment apart from the tenders' nets", async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1180, height: 820 });
  await pairAndSignIn(page, "123456", "eu");
  await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Shift", exact: true }).click();
  await page.getByRole("group", { name: "Shift section" }).getByRole("button", { name: "Z-report" }).click();
  await expect(page.getByRole("heading", { name: "Z-report" })).toBeVisible();
  await page.getByRole("group", { name: "Report scope" }).getByRole("button", { name: "Whole outlet" }).click();
  await expect(page.getByText("Of which net before refunds", { exact: true })).toBeVisible();
  await expect(page.getByText(/taken and reversed$/).first()).toBeVisible();
  await page.waitForTimeout(500);
  await bothThemes(page, "T3-eu-pos-z-report", true);
  await page.getByText(/taken and reversed$/).first().scrollIntoViewIfNeeded();
  await bothThemes(page, "T3-eu-pos-z-report-tenders");
});
