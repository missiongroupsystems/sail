import type { Page } from "@playwright/test";
import { API, devLocal, expect, keyIn, pairAndSignIn, register, test, textContrast } from "./fixtures";

const CASHIER_PIN = "333333"; // Cal Cashier (dev seed): can take payments and run the shift, not refund
const MANAGER_PIN = "222222"; // Mia Manager approves the refund

async function setTheme(page: Page, theme: "day" | "service") {
  await page.evaluate((t) => {
    if (t === "service") document.documentElement.dataset.theme = "service";
    else delete document.documentElement.dataset.theme;
  }, theme);
}

test.use({ viewport: { width: 1180, height: 820 } });

test("POS: pair, sign in, shift, order, split, cash and card, refund with a manager, close the shift", async ({ page }) => {
  test.setTimeout(600_000);
  await test.step("pair the iPad and sign in with a cashier PIN", () => pairAndSignIn(page, CASHIER_PIN));

  await test.step("open the shift with a $200 float counted in notes", async () => {
    await page.getByRole("button", { name: "Shift", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Open shift" })).toBeVisible();
    await page.getByRole("button", { name: "Count notes and coins" }).click();
    await page.getByRole("button", { name: "More $100" }).click();
    await page.getByRole("button", { name: "More $100" }).click();
    await expect(page.getByRole("group", { name: "Notes and coins" })).toContainText("$200.00");
    await page.getByRole("button", { name: "Open shift with $200.00" }).click();
    await expect(page.getByRole("heading", { name: "Shift open" })).toBeVisible();
  });

  await test.step("seat a free table for two", async () => {
    await page.getByRole("button", { name: "Floor", exact: true }).click();
    await page.getByRole("button", { name: /^Table \d+, Free/ }).first().click();
    await page.getByRole("button", { name: "2 guests", exact: true }).click();
    await expect(page.getByRole("navigation", { name: "Menu sections" })).toBeVisible();
  });

  const order = page.getByRole("region", { name: "Order" });

  await test.step("add Laksa with a protein other than the default, and Mee Goreng", async () => {
    await page.getByRole("button", { name: /^Laksa,/ }).click();
    const sheet = page.getByRole("dialog", { name: "Laksa" });
    await expect(sheet.getByRole("button", { name: /^Prawn/ })).toHaveAttribute("aria-pressed", "true");
    await sheet.getByRole("button", { name: "Chicken", exact: true }).click();
    await sheet.getByRole("button", { name: "Add Laksa" }).click();
    await expect(sheet).toBeHidden();
    // One tap at a time: a second add sent while the first is still in flight carries a stale version and is replayed after a 409 (design 4.3).
    await expect(page.getByRole("button", { name: "Send 1 to kitchen" })).toBeVisible();
    await page.getByRole("button", { name: /^Mee Goreng,/ }).click();
    await expect(order.getByRole("button", { name: /Laksa/ })).toContainText("Chicken");
    // Both lines are on the register (not only on screen) once Send counts them.
    await expect(page.getByRole("button", { name: "Send 2 to kitchen" })).toBeVisible();
  });

  await test.step("tile names and order actions are readable in Day and Service", async () => {
    // A colour token and a font-size token once shared the name "line", so .text-line painted text in the hairline colour.
    for (const theme of ["day", "service"] as const) {
      await setTheme(page, theme);
      // Colours ease between themes, so read them until they settle; a real clash never reaches 4.5.
      for (const [what, selector] of [
        ["tile name", 'button[aria-label^="Laksa,"] .line-clamp-2'],
        ["order action", '[role="toolbar"][aria-label="Order actions"] button:not([disabled])'],
      ] as const) {
        await expect
          .poll(async () => (await textContrast(page, selector)).ratio, { message: `${theme}: ${what} contrast`, timeout: 5_000 })
          .toBeGreaterThanOrEqual(4.5);
      }
    }
    await setTheme(page, "day");
  });

  await test.step("send to the kitchen", async () => {
    await page.getByRole("button", { name: "Send 2 to kitchen" }).click();
    await expect(order.getByText(/^Sent /)).toBeVisible();
    await expect(page.getByRole("button", { name: /^Pay \$/ })).toBeEnabled();
  });

  await test.step("split the bill evenly in two; the header names each share", async () => {
    await page.getByRole("button", { name: "Bill", exact: true }).click();
    await page.getByRole("group", { name: "Split mode" }).getByRole("button", { name: "Even" }).click();
    await expect(page.getByRole("region", { name: "Bill 2" })).toBeVisible();
    await expect(page.getByText("Bills add up to")).toBeVisible();
    // Three ways the total does not divide evenly. The header must name every distinct share, not the first bill's for all.
    const bills = page.getByRole("group", { name: "Number of bills" });
    await bills.getByRole("button", { name: "Increase quantity" }).click();
    await expect(page.getByRole("region", { name: "Bill 3" })).toBeVisible();
    await expect(page.getByText("Checking…")).toHaveCount(0);
    const shares = await Promise.all(["Bill 1", "Bill 2", "Bill 3"].map(async (b) => (await page.getByRole("region", { name: b }).getByRole("button", { name: /^Pay / }).innerText()).match(/\$[\d,.]+/)![0]));
    expect(new Set(shares).size, `shares ${shares.join(", ")}`).toBeGreaterThan(1);
    const header = page.getByText(/ each$/);
    for (const share of new Set(shares)) await expect(header).toContainText(share);
    await bills.getByRole("button", { name: "Decrease quantity" }).click();
    await expect(page.getByRole("region", { name: "Bill 3" })).toHaveCount(0);
    await expect(page.getByText("Checking…")).toHaveCount(0);
  });

  await test.step("pay bill 1 in cash with change", async () => {
    await page.getByRole("region", { name: "Bill 1" }).getByRole("button", { name: /^Pay / }).click();
    await page.getByRole("group", { name: "Payment method" }).getByRole("button", { name: "Cash", exact: true }).click();
    await page.getByRole("group", { name: "Cash given" }).getByRole("button", { name: "$20", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "change" })).toContainText("change $");
    await page.getByRole("button", { name: /^Take \$20\.00 cash/ }).click();
    await expect(page.getByText(/^Paid · Bill 1 · /)).toBeVisible();
    await expect(page.getByText(/^Change \$/)).toBeVisible();
    // A dry run still waiting when the payment landed used to come back 409 "already paid"; the watch fixture fails on any.
    await page.waitForTimeout(1_000);
    await page.getByRole("button", { name: "Next bill" }).click();
  });

  await test.step("pay bill 2 by card", async () => {
    await page.getByRole("region", { name: "Bill 2" }).getByRole("button", { name: /^Pay / }).click();
    await page.getByRole("group", { name: "Payment method" }).getByRole("button", { name: "Card", exact: true }).click();
    await page.getByRole("button", { name: /^Paid by Card/ }).click();
    await expect(page.getByText(/^Paid · Bill 2 · /)).toBeVisible();
    await page.getByRole("button", { name: "No receipt" }).click();
  });

  await test.step("refund one item from the cash bill with a manager's PIN", async () => {
    await page.getByRole("button", { name: "Orders", exact: true }).click();
    await page.getByRole("group", { name: "Which orders" }).getByRole("button", { name: "Today's closed" }).click();
    await page.getByRole("button", { name: /^Dine-in .*, Done$/ }).first().click();
    await page.getByRole("listitem").filter({ hasText: /^Bill 1/ }).getByRole("button", { name: "Refund" }).click();
    const sheet = page.getByRole("dialog", { name: "Refund" });
    await sheet.getByRole("group", { name: "What to refund" }).getByRole("button", { name: "Some items" }).click();
    await sheet.getByRole("group", { name: /^Mee Goreng quantity to refund/ }).getByRole("button", { name: "Increase quantity" }).click();
    await sheet.getByRole("button", { name: "Next: why" }).click();
    await sheet.getByRole("group", { name: "Reason" }).getByRole("button").first().click();
    await sheet.getByRole("button", { name: "Next: back to" }).click();
    await sheet.getByRole("button", { name: "Review" }).click();
    await sheet.getByRole("button", { name: /^Manager approval/ }).click();
    const approval = page.getByRole("dialog", { name: "Manager approval" });
    await expect(approval).toBeVisible();
    await keyIn(page, "PIN keys", MANAGER_PIN);
    await expect(page.getByRole("dialog", { name: /^Refunded \$/ })).toBeVisible();
  });

  await test.step("close the shift with a blind count", async () => {
    await page.getByRole("dialog", { name: /^Refunded \$/ }).getByRole("button", { name: "Done" }).click();
    await page.getByRole("banner").getByRole("button", { name: "Orders", exact: true }).click();
    await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Shift", exact: true }).click();
    await page.getByRole("button", { name: "Close shift ▸" }).click();
    // Other specs may leave a table open: carry anything outstanding to the next shift.
    const checklist = page.getByRole("list", { name: "Before closing" });
    for (const leave of await checklist.getByRole("button", { name: "Leave open" }).all()) await leave.click();
    await page.getByRole("button", { name: /^Next: count the cash/ }).click();
    await keyIn(page, "Amount keys", "20000");
    await page.getByRole("button", { name: /^Close shift · counted \$200\.00/ }).click();
    // The count leaves out the day's cash takings, so the register asks why it is short before closing.
    await expect(page.getByRole("heading", { name: /^Variance −\$/ })).toBeVisible();
    await page.getByRole("group", { name: "Reason" }).getByRole("button", { name: "Change given wrongly" }).click();
    await expect(page.getByRole("heading", { name: "Shift closed" })).toBeVisible();
  });
});

// The lock screen warms the menu before a PIN, so a paired station must be able to look up its own POS channel link.
test("station channel link: a paired station reads its POS channel link before a PIN", async () => {
  const { stationId, outletId } = devLocal();
  const { data } = await register<{ data: { code: string } }>("POST", `/v1/stations/${stationId}/pairing-code`, {});
  const paired = await fetch(`${API}/v1/stations/pair`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ code: data.code, device_label: "e2e probe" }) });
  expect(paired.ok, "pairing the probe").toBe(true);
  const { data: pair } = (await paired.json()) as { data: { station_token: string } };
  const res = await fetch(`${API}/v1/channel-links?channel=pos&outlet_id=${outletId}`, { headers: { authorization: `Bearer ${pair.station_token}` } });
  expect(res.status).toBe(200);
  const links = (await res.json()) as { data: { channel: string; outlet_id: string }[] };
  expect(links.data.length).toBeGreaterThan(0);
  expect(links.data.every((l) => l.channel === "pos" && l.outlet_id === outletId)).toBe(true);
});
