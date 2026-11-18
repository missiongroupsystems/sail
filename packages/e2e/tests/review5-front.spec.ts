import type { BrowserContext, Page } from "@playwright/test";
import { API, devLocal, expect, GUEST, keyIn, pairAndSignIn, register, shot, test, WEB } from "./fixtures";

/**
 * Fifth review round, front (`fix/review5-front`): a guest phone reloaded (or woken) on its paid screen comes back after
 * a void or a reopen; an order whose invoice was cancelled by a credit note can be split again; By item moves a line on
 * a tap anywhere on the other bill; the reopen notice names only that reopen's payments, in the order's flow; and the
 * Low items (the Floor tab's count, the waiting header, Ready by on the kitchen display). Shots go to REVIEW5_SHOTS
 * when set (the report's folder), else the test's output.
 */
const MANAGER_PIN = "222222";
const out = (name: string) => (process.env.REVIEW5_SHOTS ? `${process.env.REVIEW5_SHOTS}/${name}` : test.info().outputPath(name));

async function bothThemes(page: Page, name: string) {
  for (const theme of ["day", "service"] as const) {
    await page.evaluate((t) => (t === "service" ? (document.documentElement.dataset.theme = "service") : delete document.documentElement.dataset.theme), theme);
    await page.waitForTimeout(150);
    await shot(page, out(`${name}-${theme}.png`));
  }
  await page.evaluate(() => delete document.documentElement.dataset.theme);
}

async function products(): Promise<Record<string, string>> {
  const p = await register<{ data: { id: string; name: string }[] }>("GET", "/v1/products?limit=60");
  return Object.fromEntries(p.data.map((x) => [x.name, x.id]));
}

type Check = { id: string; label: string; balance: number; payments: { id: string; status: string }[] };
type Order = { id: string; status: string; totals: { total: number }; checks: Check[] };
const getOrder = async (id: string) => (await register<{ data: Order }>("GET", `/v1/orders/${id}`)).data;

async function byHand(): Promise<string> {
  const tenders = await register<{ data: { id: string; is_cash: boolean; provider?: string | null }[] }>("GET", "/v1/tender-types");
  return tenders.data.find((t) => !t.is_cash && !t.provider)!.id;
}

/** Pay every bill that owes by hand; the ids of the payments taken. */
async function payAll(orderId: string): Promise<string[]> {
  const tender = await byHand();
  const ids: string[] = [];
  for (const c of (await getOrder(orderId)).checks.filter((x) => x.balance > 0)) {
    const res = await register<{ data: Order }>("POST", `/v1/checks/${c.id}/payments`, { payment_id: crypto.randomUUID(), tender_type_id: tender, amount: c.balance });
    ids.push(res.data.checks.find((x) => x.id === c.id)!.payments.find((p) => p.status === "recorded")!.id);
  }
  return ids;
}

async function bumpAll(orderId: string) {
  const tickets = await register<{ data: { id: string; order_id: string }[] }>("GET", `/v1/outlets/${devLocal().outletId}/kitchen-tickets`);
  for (const t of tickets.data.filter((x) => x.order_id === orderId)) await register("POST", `/v1/kitchen-tickets/${t.id}/bump`, {}).catch(() => undefined);
}

/** Leave nothing behind: waiting rounds rejected, the order paid by hand (or cancelled when empty), its tickets bumped. */
async function settle(orderId: string) {
  const rounds = await register<{ data: { id: string; order_id: string }[] }>("GET", `/v1/outlets/${devLocal().outletId}/rounds?status=pending`);
  for (const r of rounds.data.filter((x) => x.order_id === orderId)) await register("POST", `/v1/rounds/${r.id}/reject`, { reason: "Test over" }).catch(() => undefined);
  const o = await getOrder(orderId);
  if (o.status !== "completed" && o.status !== "cancelled") {
    if (o.totals.total === 0) await register("POST", `/v1/orders/${orderId}/cancel`, { reason: "Test over" }).catch(() => undefined);
    else {
      await payAll(orderId);
      await register("POST", `/v1/orders/${orderId}/complete`, {}).catch(() => undefined);
    }
  }
  await bumpAll(orderId);
}

/** A dine-in order on a free table with sent lines, and the table's QR code. */
async function seatedTable(lines: { product_id: string; quantity: number }[] = []) {
  const { outletId, brandId } = devLocal();
  const floor = await register<{ data: { tables: { id: string; name: string; order: unknown }[] } }>("GET", `/v1/outlets/${outletId}/floor`);
  const table = floor.data.tables.find((t) => !t.order)!;
  const order = await register<{ data: { id: string; order_no: string } }>("POST", "/v1/orders", { order_id: crypto.randomUUID(), order_type: "dine_in", table_id: table.id, pax: 2, outlet_id: outletId, brand_id: brandId });
  if (lines.length) {
    await register("POST", `/v1/orders/${order.data.id}/lines`, { lines: lines.map((l) => ({ line_id: crypto.randomUUID(), ...l })) });
    await register("POST", `/v1/orders/${order.data.id}/fire`, {});
  }
  const qr = await register<{ data: { url: string } }>("POST", `/v1/tables/${table.id}/qr/rotate`, {});
  return { order: order.data, table, token: qr.data.url.split("/t/")[1]! };
}

/* ---------------------------------------------------------------- W1 */

test("W1: two phones, one reloaded on the paid screen, follow every void and reopen within seconds, locked or not, with no refused request; a later code rotation and Order again end it plainly", async ({ browser }) => {
  test.setTimeout(420_000);
  const ids = await products();
  const { order, table, token } = await seatedTable([{ product_id: ids["Kopi"]!, quantity: 1 }]);
  const phones: { ctx: BrowserContext; page: Page; refused: string[] }[] = [];
  for (let i = 0; i < 2; i++) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    const refused: string[] = [];
    page.on("response", (r) => {
      if (r.url().startsWith(API) && r.status() === 401) refused.push(`${r.request().method()} ${r.url()}`);
    });
    phones.push({ ctx, page, refused });
  }
  const [live, reloaded] = phones as [(typeof phones)[number], (typeof phones)[number]];
  const paid = (p: Page) => p.getByText("Your bill is paid.");
  // Back on the order: the menu's items are tappable again.
  const ordering = (p: Page) => p.getByRole("button", { name: /^Kopi,/ });
  const both = async (check: (p: Page) => Promise<void>) => Promise.all(phones.map((x) => check(x.page)));
  try {
    await both(async (p) => {
      await p.goto(`${GUEST}/t/${token}`);
      await expect(ordering(p)).toBeVisible({ timeout: 120_000 });
    });

    // 1. Paid live, then one phone is reloaded on its paid screen; the payment is voided: both are back, without any event.
    let payments = await payAll(order.id);
    await both((p) => expect(paid(p)).toBeVisible({ timeout: 20_000 }));
    await reloaded.page.reload();
    await expect(paid(reloaded.page)).toBeVisible({ timeout: 60_000 });
    await expect(reloaded.page.getByRole("button", { name: "Order again" })).toBeVisible();
    await bothThemes(reloaded.page, "W1-paid-after-reload");
    await reloaded.page.waitForTimeout(1500);
    let started = Date.now();
    await register("POST", `/v1/payments/${payments[0]}/void`, { reason: "Wrong payment method" });
    await both((p) => expect(ordering(p)).toBeVisible({ timeout: 10_000 }));
    const voidMs = Date.now() - started;

    // 2. Paid again, both reloaded, then the phones lock (the connection drops) and the order is reopened meanwhile.
    await payAll(order.id);
    await both((p) => expect(paid(p)).toBeVisible({ timeout: 20_000 }));
    for (const x of phones) await x.page.reload();
    await both((p) => expect(paid(p)).toBeVisible({ timeout: 60_000 }));
    await reloaded.page.waitForTimeout(1500);
    for (const x of phones) await x.ctx.setOffline(true);
    await reloaded.page.waitForTimeout(1000);
    await register("POST", `/v1/orders/${order.id}/reopen`, { reason: "Guest wants dessert" });
    started = Date.now();
    for (const x of phones) await x.ctx.setOffline(false);
    await both((p) => expect(ordering(p)).toBeVisible({ timeout: 15_000 }));
    const reopenMs = Date.now() - started;

    // 3. Paid and reloaded once more: a reopen with the phones open.
    payments = await payAll(order.id);
    await both((p) => expect(paid(p)).toBeVisible({ timeout: 20_000 }));
    await reloaded.page.reload();
    await expect(paid(reloaded.page)).toBeVisible({ timeout: 60_000 });
    await reloaded.page.waitForTimeout(1500);
    await register("POST", `/v1/orders/${order.id}/reopen`, { reason: "Wrong items" });
    await both((p) => expect(ordering(p)).toBeVisible({ timeout: 10_000 }));

    // No phone was refused anything on the way: the paid screen holds the stream, and a reload asks nothing else.
    for (const x of phones) expect(x.refused, "401s on the phone").toEqual([]);
    test.info().annotations.push({ type: "timing", description: `void → both phones back ${voidMs} ms; reopen while offline → back ${reopenMs} ms after reconnecting` });

    // 4. Paid, reloaded, then the table's code is rotated: both phones say so (not "paid" until a tap).
    await payAll(order.id);
    await both((p) => expect(paid(p)).toBeVisible({ timeout: 20_000 }));
    await reloaded.page.reload();
    await expect(paid(reloaded.page)).toBeVisible({ timeout: 60_000 });
    await reloaded.page.waitForTimeout(1500);
    const rotated = await register<{ data: { url: string } }>("POST", `/v1/tables/${table.id}/qr/rotate`, {});
    await both((p) => expect(p.getByText("This table has a new QR code.")).toBeVisible({ timeout: 15_000 }));
    // 5. The new code: Order again from a paid screen opens the menu on a fresh session.
    const fresh = rotated.data.url.split("/t/")[1]!;
    await live.page.goto(`${GUEST}/t/${fresh}`);
    await expect(live.page.getByText(/Kopi/).first()).toBeVisible({ timeout: 60_000 });
  } finally {
    for (const x of phones) await x.ctx.close();
    await settle(order.id);
  }
});

/* ---------------------------------------------------------------- W2, W3 */

/** Open the table's order on the POS and go to its Bill screen. */
async function openBill(page: Page, tableName: string) {
  await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Floor", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(`^Table ${tableName},`) }).click();
  await expect(page.getByRole("region", { name: "Order" })).toBeVisible();
  await page.getByRole("button", { name: /^Bill/ }).click();
  await expect(page.getByRole("group", { name: "Split mode" })).toBeVisible();
}

const mode = (page: Page, name: string) => page.getByRole("group", { name: "Split mode" }).getByRole("button", { name, exact: true });

for (const how of ["void", "reopen"] as const) {
  test(`W2 (${how}): after Get invoice and a ${how}, one bill splits Even and back; a split order whose two bills were invoiced keeps two bills, with One bill disabled and its reason`, async ({ page, watch }) => {
    test.setTimeout(400_000);
    void watch;
    const ids = await products();
    const one = await seatedTable([{ product_id: ids["Mee Goreng"]!, quantity: 1 }, { product_id: ids["Kopi"]!, quantity: 2 }]);
    const two = await seatedTable([{ product_id: ids["Mee Goreng"]!, quantity: 2 }, { product_id: ids["Kopi"]!, quantity: 1 }]);
    try {
      // One bill: paid, invoiced, then reversed.
      const undo = async (orderId: string, payments: string[]) => {
        if (how === "void") for (const p of payments) await register("POST", `/v1/payments/${p}/void`, { reason: "Wrong payment method" });
        else await register("POST", `/v1/orders/${orderId}/reopen`, { reason: "Wrong items" });
      };
      const p1 = await payAll(one.order.id);
      await register("POST", `/v1/checks/${(await getOrder(one.order.id)).checks[0]!.id}/invoice`, {});
      await undo(one.order.id, p1);
      // Two bills, each invoiced, then reversed.
      await register("POST", `/v1/orders/${two.order.id}/checks/split-even`, { n: 2 });
      const p2 = await payAll(two.order.id);
      for (const c of (await getOrder(two.order.id)).checks) await register("POST", `/v1/checks/${c.id}/invoice`, {});
      await undo(two.order.id, p2);

      await pairAndSignIn(page, MANAGER_PIN);
      await openBill(page, one.table.name);
      await mode(page, "Even").click();
      await expect(page.getByRole("region", { name: "Bill 2" })).toBeVisible();
      await page.getByRole("group", { name: "Number of bills" }).getByRole("button", { name: "3 bills" }).click();
      await expect(page.getByRole("region", { name: "Bill 3" })).toBeVisible();
      await expect(page.getByText(/had tax invoice/)).toHaveCount(0);
      await mode(page, "One bill").click();
      await expect(page.getByRole("region", { name: "Bill 2" })).toHaveCount(0);
      await expect(page.getByRole("status").filter({ hasText: /invoice/ })).toHaveCount(0);

      await openBill(page, two.table.name);
      // Both bills had an invoice cancelled: the order keeps two bills. One bill is not on offer; its reason is one line.
      await expect(mode(page, "One bill")).toBeDisabled();
      await mode(page, "By item").click();
      await expect(page.getByRole("region", { name: "Bill 2" })).toBeVisible();
      await mode(page, "Even").click();
      const counts = page.getByRole("group", { name: "Number of bills" });
      await expect(counts.getByRole("button", { name: "2 bills" })).toBeVisible();
      await counts.getByRole("button", { name: "3 bills" }).click();
      await expect(page.getByRole("region", { name: "Bill 3" })).toBeVisible();
      await counts.getByRole("button", { name: "2 bills" }).click();
      await expect(page.getByRole("region", { name: "Bill 3" })).toHaveCount(0);
      if (how === "void") await bothThemes(page, "W2-bill-after-cancelled-invoices");
      const after = await register<{ data: { checks: { cancelled_invoices: unknown[] }[] } }>("GET", `/v1/orders/${two.order.id}`);
      expect(after.data.checks.map((c) => c.cancelled_invoices.length)).toEqual([1, 1]);
    } finally {
      await settle(one.order.id);
      await settle(two.order.id);
    }
  });
}

test("W3: By item with touch: a tap on a line inside the other bill moves the picked line there; a tap in its own bill picks another; a second tap lets go", async ({ browser }) => {
  test.setTimeout(400_000);
  const ids = await products();
  const { order, table } = await seatedTable([{ product_id: ids["Mee Goreng"]!, quantity: 1 }, { product_id: ids["Kopi"]!, quantity: 1 }, { product_id: ids["Otah"]!, quantity: 1 }]);
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true });
  const page = await ctx.newPage();
  try {
    await pairAndSignIn(page, MANAGER_PIN);
    await openBill(page, table.name);
    await mode(page, "By item").tap();
    const bill1 = page.getByRole("region", { name: "Bill 1" });
    await expect(page.getByRole("region", { name: "Bill 2" })).toBeVisible();
    const lines = page.getByRole("region", { name: "Lines" });
    // Move Kopi to Bill 2 with the bill's header, so Bill 2 has a line to tap.
    await lines.getByRole("button", { name: /Kopi/ }).tap();
    await page.getByRole("button", { name: "Bill 2, move the selected line here" }).tap();
    await expect(page.getByRole("region", { name: "Bill 2" })).toContainText("Kopi");
    // Pick Otah on Bill 1, then tap the Kopi line inside Bill 2: Otah moves there.
    await bill1.getByRole("button", { name: /Otah/ }).tap();
    const target = page.getByRole("button", { name: "Bill 2, move the selected line here" });
    await expect(target).toContainText("Tap to move here");
    await bothThemes(page, "W3-by-item-picked");
    await target.getByRole("button", { name: /Kopi/ }).tap();
    await expect(page.getByRole("region", { name: "Bill 2" })).toContainText("Otah");
    await expect(page.getByRole("region", { name: "Bill 1" })).not.toContainText("Otah");
    // In its own bill a tap picks another line, and a tap on the picked line lets go.
    await page.getByRole("region", { name: "Bill 1" }).getByRole("button", { name: /Mee Goreng/ }).tap();
    await expect(page.getByRole("region", { name: "Bill 1" }).getByRole("button", { name: /Mee Goreng/ })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("region", { name: "Bill 1" }).getByRole("button", { name: /Mee Goreng/ }).tap();
    await expect(page.getByRole("button", { name: /move the selected line here/ })).toHaveCount(0);
    // Nothing stacked at the bottom of the screen: no toast for a move.
    await expect(page.getByText(/moved to Bill/)).toHaveCount(0);
    // Every line on a bill is a 44 px target.
    for (const b of await page.getByRole("region", { name: /^Bill \d/ }).getByRole("button", { name: /Mee Goreng|Kopi|Otah/ }).all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await mode(page, "One bill").tap();
    await expect(page.getByRole("region", { name: "Bill 2" })).toHaveCount(0);
  } finally {
    await ctx.close();
    await settle(order.id);
  }
});

/* ---------------------------------------------------------------- W4 */

test("W4: after two reopens the notice names only the last one's payment, as the first row of the order, not over a line, not on the pay screen, and goes once a payment is taken", async ({ page }) => {
  test.setTimeout(300_000);
  const ids = await products();
  const { order, table } = await seatedTable([{ product_id: ids["Mee Goreng"]!, quantity: 1 }, { product_id: ids["Kopi"]!, quantity: 1 }]);
  try {
    await payAll(order.id);
    await register("POST", `/v1/orders/${order.id}/reopen`, { reason: "Wrong items" });
    await payAll(order.id);
    await register("POST", `/v1/orders/${order.id}/reopen`, { reason: "Guest wants dessert" });
    await pairAndSignIn(page, MANAGER_PIN);
    await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Floor", exact: true }).click();
    await page.getByRole("button", { name: new RegExp(`^Table ${table.name},`) }).click();
    const panel = page.getByRole("region", { name: "Order" });
    const note = panel.getByRole("note");
    await expect(note).toContainText("Reopened: the payment of");
    await expect(note).not.toContainText("2 payments");
    // In the flow of the lines: above the first line and overlapping none.
    const box = (await note.boundingBox())!;
    for (const line of await panel.getByRole("button", { name: /Mee Goreng|Kopi/ }).all()) {
      const b = (await line.boundingBox())!;
      expect(b.y >= box.y + box.height - 1 || b.y + b.height <= box.y + 1, "the note covers no line").toBe(true);
      expect(b.y).toBeGreaterThan(box.y);
    }
    await bothThemes(page, "W4-reopen-note");
    await page.getByRole("button", { name: /^Pay \$/ }).click();
    await expect(page.getByRole("heading", { name: "Take payment" })).toBeVisible();
    await expect(page.getByRole("note").filter({ hasText: "Reopened" })).toHaveCount(0);
    // A part payment taken: the notice has done its work.
    const c = (await getOrder(order.id)).checks[0]!;
    await register("POST", `/v1/checks/${c.id}/payments`, { payment_id: crypto.randomUUID(), tender_type_id: await byHand(), amount: 100 });
    await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Floor", exact: true }).click();
    await page.getByRole("button", { name: new RegExp(`^Table ${table.name},`) }).click();
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("note")).toHaveCount(0);
  } finally {
    await settle(order.id);
  }
});

/* ---------------------------------------------------------------- W5 */

test("W5: a QR order arriving while the POS is on the Shift screen counts on the Floor tab; the waiting header keeps the guest's name; a pickup's Ready by is on the kitchen display", async ({ page, browser, watch }) => {
  test.setTimeout(400_000);
  const ids = await products();
  const { order, table, token } = await seatedTable([{ product_id: ids["Kopi"]!, quantity: 1 }]);
  const { outletId, brandId } = devLocal();
  let pickup: string | null = null;
  try {
    await pairAndSignIn(page, MANAGER_PIN);
    await page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Shift", exact: true }).click();
    const floorTab = page.getByRole("navigation", { name: "Destinations" }).getByRole("button", { name: "Floor", exact: true });
    await expect(floorTab).not.toHaveAttribute("aria-description", /waiting/);
    const s = await fetch(`${API}/v1/guest/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, device_id: "review5-w5-phone" }) });
    const guest = ((await s.json()) as { data: { guest_token: string } }).data.guest_token;
    const r = await fetch(`${API}/v1/guest/rounds`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${guest}`, "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ round_id: crypto.randomUUID(), guest_name: "Alexandra Konstantinopoulou", lines: [{ line_id: crypto.randomUUID(), product_id: ids["Otah"]!, quantity: 1 }] }) });
    expect(r.status).toBe(201);
    await expect(floorTab).toHaveAttribute("aria-description", "1 waiting", { timeout: 10_000 });
    await bothThemes(page, "W5-shift-floor-count");

    // The waiting header on the order, with lines below it: the name and time stay, the label gives way.
    await floorTab.click();
    await page.getByRole("button", { name: new RegExp(`^Table ${table.name},`) }).click();
    const panel = page.getByRole("region", { name: "Order" });
    await expect(panel.getByText(/· Alexandra Konstantinopoulou/)).toBeVisible();
    const detail = panel.getByText(/· Alexandra Konstantinopoulou/);
    expect(await detail.evaluate((e) => e.scrollWidth <= e.clientWidth + 1), "the name is not cut").toBe(true);
    await bothThemes(page, "W5-waiting-header");

    // A pickup for later: its Ready by on the kitchen display's ticket.
    const readyBy = new Date(Date.now() + 45 * 60_000);
    readyBy.setSeconds(0, 0);
    const p = await register<{ data: { id: string } }>("POST", "/v1/orders", { order_id: crypto.randomUUID(), order_type: "pickup", customer_ref: { name: "Pat" }, ready_by: readyBy.toISOString(), outlet_id: outletId, brand_id: brandId });
    pickup = p.data.id;
    await register("POST", `/v1/orders/${pickup}/lines`, { lines: [{ line_id: crypto.randomUUID(), product_id: ids["Mee Goreng"]!, quantity: 1 }] });
    await register("POST", `/v1/orders/${pickup}/fire`, {});
    const tickets = await register<{ data: { order_id: string; ready_by: string | null }[] }>("GET", `/v1/outlets/${outletId}/kitchen-tickets`);
    expect(tickets.data.find((t) => t.order_id === pickup)!.ready_by).toBe(readyBy.toISOString());
    const display = (await register<{ data: { id: string; kind: string }[] }>("GET", `/v1/outlets/${outletId}/stations`)).data.find((x) => x.kind === "display")!;
    const code = (await register<{ data: { code: string } }>("POST", `/v1/stations/${display.id}/pairing-code`, {})).data.code;
    const kdsContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const kds = await kdsContext.newPage();
    watch.attach(kds);
    try {
      await kds.goto(`${WEB}/kds`);
      await expect(kds.getByRole("heading", { name: "Pair this screen to a station" })).toBeVisible({ timeout: 180_000 });
      await keyIn(kds, "PIN keys", code);
      await kds.getByRole("button", { name: "Pair this screen" }).click();
      const ticket = kds.getByRole("region", { name: "Tickets" }).getByRole("button", { name: /^Bump Pat · / });
      await expect(ticket.first()).toBeVisible({ timeout: 60_000 });
      await expect(ticket.first()).toContainText("Ready by");
      await bothThemes(kds, "W5-kds-ready-by");
    } finally {
      await kdsContext.close();
    }
  } finally {
    await settle(order.id);
    if (pickup) await settle(pickup);
  }
});
