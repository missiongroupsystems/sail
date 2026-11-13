import type { Page } from "@playwright/test";
import { API, devLocal, expect, pairAndSignIn, register, signInToken, SG_ADMIN, test } from "./fixtures";

/**
 * Tips and refunds on the POS: the screens show the register's figures and add nothing up. Each check reads the same
 * figure from the register's API and holds the screen to it, so it holds on a register that gives tips back with a
 * whole-bill refund and caps tips at the bill, and on one that does neither.
 */

const MANAGER_PIN = "222222";
const CASHIER_PIN = "333333";

test.use({ viewport: { width: 1180, height: 820 } });

/** "$12.34" to cents. */
const cents = (text: string) => {
  const m = /\$([\d,]+)\.(\d\d)/.exec(text);
  if (!m) throw new Error(`no amount in "${text}"`);
  return Number(m[1]!.replace(/,/g, "")) * 100 + Number(m[2]);
};

async function takeawayToPay(page: Page) {
  await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Floor", exact: true }).click();
  await page.getByRole("button", { name: "Takeaway order", exact: true }).click();
  await page.getByRole("button", { name: /^Mee Goreng,/ }).click();
  await page.getByRole("button", { name: "Send 1 to kitchen" }).click();
  await expect(page.getByRole("region", { name: "Order" }).getByText(/^Sent /)).toBeVisible();
  await page.getByRole("button", { name: /^Pay \$/ }).click();
  await expect(page.getByRole("region", { name: "Payment" })).toBeVisible();
}

/** Type a figure on the pay screen's keypad. */
async function keypad(page: Page, digits: string) {
  const pad = page.getByRole("group", { name: "Amount keys" }).last();
  for (const d of digits) await pad.getByRole("button", { name: d, exact: true }).click();
}

test("a part payment says what is left on the bill, and counts no other bills", async ({ page }) => {
  test.setTimeout(300_000);
  await pairAndSignIn(page, CASHIER_PIN);
  await takeawayToPay(page);
  await page.getByRole("group", { name: "Payment method" }).getByRole("button", { name: "Card", exact: true }).click();
  // The first key replaces the prefilled balance: 1, 0, 0 is $1.00.
  await keypad(page, "100");
  await expect(page.getByRole("button", { name: /^Amount \$1\.00, tap to edit/ })).toBeVisible();
  await page.getByRole("button", { name: /^Take \$1\.00 by Card/ }).click();
  await expect(page.getByRole("region", { name: "Paid · Bill 1 · $1.00" })).toBeVisible();
  await expect(page.getByText(/^\$[\d,.]+ left to pay on Bill 1\.$/)).toBeVisible();
  await expect(page.getByText(/more bills? to pay on this order/)).toHaveCount(0);
});

test("a tip the register refuses keeps the pay screen open on the tip, with the register's words", async ({ page, watch }) => {
  test.setTimeout(300_000);
  watch.allow({ status: 400, url: /\/v1\/checks\/[^/]+\/payments/, why: "the tip is far above the bill on purpose" });
  await register("PATCH", "/v1/merchant/settings", { tips_enabled: true });
  try {
    await pairAndSignIn(page, CASHIER_PIN);
    await takeawayToPay(page);
    await page.getByRole("group", { name: "Payment method" }).getByRole("button", { name: "Card", exact: true }).click();
    await page.getByRole("button", { name: "Type the tip" }).click();
    await keypad(page, "99999");
    const pay = page.getByRole("region", { name: "Payment" });
    // What this register says about a $999.99 tip on this bill: refused with its cap, or taken.
    const refused = pay.getByRole("alert").filter({ hasText: /more than the bill/ });
    // The dry run answers one way or the other: the register's refusal, or the tip in the terminal instruction.
    const taken = pay.getByText(/including a \$999\.99 tip/);
    await expect(refused.or(taken).first()).toBeVisible({ timeout: 15_000 });
    if (await refused.count()) {
      await expect(refused).toContainText(/or less/);
      await expect(page.getByRole("button", { name: "Type the tip" })).toBeFocused();
      await expect(pay).toBeVisible();
    } else {
      await expect(page.getByRole("button", { name: /^Take \$[\d,.]+ by Card/ })).toBeEnabled();
    }
  } finally {
    await register("PATCH", "/v1/merchant/settings", { tips_enabled: false });
  }
});

test("refunds show the register's tip figures: a whole-bill refund gives the tip back as its own row; by items it stays", async ({ page }) => {
  test.setTimeout(300_000);
  await register("PATCH", "/v1/merchant/settings", { tips_enabled: true });
  try {
    await pairAndSignIn(page, MANAGER_PIN);
    await takeawayToPay(page);
    await page.getByRole("group", { name: "Payment method" }).getByRole("button", { name: "Card", exact: true }).click();
    await page.getByRole("button", { name: "Type the tip" }).click();
    await page.getByRole("group", { name: "Tip" }).getByRole("button", { name: "Tip 15%" }).click();
    const take = page.getByRole("button", { name: /^Take \$[\d.]+ by Card/ });
    await expect(take).toBeEnabled();
    await take.click();
    await expect(page.getByText(/^Paid · Bill 1 · /)).toBeVisible();
    await page.getByRole("button", { name: "No receipt" }).click();

    await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Orders", exact: true }).click();
    await page.getByRole("group", { name: "Which orders" }).getByRole("button", { name: "Today's closed" }).click();
    await page.getByRole("button", { name: /^Takeaway .*, Done$/ }).first().click();
    await page.getByRole("listitem").filter({ hasText: /^Bill 1/ }).getByRole("button", { name: "Refund" }).click();
    const sheet = page.getByRole("dialog", { name: "Refund" });

    // By items: the tip stays with the bill, and the quote gives none of it back.
    await sheet.getByRole("group", { name: "What to refund" }).getByRole("button", { name: "Some items" }).click();
    await expect(sheet.getByText("The tip stays with the bill unless you choose Whole bill.")).toBeVisible();
    await expect(sheet.getByText("Tip given back")).toHaveCount(0);

    // Whole bill: the summary shows the register's own quote for it, the tip as its own row when it goes back.
    await sheet.getByRole("group", { name: "What to refund" }).getByRole("button", { name: "Whole bill" }).click();
    const { outletId } = devLocal();
    const orders = await register<{ data: { id: string; checks: { id: string }[] }[] }>("GET", `/v1/outlets/${outletId}/orders?status=completed&limit=1`);
    const checkId = orders.data[0]!.checks[0]!.id;
    const token = await signInToken(API, SG_ADMIN, devLocal().admin_password);
    const quoted = (await (await fetch(`${API}/v1/checks/${checkId}/refunds/quote`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ request: { kind: "full" } }) })).json()) as { data: { totals: { total: number }; tip?: number } };
    const summary = sheet.getByRole("complementary", { name: "Refund summary" });
    await expect(summary.getByText("Checking…")).toHaveCount(0);
    expect(cents(await summary.locator("div").filter({ hasText: /^Refund/ }).last().innerText())).toBe(quoted.data.totals.total);
    if (quoted.data.tip) await expect(summary.getByText("Tip given back")).toBeVisible();
    else await expect(summary.getByText("Tip given back")).toHaveCount(0);
  } finally {
    await register("PATCH", "/v1/merchant/settings", { tips_enabled: false });
  }
});
