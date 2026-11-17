import type { Page } from "@playwright/test";
import { devLocal, expect, keyIn, leaveChecklistOpen, pairAndSignIn, register, shot, test } from "./fixtures";

/**
 * Third review round, front (`fix/review3-front`): the POS paid screen follows the register (a void, a switch of
 * user), the paid screen's invoice opens in the tap, prefilled count fields replace on typing, the line sheet's preview
 * follows the choices on screen, the kitchen display's header at 1024 wide, one primary button per screen, and the
 * small POS and guest items. Shots go to REVIEW3_SHOTS when set (the report's folder), else the test's output.
 */
const MANAGER_PIN = "222222";
const out = (name: string) => (process.env.REVIEW3_SHOTS ? `${process.env.REVIEW3_SHOTS}/${name}` : test.info().outputPath(name));

async function bothThemes(page: Page, name: string) {
  for (const theme of ["day", "service"] as const) {
    await page.evaluate((t) => (t === "service" ? (document.documentElement.dataset.theme = "service") : delete document.documentElement.dataset.theme), theme);
    await page.waitForTimeout(150);
    await shot(page, out(`${name}-${theme}.png`));
  }
  await page.evaluate(() => delete document.documentElement.dataset.theme);
}

async function bumpAll(orderId: string) {
  const tickets = await register<{ data: { id: string; order_id: string }[] }>("GET", `/v1/outlets/${devLocal().outletId}/kitchen-tickets`);
  for (const t of tickets.data.filter((x) => x.order_id === orderId)) await register("POST", `/v1/kitchen-tickets/${t.id}/bump`, {}).catch(() => undefined);
}

/** Leave nothing behind: the order paid by hand and completed, its tickets bumped. */
async function settle(orderId: string) {
  const o = await register<{ data: { status: string; checks: { id: string; balance: number }[] } }>("GET", `/v1/orders/${orderId}`);
  if (o.data.status !== "completed" && o.data.status !== "cancelled") {
    const tenders = await register<{ data: { id: string; is_cash: boolean; provider?: string | null }[] }>("GET", "/v1/tender-types");
    const byHand = tenders.data.find((t) => !t.is_cash && !t.provider)!;
    for (const c of o.data.checks.filter((x) => x.balance > 0)) await register("POST", `/v1/checks/${c.id}/payments`, { payment_id: crypto.randomUUID(), tender_type_id: byHand.id, amount: c.balance });
    await register("POST", `/v1/orders/${orderId}/complete`, {}).catch(() => undefined);
  }
  await bumpAll(orderId);
}

/** Seat a free table for two, add a Mee Goreng, send it and open the pay screen. */
async function sentToPay(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Floor", exact: true }).click();
  const free = page.getByRole("button", { name: /^Table \d+, Free/ }).first();
  const name = /^Table (\d+),/.exec((await free.getAttribute("aria-label")) ?? (await free.innerText()))?.[1];
  await free.click();
  await page.getByRole("button", { name: "2 guests", exact: true }).click();
  await page.getByRole("button", { name: /^Mee Goreng,/ }).click();
  await page.getByRole("button", { name: "Send 1 to kitchen" }).click();
  await expect(page.getByRole("region", { name: "Order" }).getByText(/^Sent /)).toBeVisible();
  await page.getByRole("button", { name: /^Pay \$/ }).click();
  await expect(page.getByRole("heading", { name: "Take payment" })).toBeVisible();
  const floor = await register<{ data: { tables: { name: string; order: { id: string } | null }[] } }>("GET", `/v1/outlets/${devLocal().outletId}/floor`);
  return floor.data.tables.find((t) => t.name === name)!.order!.id;
}

async function payOnTerminal(page: Page) {
  const methods = page.getByRole("group", { name: "Payment method" });
  await methods.getByRole("button", { name: /^More payment methods/ }).click();
  await methods.getByRole("button", { name: "Card (terminal)", exact: true }).click();
  await page.getByRole("button", { name: /^Send \$[\d.]+ to the terminal/ }).click();
  await expect(page.getByText(/^Paid · Bill 1 · /)).toBeVisible({ timeout: 30_000 });
}

test.describe("POS paid screen", () => {

  test("S1: voiding a terminal payment from the paid screen takes it back to the bill with its balance", async ({ page }) => {
    test.setTimeout(300_000);
    await pairAndSignIn(page, MANAGER_PIN);
    const orderId = await sentToPay(page);
    try {
      await payOnTerminal(page);
      await expect(page.getByText("Every bill is paid. The order is done.")).toBeVisible();
      await page.getByRole("button", { name: "Void payment", exact: true }).click();
      await page.getByRole("button", { name: "Wrong payment method", exact: true }).click();
      // The terminal gives the money back; the register reverses the payment and the bill owes it again.
      await expect(page.getByText("Every bill is paid. The order is done.")).toHaveCount(0, { timeout: 30_000 });
      await expect(page.getByRole("heading", { name: "Take payment" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Void payment", exact: true })).toHaveCount(0);
      const o = await register<{ data: { checks: { balance: number }[] } }>("GET", `/v1/orders/${orderId}`);
      expect(o.data.checks[0]!.balance).toBeGreaterThan(0);
      await shot(page, out("S1-after-terminal-void.png"));
    } finally {
      await settle(orderId);
    }
  });

  test("S2: switching user from the paid screen comes back to the floor, never to Take payment for a paid bill", async ({ page }) => {
    test.setTimeout(300_000);
    await pairAndSignIn(page, MANAGER_PIN);
    const orderId = await sentToPay(page);
    try {
      await payOnTerminal(page);
      await page.getByRole("button", { name: /Open user menu$/ }).click();
      await page.getByRole("menuitem", { name: "Switch user" }).click();
      await expect(page.getByRole("button", { name: "Pair this iPad again" })).toBeVisible();
      await keyIn(page, "PIN keys", MANAGER_PIN);
      await expect(page.getByRole("navigation", { name: "Destinations" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Take payment" })).toHaveCount(0);
      await expect(page.getByText("Checking with the register…")).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Table \d+, Free/ }).first()).toBeVisible();
      await shot(page, out("S2-after-switch-user.png"));
    } finally {
      await settle(orderId);
    }
  });

  test("S3: Get invoice on the paid screen opens the PDF on the first tap", async ({ page }) => {
    test.setTimeout(300_000);
    await pairAndSignIn(page, MANAGER_PIN);
    const orderId = await sentToPay(page);
    try {
      await payOnTerminal(page);
      const download = page.waitForEvent("download", { timeout: 20_000 });
      await page.getByRole("button", { name: "Get invoice", exact: true }).click();
      const pdf = await download;
      expect(pdf.suggestedFilename()).toMatch(/^INV-\d+\.pdf$/);
      // Issued: the control now names the invoice and opens it again.
      await expect(page.getByRole("button", { name: /^Invoice INV-\d+ · PDF$/ })).toBeVisible();
      await bothThemes(page, "S3-paid-screen-invoice");
    } finally {
      await settle(orderId);
    }
  });
});

test("S4: the next shift's prefilled open form replaces a count on a tap and a digit (touch)", async ({ browser, watch }) => {
  test.setTimeout(300_000);
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 1180, height: 820 } });
  const page = await context.newPage();
  watch.attach(page);
  try {
    await pairAndSignIn(page, MANAGER_PIN);
    await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Shift", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Open shift" })).toBeVisible();
    await page.getByRole("button", { name: "Count notes and coins" }).tap();
    await page.getByRole("textbox", { name: "$100 count" }).fill("1");
    await page.getByRole("textbox", { name: "$1 count" }).fill("5");
    await page.getByRole("button", { name: "Open shift with $105.00" }).tap();
    await expect(page.getByRole("heading", { name: "Shift open" })).toBeVisible();

    await page.getByRole("button", { name: "Close shift", exact: true }).tap();
    await leaveChecklistOpen(page);
    await page.getByRole("button", { name: /^Next: count the cash/ }).tap();
    await page.getByRole("textbox", { name: "Cash counted in the drawer" }).fill("105.00");
    await page.getByRole("button", { name: /^Close shift · counted \$105\.00/ }).tap();
    await expect(page.getByRole("heading", { name: "Shift closed" })).toBeVisible();
    await page.getByRole("button", { name: "Done", exact: true }).tap();

    // The next open starts from the last float, counted by notes and coins: 1 × $100 and 5 × $1.
    await expect(page.getByRole("heading", { name: "Open shift" })).toBeVisible();
    const hundreds = page.getByRole("textbox", { name: "$100 count" });
    await expect(hundreds).toHaveValue("1");
    await hundreds.tap();
    await page.keyboard.type("2");
    await expect(hundreds).toHaveValue("2");
    const ones = page.getByRole("textbox", { name: "$1 count" });
    await ones.tap();
    await page.keyboard.type("3");
    await expect(ones).toHaveValue("3");
    await expect(page.getByRole("button", { name: "Open shift with $203.00" })).toBeVisible();
    await bothThemes(page, "S4-next-open-form");

    // The single total, prefilled the same way, replaces too.
    await page.getByRole("button", { name: "One total" }).tap();
    const total = page.getByRole("textbox", { name: "Opening float" });
    await total.fill("150.00");
    await total.blur();
    await total.tap();
    await page.keyboard.type("80");
    await expect(total).toHaveValue("80");
    // No shift is left open for the specs after this one.
  } finally {
    await context.close();
  }
});
