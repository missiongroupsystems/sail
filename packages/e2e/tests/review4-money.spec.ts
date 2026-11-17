import type { Page } from "@playwright/test";
import { devLocal, expect, register, SG_ADMIN, shot, test, WEB } from "./fixtures";

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

/** Pay what is owed with the keyed card (no drawer, no terminal), send what is unsent and bump its tickets. */
async function payAndClear(orderId: string) {
  const tenders = await register<{ data: Tender[] }>("GET", "/v1/tender-types");
  const byHand = tenders.data.find((t) => !t.is_cash && !t.provider)!;
  await register("POST", `/v1/orders/${orderId}/fire`, {}).catch(() => undefined);
  const now = await register<{ data: Order }>("GET", `/v1/orders/${orderId}`);
  for (const c of now.data.checks.filter((x) => x.balance > 0)) await register("POST", `/v1/checks/${c.id}/payments`, { payment_id: crypto.randomUUID(), tender_type_id: byHand.id, amount: c.balance });
  await register("POST", `/v1/orders/${orderId}/complete`, {}).catch(() => undefined);
  const tickets = await register<{ data: { id: string; order_id: string }[] }>("GET", `/v1/outlets/${devLocal().outletId}/kitchen-tickets`);
  for (const t of tickets.data.filter((x) => x.order_id === orderId)) await register("POST", `/v1/kitchen-tickets/${t.id}/bump`, {}).catch(() => undefined);
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
