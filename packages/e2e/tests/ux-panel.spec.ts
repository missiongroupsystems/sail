import type { Page } from "@playwright/test";
import { API, devLocal, expect, GUEST, pairAndSignIn, register, SG_ADMIN, test, WEB } from "./fixtures";

/**
 * The findings of the hands-on usability review, each held to what a person sees: tips on the pay screen, line prices
 * that add up, a floor plan and an order dock that fit an iPad, the percentage keypad, offline status, guest prices and
 * notes, even splits, a terminal payment found again, QR sheets that do not break the cards, and a confirmed day close.
 */

const CASHIER_PIN = "333333";

/** "$12.34" or "−$1.20" to cents. */
const cents = (text: string) => {
  const m = /(−|-)?\$([\d,]+)\.(\d\d)/.exec(text);
  if (!m) throw new Error(`no amount in "${text}"`);
  return (m[1] ? -1 : 1) * (Number(m[2]!.replace(/,/g, "")) * 100 + Number(m[3]));
};

async function seatFreeTable(page: Page) {
  await page.getByRole("button", { name: "Floor", exact: true }).click();
  await page.getByRole("button", { name: /^Table \d+, Free/ }).first().click();
  await page.getByRole("button", { name: "2 guests", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Menu sections" })).toBeVisible();
}

/** A takeaway order from the floor, so these checks never run out of free tables. */
async function newTakeaway(page: Page) {
  await page.getByRole("button", { name: "Floor", exact: true }).click();
  await page.getByRole("button", { name: "Takeaway order", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Menu sections" })).toBeVisible();
}

async function addAndSend(page: Page, names: string[]) {
  for (const [i, name] of names.entries()) {
    await page.getByRole("button", { name: new RegExp(`^${name},`) }).click();
    await expect(page.getByRole("button", { name: `Send ${i + 1} to kitchen` })).toBeVisible();
  }
  await page.getByRole("button", { name: `Send ${names.length} to kitchen` }).click();
  await expect(page.getByRole("region", { name: "Order" }).getByText(/^Sent /).last()).toBeVisible();
}

/** Nothing is wider than the screen and every dock button ends inside it. */
async function dockFits(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  for (const b of await page.getByRole("toolbar", { name: "Order actions" }).getByRole("button").all()) {
    const box = (await b.boundingBox())!;
    expect(box.x + box.width, `${await b.innerText()} ends inside the screen`).toBeLessThanOrEqual(width);
  }
}

async function signInBackOffice(page: Page, watch: { allowConsole: (r: RegExp) => void }) {
  // WebKit reports Today's reads that the next navigation cuts short as uncaught "access control checks" errors.
  watch.allowConsole(/\/api\/v1\/[^ ]* due to access control checks/);
  await page.goto(`${WEB}/login`);
  await expect(async () => {
    await page.getByLabel("Email").fill(SG_ADMIN);
    await page.getByLabel("Password").fill(devLocal().admin_password);
    await page.getByRole("button", { name: "Sign in" }).click({ timeout: 10_000 });
    await page.waitForURL(`${WEB}/today`, { timeout: 30_000 });
  }).toPass({ timeout: 300_000 });
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
}

/** A first visit can be cut short by the dev server reloading Today after its first compile: go until it sticks. */
async function goTo(page: Page, path: string) {
  await expect(async () => {
    await page.goto(`${WEB}${path}`);
    await expect(page).toHaveURL(`${WEB}${path}`, { timeout: 5_000 });
  }).toPass({ timeout: 120_000 });
}

test.describe("iPad landscape 1180×820", () => {
  test.use({ viewport: { width: 1180, height: 820 } });

  test("line prices add up to the subtotal, the dock fits, an even split is a cent apart at most, and a closed order's Reopen is on screen", async ({ page }) => {
    test.setTimeout(300_000);
    await pairAndSignIn(page, CASHIER_PIN);
    await seatFreeTable(page);
    const order = page.getByRole("region", { name: "Order" });

    await test.step("lines show menu prices: the column is the subtotal, service and GST are rows below", async () => {
      await page.getByRole("button", { name: /^Mee Goreng,/ }).click();
      await expect(page.getByRole("button", { name: "Send 1 to kitchen" })).toBeVisible();
      await page.getByRole("button", { name: /^Chicken Rice,/ }).click();
      await expect(page.getByRole("button", { name: "Send 2 to kitchen" })).toBeVisible();
      await expect(order.getByText("pricing")).toHaveCount(0);
      const lines = await order.getByRole("button", { name: /^1 / }).allInnerTexts();
      const sum = lines.reduce((s, t) => s + cents(t.match(/\$[\d,.]+/)![0]), 0);
      const subtotal = cents(await order.locator("dl > div").filter({ hasText: /^Subtotal/ }).innerText());
      expect(sum).toBe(subtotal);
      await expect(order.locator("dl > div").filter({ hasText: /^Service charge/ })).toBeVisible();
      await dockFits(page, 1180);
    });

    await test.step("sent: Pay replaces Send and Hold, and still fits", async () => {
      await page.getByRole("button", { name: "Send 2 to kitchen" }).click();
      await expect(order.getByText(/^Sent /)).toBeVisible();
      await expect(page.getByRole("button", { name: /^Pay \$/ })).toBeVisible();
      await expect(page.getByRole("toolbar", { name: "Order actions" }).getByRole("button", { name: "Hold" })).toHaveCount(0);
      await dockFits(page, 1180);
    });

    await test.step("split evenly in two: the bills differ by a cent at most", async () => {
      await page.getByRole("button", { name: "Bill", exact: true }).click();
      await page.getByRole("group", { name: "Split mode" }).getByRole("button", { name: "Even" }).click();
      await expect(page.getByRole("region", { name: "Bill 2" })).toBeVisible();
      await expect(page.getByText("Checking…")).toHaveCount(0);
      const [a, b] = await Promise.all(["Bill 1", "Bill 2"].map(async (n) => cents(await page.getByRole("region", { name: n }).getByRole("button", { name: /^Pay / }).innerText())));
      expect(Math.abs(a! - b!)).toBeLessThanOrEqual(1);
      await page.getByRole("group", { name: "Split mode" }).getByRole("button", { name: "One" }).click();
      await expect(page.getByRole("region", { name: "Bill 2" })).toHaveCount(0);
    });

    await test.step("pay in cash: the Take button shows the rounded amount the register works out", async () => {
      await page.getByRole("region", { name: "Bill 1" }).getByRole("button", { name: /^Pay / }).click();
      await page.getByRole("group", { name: "Payment method" }).getByRole("button", { name: "Cash", exact: true }).click();
      // Tapping the chosen method again once left "Checking with the register…" up for good.
      await page.getByRole("group", { name: "Payment method" }).getByRole("button", { name: "Cash", exact: true }).click();
      const status = page.getByRole("region", { name: "Payment" }).getByRole("status").filter({ hasText: /rounding/ });
      await expect(status).toBeVisible();
      const take = page.getByRole("button", { name: /^Take \$[\d.]+ cash/ });
      await expect(take).toBeEnabled();
      // The demo rounds cash to 5 cents, so the amount to take is always a whole number of steps.
      expect(cents(await take.innerText()) % 5).toBe(0);
      await take.click();
      await expect(page.getByText(/^Paid · Bill 1 · /)).toBeVisible();
      await page.getByRole("button", { name: "No receipt" }).click();
    });

    await test.step("the closed order: Reopen and Refund, with their approval badges, end inside the screen", async () => {
      await page.getByRole("button", { name: "Orders", exact: true }).click();
      await page.getByRole("group", { name: "Which orders" }).getByRole("button", { name: "Today's closed" }).click();
      await page.getByRole("button", { name: /^Dine-in .*, Done$/ }).first().click();
      await expect(page.getByRole("button", { name: "Reopen this order" })).toBeVisible();
      await dockFits(page, 1180);
    });
  });

  test("tips: the register works out a percentage, cash tips round to the cash step, and the payment records the tip shown", async ({ page }) => {
    test.setTimeout(300_000);
    const { outletId } = devLocal();
    await register("PATCH", "/v1/merchant/settings", { tips_enabled: true });
    try {
      await pairAndSignIn(page, CASHIER_PIN);
      await seatFreeTable(page);
      await addAndSend(page, ["Mee Goreng"]);
      await page.getByRole("button", { name: /^Pay \$/ }).click();
      const pay = page.getByRole("region", { name: "Payment" });
      const balance = cents(await pay.getByText(/^\$[\d,.]+$/).first().innerText());

      await test.step("cash with 15%: the tip is a whole number of 5-cent steps", async () => {
        await page.getByRole("group", { name: "Payment method" }).getByRole("button", { name: "Cash", exact: true }).click();
        await page.getByRole("button", { name: "Type the tip" }).click();
        await page.getByRole("group", { name: "Tip" }).getByRole("button", { name: "Tip 15%" }).click();
        const status = pay.getByRole("status").filter({ hasText: /Tip\s*\$/ });
        await expect(status).toBeVisible();
        const tip = cents((await status.innerText()).match(/Tip\s*(\$[\d.]+)/)![1]!);
        // 15% of the amount, rounded half up to the cent, then to the nearest 5 cents.
        expect(tip).toBe(Math.round(Math.round((balance * 15) / 100) / 5) * 5);
      });

      let shown = 0;
      await test.step("card with 18%: the button asks for the bill and the tip", async () => {
        await page.getByRole("group", { name: "Payment method" }).getByRole("button", { name: "Card", exact: true }).click();
        await page.getByRole("button", { name: "Type the tip" }).click();
        await page.getByRole("group", { name: "Tip" }).getByRole("button", { name: "Tip 18%" }).click();
        const take = page.getByRole("button", { name: /^Take \$[\d.]+ by Card/ });
        await expect(take).toBeEnabled();
        shown = cents((await pay.getByText(/including a \$[\d.]+ tip/).innerText()).match(/including a (\$[\d.]+) tip/)![1]!);
        expect(shown).toBe(Math.round((balance * 18) / 100));
        expect(cents(await take.innerText())).toBe(balance + shown);
        await take.click();
        await expect(page.getByText(/^Paid · Bill 1 · /)).toBeVisible();
        await expect(page.getByText(new RegExp(`^Tip \\$${(shown / 100).toFixed(2).replace(".", "\\.")}`))).toBeVisible();
      });

      await test.step("the register recorded that tip on the payment", async () => {
        const orders = await register<{ data: { checks: { payments: { tip_cents: number; status: string }[] }[]; completed_at: string | null }[] }>("GET", `/v1/outlets/${outletId}/orders?status=completed&limit=5`);
        const tips = orders.data.flatMap((o) => o.checks.flatMap((c) => c.payments.filter((p) => p.status === "recorded").map((p) => p.tip_cents)));
        expect(tips).toContain(shown);
      });
    } finally {
      await register("PATCH", "/v1/merchant/settings", { tips_enabled: false });
    }
  });

  test("the percentage keypad reads 1, 0 as 10%", async ({ page }) => {
    test.setTimeout(300_000);
    await pairAndSignIn(page, CASHIER_PIN);
    await newTakeaway(page);
    await page.getByRole("button", { name: /^Mee Goreng,/ }).click();
    await expect(page.getByRole("button", { name: "Send 1 to kitchen" })).toBeVisible();
    await page.getByRole("button", { name: "Discount", exact: true }).click();
    await page.getByRole("dialog").last().getByRole("button", { name: /% off bill/ }).click();
    const pad = page.getByRole("group", { name: "Amount keys" }).last();
    await pad.getByRole("button", { name: "1", exact: true }).click();
    await pad.getByRole("button", { name: "0", exact: true }).click();
    await expect(page.getByRole("dialog").last().locator("output")).toHaveText("10%");
    await pad.getByRole("button", { name: "Decimal point" }).click();
    await pad.getByRole("button", { name: "5", exact: true }).click();
    await expect(page.getByRole("dialog").last().locator("output")).toHaveText("10.5%");
  });

  test("offline: the header says so at once, and an item added meanwhile is kept and lands once on reconnect", async ({ page, watch }) => {
    test.setTimeout(300_000);
    watch.allowConsole(/ERR_INTERNET_DISCONNECTED|internal error|Load failed|network connection/i);
    await pairAndSignIn(page, CASHIER_PIN);
    await newTakeaway(page);
    await addAndSend(page, ["Mee Goreng"]);
    const order = page.getByRole("region", { name: "Order" });
    await page.context().setOffline(true);
    await expect(page.getByText(/^Connection lost · offline/)).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: /^Chicken Rice,/ }).click();
    await expect(page.getByText(/^Offline · .* is kept$/)).toBeVisible();
    await expect(order.getByText("pricing")).toBeVisible();
    await page.context().setOffline(false);
    await expect(page.getByRole("button", { name: "Send 1 to kitchen" })).toBeVisible({ timeout: 30_000 });
    await expect(order.getByText("pricing")).toHaveCount(0);
    await expect(order.getByRole("button", { name: /^1 Chicken Rice/ })).toHaveCount(1);
  });

  test("offline: an add the register took but whose reply was lost stays on screen once, with no error, when it is sent again", async ({ page, watch }) => {
    test.setTimeout(300_000);
    watch.allowConsole(/ERR_INTERNET_DISCONNECTED|internal error|Load failed|network connection|Failed to fetch/i);
    await pairAndSignIn(page, CASHIER_PIN);
    await newTakeaway(page);
    await addAndSend(page, ["Mee Goreng"]);
    const order = page.getByRole("region", { name: "Order" });
    // The add reaches the register and is saved, but its reply is lost on the way back. The first resend is lost too,
    // and meanwhile the station's event stream has caught up with the order (a newer version) before the next one.
    let posts = 0;
    await page.route("**/v1/orders/*/lines", async (route) => {
      if (route.request().method() !== "POST" || ++posts > 2) return route.fallback();
      if (posts === 1) await route.fetch();
      else await page.waitForTimeout(2_000);
      await route.abort("internetdisconnected");
    });
    await page.getByRole("button", { name: /^Chicken Rice,/ }).click();
    await expect(page.getByText(/^Offline · .* is kept$/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Send 1 to kitchen" })).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(3_000);
    await expect(order.getByRole("button", { name: /^1 Chicken Rice/ })).toHaveCount(1);
    await expect(page.getByText(/already used with a different request/)).toHaveCount(0);
  });

  test("a terminal payment still pending is found again: its method is shown waiting, and another method says why it is blocked", async ({ page }) => {
    test.setTimeout(300_000);
    const { payment_simulator } = devLocal();
    const next = await fetch(`${payment_simulator}/terminals/sim-1/next`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ outcome: "timeout" }) });
    expect(next.ok).toBe(true);
    await pairAndSignIn(page, CASHIER_PIN);
    await newTakeaway(page);
    await addAndSend(page, ["Mee Goreng"]);
    await page.getByRole("button", { name: /^Pay \$/ }).click();
    const methods = page.getByRole("group", { name: "Payment method" });
    await methods.getByRole("button", { name: /^More payment methods/ }).click();
    await methods.getByRole("button", { name: "Card (terminal)", exact: true }).click();
    await page.getByRole("button", { name: /^Send \$[\d.]+ to the terminal/ }).click();
    await expect(page.getByText("Waiting for the terminal.", { exact: false })).toBeVisible();
    // Back is the first button in the screen's own row, under the top bar (the top bar now holds the destinations on every screen).
    await page.getByRole("main").getByRole("button").first().click();
    await page.getByRole("button", { name: /^Pay \$/ }).click();
    await expect(page.getByText("Waiting for the terminal.", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Use another method" }).click();
    await methods.getByRole("button", { name: "Cash", exact: true }).click();
    await expect(page.getByText(/^A terminal payment of \$[\d.]+ is waiting for the guest/)).toBeVisible();
    await page.getByRole("button", { name: "Show the terminal payment" }).click();
    await page.getByRole("button", { name: "Cancel on terminal" }).click();
    await expect(page.getByText(/^Cancelled\. Nothing was charged\./)).toBeVisible({ timeout: 30_000 });
  });
});

/** Eight tables in one row across the back office's 24 columns, in an area of their own. */
async function wideArea(): Promise<string> {
  const { outletId } = devLocal();
  const name = `Wide ${Math.random().toString(36).slice(2, 7)}`;
  const area = await register<{ data: { id: string } }>("POST", "/v1/areas", { outlet_id: outletId, name, sort: 50 });
  for (let i = 0; i < 8; i++) await register("POST", "/v1/tables", { outlet_id: outletId, area_id: area.data.id, name: `W${i + 1}`, x: i * 3, y: 0, w: 2, h: 2 });
  return name;
}

for (const [width, height] of [
  [1180, 820],
  [820, 1180],
] as const) {
  test.describe(`floor plan at ${width}×${height}`, () => {
    test.use({ viewport: { width, height } });
    test("a plan across 24 columns fits in landscape, and in portrait says some tables are off screen", async ({ page }) => {
      test.setTimeout(300_000);
      const area = await wideArea();
      await pairAndSignIn(page, CASHIER_PIN);
      await page.getByRole("group", { name: "Areas" }).getByRole("button", { name: area }).click();
      const tables = page.getByRole("button", { name: /^Table W\d, Free/ });
      await expect(tables).toHaveCount(8);
      const canvas = (await tables.first().evaluate((el) => el.parentElement!.parentElement!.getBoundingClientRect().toJSON())) as DOMRect;
      const rights = await Promise.all((await tables.all()).map(async (t) => (await t.boundingBox())!.x + (await t.boundingBox())!.width));
      if (width > height) {
        for (const r of rights) expect(r).toBeLessThanOrEqual(canvas.x + canvas.width + 1);
        await expect(page.getByText(/^Some tables are off screen/)).toHaveCount(0);
      } else {
        // Portrait puts the Now rail under the plan, so the plan may now fit; if it does not, it says so.
        if (Math.max(...rights) > canvas.x + canvas.width + 1) await expect(page.getByText("Some tables are off screen. Swipe across to see them all.")).toBeVisible();
        else await expect(page.getByText(/^Some tables are off screen/)).toHaveCount(0);
        // Still a comfortable tap target.
        expect((await tables.first().boundingBox())!.width).toBeGreaterThanOrEqual(48);
      }
    });
  });
}

test.describe("guest phone 390×844", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("Add shows a priced default option, and a long note wraps instead of pushing Send off screen", async ({ page }) => {
    test.setTimeout(300_000);
    const { outletId } = devLocal();
    const floor = await register<{ data: { tables: { id: string; order: unknown }[] } }>("GET", `/v1/outlets/${outletId}/floor`);
    const table = floor.data.tables.find((t) => !t.order)!;
    const { brandId } = devLocal();
    await register("POST", "/v1/orders", { order_id: crypto.randomUUID(), order_type: "dine_in", table_id: table.id, pax: 2, outlet_id: outletId, brand_id: brandId });
    const qr = await register<{ data: { url: string } }>("POST", `/v1/tables/${table.id}/qr/rotate`, {});
    await page.goto(`${GUEST}/t/${qr.data.url.split("/t/")[1]}`);
    await page.getByRole("button", { name: /^Laksa,/ }).click();
    const sheet = page.getByRole("dialog", { name: "Laksa" });
    // Prawn (+$2.00) is preselected: the button names it, rather than the menu price alone.
    await expect(sheet.getByRole("button", { name: /^Add to order · \$16\.00 \+ \$2\.00$/ })).toBeVisible();
    await sheet.getByLabel("Note for the kitchen").pressSequentially(`no peanuts https://example.com/${"x".repeat(120)}`);
    await sheet.getByRole("button", { name: /^Add to order/ }).click();
    await page.getByRole("button", { name: /^View your order, 1 item/ }).click();
    await expect(page.getByText(/^Note: no peanuts/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const send = (await page.getByRole("button", { name: /to the kitchen$|Waiting for staff/ }).boundingBox())!;
    expect(send.x + send.width).toBeLessThanOrEqual(390);
  });
});

test.describe("back office 1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("downloading the QR sheet leaves the codes on the tables working; rotating them all asks first", async ({ page, watch }) => {
    test.setTimeout(300_000);
    const { outletId } = devLocal();
    const floor = await register<{ data: { tables: { id: string; order: unknown }[] } }>("GET", `/v1/outlets/${outletId}/floor`);
    const qr = await register<{ data: { url: string } }>("POST", `/v1/tables/${floor.data.tables[0]!.id}/qr/rotate`, {});
    const token = qr.data.url.split("/t/")[1]!;
    await signInBackOffice(page, watch);
    await goTo(page, "/floor");
    const sheet = page.waitForResponse((r) => /qr-sheet\.pdf/.test(r.url()) && r.ok());
    await page.getByRole("button", { name: "Download QR sheet (PDF)" }).click();
    await sheet;
    const session = await fetch(`${API}/v1/guest/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, device_id: `device-${crypto.randomUUID()}` }) });
    expect(session.status, "the code printed before the download still opens the table").toBe(201);
    await page.getByRole("button", { name: "Rotate every code…" }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText("The cards on the tables stop working at once");
    await confirm.getByRole("button", { name: "Keep the codes" }).click();
    await expect(confirm).toBeHidden();
  });

  test("closing the business day asks first and lists the orders still open", async ({ page, watch }) => {
    test.setTimeout(300_000);
    const { outletId, brandId } = devLocal();
    const opened = await register<{ data: { order_no: string } }>("POST", "/v1/orders", { order_id: crypto.randomUUID(), order_type: "takeaway", outlet_id: outletId, brand_id: brandId });
    await signInBackOffice(page, watch);
    await goTo(page, "/reports/z-report");
    await page.getByRole("button", { name: /^Close business day .*…$/ }).click();
    const confirm = page.getByRole("alertdialog", { name: /^Close business day/ });
    await expect(confirm.getByText(/orders? (is|are) still open/)).toBeVisible();
    await expect(confirm).toContainText(opened.data.order_no);
    await confirm.getByRole("button", { name: "Keep the day open" }).click();
    await expect(confirm).toBeHidden();
    await expect(page.getByRole("button", { name: /^Close business day .*…$/ })).toBeEnabled();
  });
});
