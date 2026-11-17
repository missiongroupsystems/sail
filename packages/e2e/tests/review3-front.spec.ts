import type { Page } from "@playwright/test";
import { devLocal, expect, keyIn, leaveChecklistOpen, pairAndSignIn, register, shot, test, WEB } from "./fixtures";

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

test("S5: the line sheet's preview is the register's figure for the size and quantity on screen, never the saved one", async ({ page }) => {
  test.setTimeout(300_000);
  await pairAndSignIn(page, MANAGER_PIN);
  await page.getByRole("button", { name: "Takeaway order", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Menu sections" })).toBeVisible();
  // Laksa $16.00 with Chicken (no charge) or Prawn (+$2.00).
  await page.getByRole("button", { name: /^Laksa,/ }).click();
  const add = page.getByRole("dialog");
  await add.getByRole("button", { name: /^Add (1 × )?Laksa/ }).click();
  const orderPanel = page.getByRole("region", { name: "Order" });
  await orderPanel.getByRole("button", { name: /Laksa/ }).first().click();
  const sheet = page.getByRole("dialog", { name: "Laksa" });
  await sheet.getByRole("region", { name: "Protein" }).getByRole("button", { name: /^Prawn/ }).click();
  await sheet.getByRole("group", { name: /Quantity/ }).getByRole("button", { name: /^(More|Increase)/ }).click();
  // 2 × ($16.00 + $2.00): the register's dry run for Prawn and 2, not 2 × the Chicken price.
  await expect(sheet.getByLabel("Line total")).toContainText("36.00");
  await shot(page, out("S5-line-sheet-size-and-quantity.png"));
  await sheet.getByRole("button", { name: "Save changes" }).click();
  await expect(sheet).toHaveCount(0);
  await orderPanel.getByRole("button", { name: /Laksa/ }).first().click();
  await expect(sheet.getByLabel("Line total")).toContainText("36.00");
  await sheet.getByRole("region", { name: "Protein" }).getByRole("button", { name: /^Chicken/ }).click();
  // Back to Chicken: the saved Prawn figure is not shown while the register prices it.
  await expect(sheet.getByLabel("Line total")).toContainText("32.00");
  await expect(sheet.getByLabel("Line total")).not.toContainText("36.00");
  await page.keyboard.press("Escape");
  // Leave nothing open: the takeaway was never sent, so it is cancelled.
  await page.getByRole("button", { name: "Order", exact: true }).click();
  await page.getByRole("menuitem", { name: "Cancel order" }).click();
  await page.getByRole("dialog", { name: /Cancel/ }).getByRole("button").filter({ hasText: /changed mind|mistake/i }).first().click();
});

test("S6: the kitchen display's clock and online state fit at 1024 with both paging buttons; the paging buttons say what they do", async ({ browser, watch }) => {
  test.setTimeout(400_000);
  const { outletId, brandId } = devLocal();
  const stations = await register<{ data: { id: string; name: string; kind: string }[] }>("GET", `/v1/outlets/${outletId}/stations`);
  const display = stations.data.find((s) => s.kind === "display")!;
  const products = await register<{ data: { id: string; name: string }[] }>("GET", "/v1/products?limit=60");
  const ids = Object.fromEntries(products.data.map((x) => [x.name, x.id]));
  const made: string[] = [];
  for (let i = 1; i <= 26; i++) {
    const o = await register<{ data: { id: string } }>("POST", "/v1/orders", { order_id: crypto.randomUUID(), order_type: "takeaway", takeaway_ref: `R3 ${i}`, outlet_id: outletId, brand_id: brandId });
    made.push(o.data.id);
    await register("POST", `/v1/orders/${o.data.id}/lines`, { lines: [{ line_id: crypto.randomUUID(), product_id: ids["Char Kway Teow"]!, quantity: 1 }, { line_id: crypto.randomUUID(), product_id: ids["Otah"]!, quantity: 1 }] });
    await register("POST", `/v1/orders/${o.data.id}/fire`, {});
  }
  // The last ticket recalled, so Recall names a ticket (its longest label).
  try {
    for (const viewport of [{ width: 1024, height: 768 }, { width: 1280, height: 800 }, { width: 820, height: 1180 }]) {
      await test.step(`at ${viewport.width}x${viewport.height}`, async () => {
        const ctx = await browser.newContext({ viewport });
        const kds = await ctx.newPage();
        watch.attach(kds);
        const { data } = await register<{ data: { code: string } }>("POST", `/v1/stations/${display.id}/pairing-code`, {});
        await kds.goto(`${WEB}/kds`);
        await expect(kds.getByRole("heading", { name: "Pair this screen to a station" })).toBeVisible({ timeout: 180_000 });
        await keyIn(kds, "PIN keys", data.code);
        await kds.getByRole("button", { name: "Pair this screen" }).click();
        const board = kds.getByRole("region", { name: "Tickets" });
        await expect(board.getByRole("button", { name: /R3 26/ })).toBeAttached();
        // One bump and its Recall, so the bar holds its longest content.
        await board.getByRole("button", { name: /R3 1\b/ }).first().click().catch(() => undefined);
        await kds.getByRole("button", { name: /^\d+ more$/ }).click();
        await kds.waitForTimeout(700);
        const before = kds.getByRole("button", { name: /^\d+ before$/ });
        const more = kds.getByRole("button", { name: /^\d+ more$/ });
        await expect(before).toBeVisible();
        await expect(more).toBeVisible();
        // The words show, not a bare count and chevron ("‹ 4", "3 ›").
        const wordShown = (b: typeof before, word: string) => b.evaluate((el, w) => Array.from(el.querySelectorAll("span")).some((s) => s.textContent?.trim() === w && s.getBoundingClientRect().width > 10), word);
        const words = [await wordShown(before, "before"), await wordShown(more, "more")];
        const header = kds.locator("main > header");
        const overflow = await header.evaluate((el) => {
          const w = window.innerWidth;
          return Array.from(el.querySelectorAll<HTMLElement>("*"))
            .filter((c) => c.getBoundingClientRect().width > 0 && c.getBoundingClientRect().right > w + 0.5)
            .map((c) => `${c.tagName} ${c.textContent?.slice(0, 20)} ${Math.round(c.getBoundingClientRect().right)}`);
        });
        for (const theme of ["day", "service"] as const) {
          await kds.evaluate((t) => (t === "service" ? (document.documentElement.dataset.theme = "service") : delete document.documentElement.dataset.theme), theme);
          await kds.waitForTimeout(150);
          await shot(kds, out(`S6-kds-${viewport.width}-${theme}.png`));
        }
        expect(overflow).toEqual([]);
        // In portrait (an iPad on its side) the count and chevron stand alone; the word stays for screen readers.
        expect(words).toEqual(viewport.width > 960 ? [true, true] : [false, false]);
        await expect(header.getByText(/online/i)).toBeInViewport();
        await ctx.close();
      });
    }
  } finally {
    for (const id of made) await settle(id);
  }
});
