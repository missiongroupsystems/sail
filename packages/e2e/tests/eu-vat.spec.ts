import type { Locator } from "@playwright/test";
import { expect, GUEST, pairAndSignIn, test } from "./fixtures";

const ADMIN_PIN = "123456"; // the EU café's Admin (dev seed)

/** A totals row as text: its label, then the amount as de-DE writes euros ("1,54 €", "−0,98 €"). */
const ROW = /^(.+?)\s+(−?\d{1,3}(?:\.\d{3})*,\d{2})\s€$/;

/**
 * The rows from the total down. Schnitzel 16,90 € is taxed at 10% and Pils 4,90 € less the 20% happy-hour discount
 * (3,92 €) at 20%, both inclusive and rounded once per rate, so each rate is its own "(included)" row after the total.
 */
const FROM_TOTAL = [
  ["Total", "20,82"],
  ["VAT 10% (included)", "1,54"],
  ["VAT 20% (included)", "0,65"],
];

/** Every row of a totals block as [label, amount]; a row that is not a label and a euro amount fails the test. */
async function totalsRows(rows: Locator): Promise<string[][]> {
  return (await rows.allInnerTexts()).map((text) => {
    const row = ROW.exec(text.trim());
    expect(row, `totals row "${text}"`).not.toBeNull();
    return [row![1]!, row![2]!];
  });
}

test.use({ viewport: { width: 1180, height: 820 } });

// The second demo merchant: inclusive VAT at 10% (food) and 20% (drinks), rounded per rate, EUR in de-DE.
test("EU VAT café: the POS bill and the guest receipt show both VAT rates in euros", async ({ browser, page, watch }) => {
  test.setTimeout(300_000);
  await test.step("pair the iPad to the café's station and sign in", () => pairAndSignIn(page, ADMIN_PIN, "eu"));

  await test.step("seat a table, add a food and a drink, send them", async () => {
    await page.getByRole("button", { name: "Floor", exact: true }).click();
    await page.getByRole("button", { name: /^Table \d+, Free/ }).first().click();
    await page.getByRole("button", { name: "2 guests", exact: true }).click();
    await page.getByRole("button", { name: /^Schnitzel mit Kartoffelsalat,/ }).click();
    await expect(page.getByRole("button", { name: "Send 1 to kitchen" })).toBeVisible();
    await page.getByRole("button", { name: /^Pils 0,5 l,/ }).click();
    await expect(page.getByRole("button", { name: "Send 2 to kitchen" })).toBeVisible();
    await page.getByRole("button", { name: "Send 2 to kitchen" }).click();
    await expect(page.getByRole("region", { name: "Order" }).getByText(/^Sent /)).toBeVisible();
  });

  await test.step("the bill lists each VAT rate after the total, in euros", async () => {
    await page.getByRole("button", { name: "Bill", exact: true }).click();
    const bill = page.getByRole("region", { name: "Bill 1" });
    await expect(bill.getByText("VAT 20% (included)", { exact: true })).toBeVisible();
    // Lines show the menu price (Pils 4,90 €, not 3,92 € after happy hour): the discount is its own row below.
    await expect(bill.getByText("4,90 €", { exact: true })).toBeVisible();
    await expect(bill.getByText("3,92 €", { exact: true })).toHaveCount(0);
    const rows = await totalsRows(bill.locator("dl > div"));
    expect(rows.slice(rows.findIndex(([label]) => label === "Total"))).toEqual(FROM_TOTAL);
    await expect(bill.getByRole("button", { name: /^Pay 20,82\s€/ })).toBeVisible();
  });

  let receiptUrl = "";
  await test.step("pay by card and show the receipt QR", async () => {
    await page.getByRole("region", { name: "Bill 1" }).getByRole("button", { name: /^Pay / }).click();
    await page.getByRole("group", { name: "Payment method" }).getByRole("button", { name: "Card", exact: true }).click();
    await page.getByRole("button", { name: /^Paid by Card/ }).click();
    await expect(page.getByText(/^Paid · Bill 1 · /)).toBeVisible();
    const sent = page.waitForResponse((r) => /\/v1\/checks\/[^/]+\/receipt\/send$/.test(r.url()) && r.ok());
    await page.getByRole("button", { name: "QR on screen" }).click();
    receiptUrl = ((await (await sent).json()) as { data: { url: string } }).data.url;
    expect(receiptUrl.startsWith(`${GUEST}/r/`), receiptUrl).toBe(true);
  });

  await test.step("the guest receipt shows the same rows, formatted from the document's own currency and locale", async () => {
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
    watch.attach(phone);
    await phone.goto(receiptUrl);
    const totals = phone.getByRole("region", { name: "Totals" });
    await expect(totals.getByText("VAT 20% (included)", { exact: true })).toBeVisible();
    const rows = await totalsRows(totals.locator(":scope > div"));
    expect(rows.slice(rows.findIndex(([label]) => label === "Total"))).toEqual(FROM_TOTAL);
    expect(await phone.evaluate(() => document.documentElement.lang)).toBe("de-DE");
  });
});
