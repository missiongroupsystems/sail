import type { Page } from "@playwright/test";
import { devLocal, expect, keyIn, pairAndSignIn, register, shot, test } from "./fixtures";

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
});
