import type { Page, Route } from "@playwright/test";
import { API, devLocal, expect, pairAndSignIn, register, shot, test } from "./fixtures";

/**
 * Fourth review round, front (`fix/review4-front`): a POS action whose answer is lost never spins without end (the
 * sold-out reject is one request), the paid screen stays for every tender, quick notes and the typed note stay apart,
 * the guest phone follows the table's state, the QR review sheet, and the shift screen after Open shift. Shots go to
 * REVIEW4_SHOTS when set (the report's folder), else the test's output.
 */
const MANAGER_PIN = "222222";
const out = (name: string) => (process.env.REVIEW4_SHOTS ? `${process.env.REVIEW4_SHOTS}/${name}` : test.info().outputPath(name));

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

async function bumpAll(orderId: string) {
  const tickets = await register<{ data: { id: string; order_id: string }[] }>("GET", `/v1/outlets/${devLocal().outletId}/kitchen-tickets`);
  for (const t of tickets.data.filter((x) => x.order_id === orderId)) await register("POST", `/v1/kitchen-tickets/${t.id}/bump`, {}).catch(() => undefined);
}

async function rejectWaiting(orderId: string) {
  const rounds = await register<{ data: { id: string; order_id: string }[] }>("GET", `/v1/outlets/${devLocal().outletId}/rounds?status=pending`);
  for (const r of rounds.data.filter((x) => x.order_id === orderId)) await register("POST", `/v1/rounds/${r.id}/reject`, { reason: "Test over" }).catch(() => undefined);
}

/** Leave nothing behind: waiting rounds rejected, the order paid by hand and completed (or cancelled when empty), its tickets bumped. */
async function settle(orderId: string) {
  await rejectWaiting(orderId);
  const o = await register<{ data: { status: string; totals: { total: number }; checks: { id: string; balance: number }[] } }>("GET", `/v1/orders/${orderId}`);
  if (o.data.status !== "completed" && o.data.status !== "cancelled") {
    if (o.data.totals.total === 0) await register("POST", `/v1/orders/${orderId}/cancel`, { reason: "Test over" }).catch(() => undefined);
    else {
      const tenders = await register<{ data: { id: string; is_cash: boolean; provider?: string | null }[] }>("GET", "/v1/tender-types");
      const byHand = tenders.data.find((t) => !t.is_cash && !t.provider)!;
      for (const c of o.data.checks.filter((x) => x.balance > 0)) await register("POST", `/v1/checks/${c.id}/payments`, { payment_id: crypto.randomUUID(), tender_type_id: byHand.id, amount: c.balance });
      await register("POST", `/v1/orders/${orderId}/complete`, {}).catch(() => undefined);
    }
  }
  await bumpAll(orderId);
}

/** A dine-in order on a free table and its QR code. */
async function seatedTable() {
  const { outletId, brandId } = devLocal();
  const floor = await register<{ data: { tables: { id: string; name: string; area_id: string; order: unknown }[] } }>("GET", `/v1/outlets/${outletId}/floor`);
  const area = floor.data.tables[0]!.area_id;
  const table = floor.data.tables.find((t) => !t.order && t.area_id === area) ?? floor.data.tables.find((t) => !t.order)!;
  const order = await register<{ data: { id: string; order_no: string } }>("POST", "/v1/orders", { order_id: crypto.randomUUID(), order_type: "dine_in", table_id: table.id, pax: 2, outlet_id: outletId, brand_id: brandId });
  const qr = await register<{ data: { url: string } }>("POST", `/v1/tables/${table.id}/qr/rotate`, {});
  return { order: order.data, table, token: qr.data.url.split("/t/")[1]! };
}

/** A waiting round from a phone session on the table (made through the API). */
async function guestRound(token: string, device: string, lines: { product_id: string; quantity: number }[]) {
  const s = await fetch(`${API}/v1/guest/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, device_id: device, guest_name: "Ben" }) });
  expect(s.status, await s.clone().text()).toBe(201);
  const guest = ((await s.json()) as { data: { guest_token: string } }).data.guest_token;
  const roundId = crypto.randomUUID();
  const r = await fetch(`${API}/v1/guest/rounds`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${guest}`, "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ round_id: roundId, lines: lines.map((l) => ({ line_id: crypto.randomUUID(), ...l })) }) });
  expect(r.status, await r.clone().text()).toBe(201);
  return { roundId, guest };
}

const soldOutNow = async () => (await register<{ data: { product_id: string; sold_out: boolean }[] }>("GET", `/v1/outlets/${devLocal().outletId}/stock`)).data.filter((s) => s.sold_out).map((s) => s.product_id);
const roundStatus = async (roundId: string) => {
  for (const status of ["pending", "rejected"] as const) {
    const rounds = await register<{ data: { id: string }[] }>("GET", `/v1/outlets/${devLocal().outletId}/rounds?status=${status}`);
    if (rounds.data.some((r) => r.id === roundId)) return status;
  }
  return "other";
};

/** Open the Now card's Reject sheet for the table's round and pick Sold out with one item ticked. */
async function soldOutSheet(page: Page, tableName: string, item?: string) {
  const rail = page.getByRole("complementary", { name: "Now" });
  await rail.getByRole("listitem").filter({ hasText: `Table ${tableName} · QR order` }).first().getByRole("button", { name: "Reject" }).click();
  const sheet = page.getByRole("dialog", { name: "Reject QR order" });
  await sheet.getByRole("button", { name: "Sold out", exact: true }).click();
  // One item is ticked already; with more, staff say which.
  if (item) await sheet.getByRole("group", { name: "Which items are sold out?" }).getByText(item).click();
  return sheet;
}

test.describe("U1: a lost answer", () => {
  test("Reject as sold out is one request: when its answer is dropped, the POS asks again under the same key, the sheet closes and the item is sold out, done once", async ({ page, watch }) => {
    test.setTimeout(300_000);
    // The dropped answers on purpose.
    watch.allowConsole(/ERR_CONNECTION_RESET/);
    const ids = await products();
    const { order, table, token } = await seatedTable();
    const { roundId } = await guestRound(token, "review4-u1-a", [
      { product_id: ids["Otah"]!, quantity: 1 },
      { product_id: ids["Popiah"]!, quantity: 1 },
    ]);
    try {
      await pairAndSignIn(page, MANAGER_PIN);
      const sent: { key: string | null; body: string | null }[] = [];
      let replayed: string | null = null;
      await page.route("**/v1/rounds/*/reject", async (route: Route) => {
        sent.push({ key: route.request().headers()["idempotency-key"] ?? null, body: route.request().postData() });
        if (sent.length === 1) {
          // The register does it, and its answer never reaches the iPad.
          await route.fetch();
          await route.abort("connectionreset");
          return;
        }
        const res = await route.fetch();
        replayed = res.headers()["idempotent-replayed"] ?? null;
        await route.fulfill({ response: res });
      });
      const stockCalls: string[] = [];
      page.on("request", (r) => {
        if (r.url().includes("/v1/stock/")) stockCalls.push(r.url());
      });
      const sheet = await soldOutSheet(page, table.name, "Otah");
      await sheet.getByRole("button", { name: "Reject as sold out" }).click();
      await expect(sheet).toHaveCount(0);
      // One action, one request: the reject carries the sold-out item; no second call marks it.
      expect(sent).toHaveLength(2);
      expect(sent[1]!.key).toBe(sent[0]!.key);
      expect(JSON.parse(sent[0]!.body!)).toEqual({ reason: "Sold out", sold_out_product_ids: [ids["Otah"]] });
      expect(replayed).toBe("true");
      expect(stockCalls).toEqual([]);
      expect(await roundStatus(roundId)).toBe("rejected");
      expect(await soldOutNow()).toContain(ids["Otah"]!);
      expect(await soldOutNow()).not.toContain(ids["Popiah"]!);
    } finally {
      await register("POST", "/v1/stock/restore", { outlet_id: devLocal().outletId, product_id: ids["Otah"]! }).catch(() => undefined);
      await settle(order.id);
    }
  });

  test("a reject that never reaches the register says Not sent and stays ready to try again; the try goes through", async ({ page, watch }) => {
    test.setTimeout(300_000);
    // The dropped answers on purpose.
    watch.allowConsole(/ERR_CONNECTION_RESET/);
    const ids = await products();
    const { order, table, token } = await seatedTable();
    const { roundId } = await guestRound(token, "review4-u1-b", [{ product_id: ids["Otah"]!, quantity: 1 }]);
    try {
      await pairAndSignIn(page, MANAGER_PIN);
      let drop = true;
      await page.route("**/v1/rounds/*/reject", async (route: Route) => {
        if (drop) return route.abort("connectionreset");
        await route.continue();
      });
      const rail = page.getByRole("complementary", { name: "Now" });
      await rail.getByRole("listitem").filter({ hasText: `Table ${table.name} · QR order` }).first().getByRole("button", { name: "Reject" }).click();
      const sheet = page.getByRole("dialog", { name: "Reject QR order" });
      await sheet.getByRole("button", { name: "Sold out", exact: true }).click();
      const button = sheet.getByRole("button", { name: "Reject as sold out" });
      await button.click();
      await expect(page.getByText("Not sent", { exact: true })).toBeVisible();
      await expect(page.getByText("The QR order is still waiting. Try again.")).toBeVisible();
      await expect(button).toBeEnabled();
      await bothThemes(page, "U1-not-sent");
      expect(await roundStatus(roundId)).toBe("pending");
      expect(await soldOutNow()).not.toContain(ids["Otah"]!);
      drop = false;
      await button.click();
      await expect(sheet).toHaveCount(0);
      expect(await roundStatus(roundId)).toBe("rejected");
      expect(await soldOutNow()).toContain(ids["Otah"]!);
    } finally {
      await register("POST", "/v1/stock/restore", { outlet_id: devLocal().outletId, product_id: ids["Otah"]! }).catch(() => undefined);
      await settle(order.id);
    }
  });

  test("a reject the register does but never answers, even when asked again, is abandoned in bounded time; the POS re-reads, sees it done and closes the sheet", async ({ page, watch }) => {
    test.setTimeout(300_000);
    // The dropped answers on purpose.
    watch.allowConsole(/ERR_CONNECTION_RESET/);
    const ids = await products();
    const { order, table, token } = await seatedTable();
    const { roundId } = await guestRound(token, "review4-u1-c", [{ product_id: ids["Otah"]!, quantity: 1 }]);
    try {
      await pairAndSignIn(page, MANAGER_PIN);
      let calls = 0;
      await page.route("**/v1/rounds/*/reject", async (route: Route) => {
        calls++;
        // The register does it; neither answer ever arrives (the route is never fulfilled).
        if (calls === 1) await route.fetch();
      });
      const sheet = await soldOutSheet(page, table.name);
      const started = Date.now();
      await sheet.getByRole("button", { name: "Reject as sold out" }).click();
      await expect(sheet).toHaveCount(0, { timeout: 40_000 });
      expect(Date.now() - started).toBeLessThan(35_000);
      expect(calls).toBe(2);
      expect(await roundStatus(roundId)).toBe("rejected");
      expect(await soldOutNow()).toContain(ids["Otah"]!);
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await register("POST", "/v1/stock/restore", { outlet_id: devLocal().outletId, product_id: ids["Otah"]! }).catch(() => undefined);
      await settle(order.id);
    }
  });
});

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

test.describe("U2: the paid screen stays for every tender", () => {
  const tenders = [
    {
      name: "cash",
      pay: async (page: Page) => {
        await page.getByRole("group", { name: "Payment method" }).getByRole("button", { name: "Cash", exact: true }).click();
        await page.getByRole("button", { name: /^Take \$[\d.]+ cash$/ }).click();
      },
    },
    {
      name: "card",
      pay: async (page: Page) => {
        await page.getByRole("group", { name: "Payment method" }).getByRole("button", { name: "Card", exact: true }).click();
        await page.getByRole("button", { name: /^Take \$[\d.]+ by Card$/ }).click();
      },
    },
    {
      name: "terminal",
      pay: async (page: Page) => {
        const methods = page.getByRole("group", { name: "Payment method" });
        await methods.getByRole("button", { name: /^More payment methods/ }).click();
        await methods.getByRole("button", { name: "Card (terminal)", exact: true }).click();
        await page.getByRole("button", { name: /^Send \$[\d.]+ to the terminal/ }).click();
      },
    },
  ];
  for (const t of tenders) {
    test(`${t.name}: the last bill's paid screen waits 10 s for the cashier, with its receipt, void and invoice`, async ({ page }) => {
      test.setTimeout(300_000);
      const { outletId, stationId } = devLocal();
      const shift = t.name === "cash" ? await register<{ data: { id: string } }>("POST", "/v1/shifts", { outlet_id: outletId, station_id: stationId, float_cents: 10_000 }) : null;
      await pairAndSignIn(page, MANAGER_PIN);
      const orderId = await sentToPay(page);
      try {
        await t.pay(page);
        await expect(page.getByText(/^Paid · Bill 1 · /)).toBeVisible({ timeout: 30_000 });
        await page.waitForTimeout(10_000);
        await expect(page.getByText(/^Paid · Bill 1 · /)).toBeVisible();
        await expect(page.getByText("Every bill is paid. The order is done.")).toBeVisible();
        for (const name of ["Void payment", "Get invoice"]) await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: /No receipt|Done/ }).first()).toBeVisible();
        if (t.name === "terminal") await bothThemes(page, "U2-paid-terminal");
      } finally {
        await settle(orderId);
        if (shift) await register("POST", `/v1/shifts/${shift.data.id}/close`, { counted_cash_cents: 10_000, variance_reason: "End of an end-to-end test" }).catch(() => undefined);
      }
    });
  }
});
