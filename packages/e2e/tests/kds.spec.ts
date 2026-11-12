import { devLocal, expect, keyIn, pairAndSignIn, register, test, WEB } from "./fixtures";

const MANAGER_PIN = "222222"; // Mia Manager (dev seed): sends, and voids a sent line without asking anyone

test.use({ viewport: { width: 1180, height: 820 } });

test("kitchen display: pair a screen, see a sent order, bump it to ready on the POS, see a void struck", async ({ browser, page, watch }) => {
  test.setTimeout(600_000);
  const { outletId } = devLocal();
  const stations = await register<{ data: { id: string; kind: string; name: string }[] }>("GET", `/v1/outlets/${outletId}/stations`);
  const display = stations.data.find((s) => s.kind === "display");
  if (!display) throw new Error("The demo outlet has no kitchen display station");

  // The display is its own browser: a wall screen with no one signed in.
  const kdsContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const kds = await kdsContext.newPage();
  watch.attach(kds);
  const tickets = kds.getByRole("region", { name: "Tickets" });

  await test.step("pair the screen to the kitchen display station with a one-time code the POS refused", async () => {
    const { data } = await register<{ data: { code: string } }>("POST", `/v1/stations/${display.id}/pairing-code`, {});
    // The POS refuses a display's code before using it, so the same code still pairs the screen.
    watch.allow({ status: 400, url: /\/v1\/stations\/pair$/, why: "the POS is given the display's code on purpose" });
    await page.goto(`${WEB}/pos`);
    await expect(page.getByRole("heading", { name: "Pair this iPad to a station" })).toBeVisible({ timeout: 180_000 });
    await keyIn(page, "PIN keys", data.code);
    await page.getByRole("button", { name: "Pair this iPad" }).click();
    await expect(page.getByText("This code is for a kitchen display station")).toBeVisible();
    await kds.goto(`${WEB}/kds`);
    await expect(kds.getByRole("heading", { name: "Pair this screen to a station" })).toBeVisible({ timeout: 180_000 });
    await keyIn(kds, "PIN keys", data.code);
    await kds.getByRole("button", { name: "Pair this screen" }).click();
    await expect(tickets).toBeVisible();
    await expect(kds.getByText(display.name)).toBeVisible();
  });

  let table = "";
  await test.step("the POS seats a table and sends Mee Goreng and Char Kway Teow", async () => {
    await pairAndSignIn(page, MANAGER_PIN);
    await page.getByRole("button", { name: "Floor", exact: true }).click();
    const free = page.getByRole("button", { name: /^Table \d+, Free/ }).first();
    table = /^Table (\d+)/.exec((await free.getAttribute("aria-label")) ?? "")![1]!;
    await free.click();
    await page.getByRole("button", { name: "2 guests", exact: true }).click();
    await page.getByRole("button", { name: /^Mee Goreng,/ }).click();
    await expect(page.getByRole("button", { name: "Send 1 to kitchen" })).toBeVisible();
    await page.getByRole("button", { name: /^Char Kway Teow,/ }).click();
    await page.getByRole("button", { name: "Send 2 to kitchen" }).click();
    await expect(page.getByRole("region", { name: "Order" }).getByText(/^Sent /)).toBeVisible();
  });

  const card = () => tickets.getByRole("button", { name: new RegExp(`^(Bump|Clear) Table ${table},`) });

  await test.step("the ticket arrives on the display over the live stream, with the all-day count", async () => {
    await expect(card()).toBeVisible();
    await expect(card()).toContainText("Mee Goreng");
    await expect(card()).toContainText("Char Kway Teow");
    await expect(kds.getByRole("complementary", { name: "All day" })).toContainText("Char Kway Teow");
  });

  await test.step("a sent line voided on the POS is struck through on the ticket, which is marked changed", async () => {
    const order = page.getByRole("region", { name: "Order" });
    await order.getByRole("button", { name: /^1 Mee Goreng, / }).click();
    const sheet = page.getByRole("dialog", { name: "Mee Goreng" });
    await sheet.getByRole("button", { name: "Void" }).click();
    await sheet.getByRole("group", { name: "Reason" }).getByRole("button", { name: "Kitchen error" }).click();
    await expect(sheet).toBeHidden();
    await expect(card()).toHaveAccessibleName(/, changed$/);
    await expect(card().getByText("Voided", { exact: true })).toBeVisible();
    await expect(card().getByText("Mee Goreng")).toHaveCSS("text-decoration-line", "line-through");
    await expect(card().getByText("Char Kway Teow")).not.toHaveCSS("text-decoration-line", "line-through");
  });

  await test.step("a tap bumps the ticket off the display, and the POS shows the line ready", async () => {
    await card().click();
    await expect(card()).toHaveCount(0);
    await expect(kds.getByRole("button", { name: `Recall Table ${table}` })).toBeEnabled();
    await expect(page.getByRole("region", { name: "Order" }).getByRole("button", { name: /^1 Char Kway Teow, ready$/ })).toBeVisible();
  });

  await test.step("recall puts the ticket back on the display", async () => {
    await kds.getByRole("button", { name: `Recall Table ${table}` }).click();
    await expect(card()).toBeVisible();
    await expect(card()).toContainText("Recalled");
    await expect(page.getByRole("region", { name: "Order" }).getByRole("button", { name: /^1 Char Kway Teow, ready$/ })).toHaveCount(0);
    // Off again, so the demo register is left without open tickets for this table.
    await card().click();
    await expect(card()).toHaveCount(0);
  });

  await kdsContext.close();
});
