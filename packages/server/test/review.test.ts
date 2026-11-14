import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localParts, SEED_RULE_IDS } from "@sail/shared";
import "../src/modules.js";
import { buildApp, type App } from "../src/app.js";
import { withTransaction } from "../src/db/client.js";
import { seedRulesForMerchant } from "../src/services/pricing-rules.js";
import { AdmissionGate } from "../src/lib/gate.js";
import { api, freshDb, seedMerchant, type SeededMerchant, type TestDb, sgSeedRules } from "./helpers.js";

/**
 * Beta v1 review: regression tests for the defects found in the end-to-end
 * audit. Each test names the defect it
 * guards against.
 */
let db: TestDb;
let app: App;
let A: SeededMerchant;
let call: ReturnType<typeof api>["call"];
let stationToken: string;
let serverPin: string;
let cashierPin: string;
let managerPin: string;
const ids = { laksa: randomUUID(), kopi: randomUUID(), menu: randomUUID(), link: randomUUID(), area: randomUUID(), station: randomUUID(), cash: randomUUID(), card: randomUUID(), printer: randomUUID(), vipGroup: randomUUID(), customer: randomUUID() };

type Check = { id: string; label: string; totals: { total: number; discount_total: number }; paid_total: number; rounding_total: number; balance: number; locked: boolean; allocations: { line_id: string; total: number }[] };
type Snap = { id: string; version: number; status: string; totals: { total: number; discount_total: number; fee_total: number }; lines: { id: string; name: string; quantity: number; amounts: { total: number; discount: number } }[]; adjustments: { rule_key: string; total: number; lines: { line_id: string; amount: number }[]; manual_application_id: string | null }[]; checks: Check[]; balance: number };
type Body = { data: Snap; payment?: { change_due: number; amount: number }; events: { type: string; seq: number }[]; warnings: string[]; code?: string; message?: string; remedy?: string; details?: Record<string, unknown> };

const open = (token: string, body: Record<string, unknown>) => call<Body>("POST", "/v1/orders", { token, body: { order_id: randomUUID(), ...body } });
const addLines = (token: string, orderId: string, lines: Record<string, unknown>[]) => call<Body>("POST", `/v1/orders/${orderId}/lines`, { token, body: { lines } });
const pay = (token: string, checkId: string, body: Record<string, unknown>) => call<Body>("POST", `/v1/checks/${checkId}/payments`, { token, body: { payment_id: randomUUID(), ...body } });
const snapshot = async (orderId: string) => (await call<{ data: Snap }>("GET", `/v1/orders/${orderId}`, { token: cashierPin })).body.data;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tableId(name: string) {
  const [t] = await db.sql`select id from tables where outlet_id = ${A.outletId} and name = ${name}`;
  return t!.id as string;
}
async function pairStation(stationId: string) {
  const code = await call<{ data: { code: string } }>("POST", `/v1/stations/${stationId}/pairing-code`, { token: A.admin.token, body: {} });
  return (await call<{ data: { station_token: string } }>("POST", "/v1/stations/pair", { body: { code: code.body.data.code, device_label: "iPad" }, idempotencyKey: null })).body.data.station_token;
}
const signIn = async (token: string, pin: string) => call<{ data: { session_token: string } }>("POST", "/v1/stations/sessions", { token, body: { pin } });

beforeAll(async () => {
  db = await freshDb();
  app = buildApp();
  call = api(app).call;
  A = await seedMerchant(db.sql, "Review");
  await withTransaction(() => seedRulesForMerchant(A.merchantId, sgSeedRules(A)));
  const t = A.admin.token;
  await call("PATCH", "/v1/merchant/settings", { token: t, body: { cash_rounding_increment: 5 } });
  await call("POST", "/v1/products", { token: t, body: { id: ids.laksa, name: "Laksa", price: 1600, tags: ["kitchen", "food"] } });
  await call("POST", "/v1/products", { token: t, body: { id: ids.kopi, name: "Kopi", price: 180, tags: ["bar"] } });
  await call("POST", "/v1/menus", { token: t, body: { id: ids.menu, brand_id: A.brandId, name: "M", sections: [{ name: "All", items: [{ product_id: ids.laksa }, { product_id: ids.kopi }] }] } });
  await call("POST", "/v1/channel-links", { token: t, body: { id: ids.link, channel: "pos", outlet_id: A.outletId, brand_id: A.brandId, menu_id: ids.menu } });
  await call("POST", "/v1/areas", { token: t, body: { id: ids.area, outlet_id: A.outletId, name: "Main" } });
  for (let i = 1; i <= 8; i++) await call("POST", "/v1/tables", { token: t, body: { outlet_id: A.outletId, area_id: ids.area, name: String(i) } });
  await call("POST", "/v1/tender-types", { token: t, body: { id: ids.cash, name: "Cash", is_cash: true } });
  // Cash goes into a shift's drawer: one outlet-wide shift for the file.
  expect((await call("POST", "/v1/shifts", { token: t, body: { outlet_id: A.outletId, station_id: null, float_cents: 0 } })).status).toBe(201);
  await call("POST", "/v1/tender-types", { token: t, body: { id: ids.card, name: "Card", is_terminal: true } });
  await call("POST", "/v1/printers", { token: t, body: { id: ids.printer, outlet_id: A.outletId, name: "Receipt", ip: "10.0.0.9", role: "receipt" } });
  await call("POST", "/v1/stations", { token: t, body: { id: ids.station, outlet_id: A.outletId, brand_id: A.brandId, name: "Floor", receipt_printer_id: ids.printer } });
  await call("POST", "/v1/customer-groups", { token: A.manager.token, body: { id: ids.vipGroup, name: "VIP" } });
  await call("PUT", "/v1/customers", { token: A.manager.token, body: { id: ids.customer, name: "Lim", mobile: "+6500004567", group_ids: [ids.vipGroup] } });
  stationToken = await pairStation(ids.station);
  serverPin = (await signIn(stationToken, "444444")).body.data.session_token;
  cashierPin = (await signIn(stationToken, "333333")).body.data.session_token;
  managerPin = (await signIn(stationToken, "222222")).body.data.session_token;
});
afterAll(async () => {
  await db.drop();
});

describe("business date (daily caps and sold out follow the outlet's cutoff, not the calendar)", () => {
  it("a cap consumed before the cutoff is still shown as used by the stock list and the compiled menu", async () => {
    // Put the cutoff ten minutes ahead of the wall clock in Singapore: the business date is then yesterday while the calendar
    // says today. (Two minutes, truncated to the minute, left as little as 61 s for a slow run to cross it.)
    const now = new Date();
    const ahead = localParts(new Date(now.getTime() + 10 * 60_000), "Asia/Singapore");
    const sameDay = ahead.date === localParts(now, "Asia/Singapore").date;
    if (sameDay) expect((await call("PATCH", `/v1/outlets/${A.outletId}`, { token: A.admin.token, body: { business_day_cutoff: ahead.time } })).status).toBe(200);
    try {
      await call("POST", "/v1/stock/daily-cap", { token: A.manager.token, body: { outlet_id: A.outletId, product_id: ids.kopi, quantity: 2 } });
      const o = await open(cashierPin, { order_type: "takeaway" });
      const added = await addLines(cashierPin, o.body.data.id, [{ line_id: randomUUID(), product_id: ids.kopi, quantity: 2 }]);
      expect(added.status, JSON.stringify(added.body)).toBe(200);
      const stock = await call<{ data: { product_id: string; cap_remaining: number }[] }>("GET", `/v1/outlets/${A.outletId}/stock`, { token: cashierPin });
      expect(stock.body.data.find((s) => s.product_id === ids.kopi)!.cap_remaining).toBe(0);
      const menu = await call<{ data: { products: Record<string, { cap_remaining: number | null; sold_out: boolean; available_now: boolean }> } }>("GET", `/v1/channel-links/${ids.link}/menu`, { token: cashierPin });
      expect(menu.body.data.products[ids.kopi]).toMatchObject({ cap_remaining: 0, sold_out: true, available_now: false });
      const more = await addLines(cashierPin, o.body.data.id, [{ line_id: randomUUID(), product_id: ids.kopi, quantity: 1 }]);
      expect(more.status).toBe(422);
      expect(more.body.code).toBe("unavailable");
      await call("POST", `/v1/orders/${o.body.data.id}/cancel`, { token: cashierPin, body: { reason: "test" } });
    } finally {
      await call("POST", "/v1/stock/daily-cap", { token: A.manager.token, body: { outlet_id: A.outletId, product_id: ids.kopi, quantity: null } });
      await call("PATCH", `/v1/outlets/${A.outletId}`, { token: A.admin.token, body: { business_day_cutoff: null } });
    }
  });
});

describe("payments and the paid bill", () => {
  it("a payment is validated against the bill as re-priced at the first payment, not a stale balance", async () => {
    // A scheduled 20% discount switches on between the last edit and the payment.
    const key = `promo:late-${randomUUID().slice(0, 8)}`;
    const from = new Date(Date.now() + 1200);
    await call("POST", "/v1/pricing-rules", { token: A.admin.token, body: { rule_key: key, body: { kind: "discount", name: "Late 20%", calc: "percent", value: { type: "fixed", amount: 2000 }, scope: { type: "all" }, conditions: { order_types: ["takeaway"] }, priority: 5, application: "auto", report_class: "promo" }, effective_from: from.toISOString() } });
    const o = await open(cashierPin, { order_type: "takeaway" });
    const added = await addLines(cashierPin, o.body.data.id, [{ line_id: randomUUID(), product_id: ids.laksa, quantity: 1 }]);
    const before = added.body.data.totals.total;
    const checkId = added.body.data.checks[0]!.id;
    await call("POST", `/v1/orders/${o.body.data.id}/fire`, { token: cashierPin, body: {} });
    await sleep(1400);
    // Card for the old total: refused with the new balance in the error, never an invariant failure.
    const card = await pay(cashierPin, checkId, { tender_type_id: ids.card, amount: before });
    expect(card.status, JSON.stringify(card.body)).toBe(400);
    expect(card.body.code).toBe("validation");
    expect(card.body.details!.balance).toBeLessThan(before);
    // Cash for the old total: the register applies the new balance and returns the difference as change.
    const cash = await pay(cashierPin, checkId, { tender_type_id: ids.cash, amount: before });
    expect(cash.status, JSON.stringify(cash.body)).toBe(200);
    const bill = cash.body.data.checks[0]!;
    expect(bill.balance).toBe(0);
    expect(cash.body.payment!.amount).toBe(bill.totals.total);
    expect(cash.body.payment!.change_due).toBe(before - bill.totals.total - bill.rounding_total);
    expect(cash.body.data.totals.discount_total).toBeLessThan(0);
  });

  it("an order with a refund cannot be reopened", async () => {
    const o = await open(cashierPin, { order_type: "takeaway" });
    const added = await addLines(cashierPin, o.body.data.id, [{ line_id: randomUUID(), product_id: ids.laksa, quantity: 1 }]);
    const check = added.body.data.checks[0]!;
    await call("POST", `/v1/orders/${o.body.data.id}/fire`, { token: cashierPin, body: {} });
    await pay(cashierPin, check.id, { tender_type_id: ids.card, amount: check.totals.total });
    const refund = await call<Body>("POST", `/v1/checks/${check.id}/refunds`, { token: managerPin, body: { refund_id: randomUUID(), request: { kind: "amount", amount: 100 }, reason: "Goodwill", print: false } });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    const reopen = await call<Body>("POST", `/v1/orders/${o.body.data.id}/reopen`, { token: managerPin, body: { reason: "Wrong tender" } });
    expect(reopen.status).toBe(422);
    expect(reopen.body.details).toMatchObject({ invariant: "order_has_refunds" });
  });

  it("a paid bill never changes: edits, item discounts and removals on its lines are refused with the bill named; new lines, customers and rules price the unpaid lines only", async () => {
    const o = await open(cashierPin, { order_type: "dine_in", table_id: await tableId("1"), pax: 2 });
    const laksaLine = randomUUID();
    const kopiLine = randomUUID();
    await addLines(cashierPin, o.body.data.id, [{ line_id: laksaLine, product_id: ids.laksa, quantity: 1 }, { line_id: kopiLine, product_id: ids.kopi, quantity: 1 }]);
    // A staff-meal discount applied before the payment touches both lines.
    const staffMeal = randomUUID();
    const sm = await call<Body>("POST", `/v1/orders/${o.body.data.id}/adjustments`, { token: cashierPin, body: { application_id: staffMeal, rule_key: SEED_RULE_IDS.staffMeal, reason: "Staff lunch" } });
    expect(sm.status, JSON.stringify(sm.body)).toBe(200);
    const split = await call<Body>("POST", `/v1/orders/${o.body.data.id}/checks/split-even`, { token: cashierPin, body: { n: 2 } });
    const [b1, b2] = split.body.data.checks.map((c) => c.id) as [string, string];
    const moved = await call<Body>("POST", `/v1/orders/${o.body.data.id}/checks/allocate`, { token: cashierPin, body: { moves: [{ line_id: laksaLine, check_ids: [b1] }, { line_id: kopiLine, check_ids: [b2] }] } });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    // Pay Bill 1 before sending (a counter station pays first), so its line is paid while still pending.
    const bill1 = moved.body.data.checks.find((c) => c.id === b1)!;
    const paid = await pay(cashierPin, b1, { tender_type_id: ids.card, amount: bill1.totals.total });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const laksaAmountsAtPayment = paid.body.data.lines.find((l) => l.id === laksaLine)!.amounts;

    // 1. Quantity on the paid (still unsent) line: refused, naming the bill; notes may still change.
    const qty = await call<Body>("PATCH", `/v1/orders/${o.body.data.id}/lines/${laksaLine}`, { token: cashierPin, body: { quantity: 2 } });
    expect(qty.status, JSON.stringify(qty.body)).toBe(422);
    expect(qty.body.details).toMatchObject({ invariant: "check_locked_by_payment" });
    expect((await call<Body>("PATCH", `/v1/orders/${o.body.data.id}/lines/${laksaLine}`, { token: cashierPin, body: { notes: "less spicy" } })).status).toBe(200);
    await call("POST", `/v1/orders/${o.body.data.id}/fire`, { token: cashierPin, body: {} });
    // 2. An item discount aimed at the paid line: refused with check_locked_by_payment.
    const pctItem = await call<Body>("POST", `/v1/orders/${o.body.data.id}/adjustments`, { token: cashierPin, body: { application_id: randomUUID(), rule_key: SEED_RULE_IDS.percentOffItem, entered_value: 1000, line_ids: [laksaLine] } });
    expect(pctItem.status, JSON.stringify(pctItem.body)).toBe(422);
    expect(pctItem.body.details).toMatchObject({ invariant: "check_locked_by_payment" });
    expect(pctItem.body.message).toMatch(/Bill 1 is paid/);
    // 3. Removing the staff meal, which has an amount on the paid line: refused.
    const remove = await call<Body>("DELETE", `/v1/orders/${o.body.data.id}/adjustments/${staffMeal}`, { token: cashierPin, body: {} });
    expect(remove.status).toBe(422);
    expect(remove.body.details).toMatchObject({ invariant: "check_locked_by_payment" });
    // 4. A VIP customer with a 15% automatic discount on everything: the paid line keeps its amounts, the unpaid kopi is discounted.
    await call("POST", "/v1/pricing-rules", { token: A.admin.token, body: { rule_key: "promo:vip15", body: { kind: "discount", name: "VIP 15%", calc: "percent", value: { type: "fixed", amount: 1500 }, scope: { type: "all" }, conditions: { customer_group_ids: [ids.vipGroup] }, priority: 30, application: "auto", report_class: "promo" }, effective_from: "2026-01-01T00:00:00Z" } });
    const attached = await call<Body>("POST", `/v1/orders/${o.body.data.id}/customer`, { token: cashierPin, body: { customer_id: ids.customer } });
    expect(attached.status, JSON.stringify(attached.body)).toBe(200);
    const vip = attached.body.data.adjustments.find((a) => a.rule_key === "promo:vip15")!;
    expect(vip.lines.map((l) => l.line_id)).toEqual([kopiLine]);
    expect(attached.body.data.lines.find((l) => l.id === laksaLine)!.amounts).toEqual(laksaAmountsAtPayment);
    expect(attached.body.data.checks.find((c) => c.id === b1)!.totals.total).toBe(bill1.totals.total);
    // 5. A new line lands on the unpaid bill; the paid bill is still unchanged and the bills still add up.
    const more = await addLines(cashierPin, o.body.data.id, [{ line_id: randomUUID(), product_id: ids.kopi, quantity: 1 }]);
    expect(more.status, JSON.stringify(more.body)).toBe(200);
    expect(more.body.data.checks.find((c) => c.id === b1)!.totals.total).toBe(bill1.totals.total);
    expect(more.body.data.checks.reduce((s, c) => s + c.totals.total, 0)).toBe(more.body.data.totals.total);
    const [row] = await db.sql`select total from order_lines where id = ${laksaLine}`;
    expect(row!.total).toBe(laksaAmountsAtPayment.total);
    await call("POST", "/v1/pricing-rules/promo%3Avip15/archive", { token: A.admin.token, body: {} });
  });

  it("a capped rule prices the unpaid lines with the cap that is left after the paid bill", async () => {
    await call("POST", "/v1/pricing-rules", { token: A.admin.token, body: { rule_key: "promo:half-capped", body: { kind: "discount", name: "50% off up to $5", calc: "percent", value: { type: "fixed", amount: 5000 }, scope: { type: "all" }, cap: 500, conditions: { order_types: ["takeaway"] }, priority: 40, application: "auto", report_class: "promo" }, effective_from: "2026-01-01T00:00:00Z" } });
    try {
      const o = await open(cashierPin, { order_type: "takeaway" });
      const laksaLine = randomUUID();
      const kopiLine = randomUUID();
      const added = await addLines(cashierPin, o.body.data.id, [{ line_id: laksaLine, product_id: ids.laksa, quantity: 1 }, { line_id: kopiLine, product_id: ids.kopi, quantity: 1 }]);
      const capped = added.body.data.adjustments.find((a) => a.rule_key === "promo:half-capped")!;
      expect(capped.total).toBe(-500);
      const split = await call<Body>("POST", `/v1/orders/${o.body.data.id}/checks/split-even`, { token: cashierPin, body: { n: 2 } });
      const [b1, b2] = split.body.data.checks.map((c) => c.id) as [string, string];
      const moved = await call<Body>("POST", `/v1/orders/${o.body.data.id}/checks/allocate`, { token: cashierPin, body: { moves: [{ line_id: laksaLine, check_ids: [b1] }, { line_id: kopiLine, check_ids: [b2] }] } });
      await call("POST", `/v1/orders/${o.body.data.id}/fire`, { token: cashierPin, body: {} });
      const bill1 = moved.body.data.checks.find((c) => c.id === b1)!;
      await pay(cashierPin, b1, { tender_type_id: ids.card, amount: bill1.totals.total });
      const more = await addLines(cashierPin, o.body.data.id, [{ line_id: randomUUID(), product_id: ids.kopi, quantity: 1 }]);
      expect(more.status, JSON.stringify(more.body)).toBe(200);
      const after = more.body.data.adjustments.find((a) => a.rule_key === "promo:half-capped")!;
      expect(after.total).toBe(-500); // the cap is for the whole order
      expect(after.lines.find((l) => l.line_id === laksaLine)!.amount).toBe(capped.lines.find((l) => l.line_id === laksaLine)!.amount);
      expect(more.body.data.checks.find((c) => c.id === b1)!.totals.total).toBe(bill1.totals.total);
      expect(more.body.data.checks.reduce((s, c) => s + c.totals.total, 0)).toBe(more.body.data.totals.total);
      void b2;
    } finally {
      await call("POST", "/v1/pricing-rules/promo%3Ahalf-capped/archive", { token: A.admin.token, body: {} });
    }
  });

  it("adding an empty bill keeps it, so items can be moved onto it", async () => {
    const o = await open(cashierPin, { order_type: "dine_in", table_id: await tableId("2"), pax: 2 });
    const laksaLine = randomUUID();
    const added = await addLines(cashierPin, o.body.data.id, [{ line_id: laksaLine, product_id: ids.laksa, quantity: 1 }, { line_id: randomUUID(), product_id: ids.kopi, quantity: 1 }]);
    const withEmpty = await call<Body>("POST", `/v1/orders/${o.body.data.id}/checks/allocate`, { token: cashierPin, body: { moves: [], add_checks: 1 } });
    expect(withEmpty.status, JSON.stringify(withEmpty.body)).toBe(200);
    expect(withEmpty.body.data.checks.map((c) => [c.label, c.totals.total])).toEqual([["Bill 1", added.body.data.totals.total], ["Bill 2", 0]]);
    const b2 = withEmpty.body.data.checks[1]!.id;
    const moved = await call<Body>("POST", `/v1/orders/${o.body.data.id}/checks/allocate`, { token: cashierPin, body: { moves: [{ line_id: laksaLine, check_ids: [b2] }] } });
    expect(moved.body.data.checks.reduce((s, c) => s + c.totals.total, 0)).toBe(added.body.data.totals.total);
    expect(moved.body.data.checks[1]!.allocations.map((a) => a.line_id)).toEqual([laksaLine]);
    await call("POST", `/v1/orders/${o.body.data.id}/cancel`, { token: cashierPin, body: { reason: "test" } });
  });

  it("a quote is a read: it does not wait on a station that holds the order's row lock", async () => {
    const o = await open(cashierPin, { order_type: "takeaway" });
    await addLines(cashierPin, o.body.data.id, [{ line_id: randomUUID(), product_id: ids.kopi, quantity: 1 }]);
    await db.sql.begin(async (sql) => {
      await sql`select id from orders where id = ${o.body.data.id} for update`;
      const res = await Promise.race([call<{ data: { pricing: { totals: { total: number } } } }>("POST", `/v1/orders/${o.body.data.id}/quote`, { token: cashierPin, body: {} }), sleep(2500).then(() => "timeout" as const)]);
      expect(res).not.toBe("timeout");
      if (res !== "timeout") {
        expect(res.status).toBe(200);
        expect(res.body.data.pricing.totals.total).toBeGreaterThan(0);
      }
    });
  });
});

describe("tokens and settings", () => {
  it("pairing a station again invalidates the previous station token", async () => {
    const old = stationToken;
    expect((await signIn(old, "444444")).status).toBe(201);
    const fresh = await pairStation(ids.station);
    expect((await signIn(old, "444444")).status).toBe(401);
    expect((await signIn(fresh, "444444")).status).toBe(201);
    stationToken = fresh;
    // PIN sessions signed in on the old device end with its pairing: a lost or replaced iPad keeps no access.
    expect((await call("GET", "/v1/me", { token: cashierPin })).status).toBe(401);
    cashierPin = (await signIn(fresh, "333333")).body.data.session_token;
    expect((await call("GET", "/v1/me", { token: cashierPin })).status).toBe(200);
  });

  it("merchant settings refuse an unknown time zone, a malformed cutoff and an odd rounding increment", async () => {
    const t = A.admin.token;
    expect((await call("PATCH", "/v1/merchant/settings", { token: t, body: { timezone: "Mars/Olympus" } })).status).toBe(400);
    expect((await call("PATCH", "/v1/merchant/settings", { token: t, body: { business_day_cutoff: "25:00" } })).status).toBe(400);
    expect((await call("PATCH", "/v1/merchant/settings", { token: t, body: { cash_rounding_increment: 3 } })).status).toBe(400);
    expect((await call("PATCH", "/v1/merchant/settings", { token: t, body: { currency: "EUR" } })).status).toBe(400);
    expect((await call("PATCH", "/v1/merchant/settings", { token: t, body: { locale: "not a locale" } })).status).toBe(400);
    expect((await call("PATCH", "/v1/merchant/settings", { token: t, body: { cash_rounding_increment: 3 } })).status).toBe(400);
    expect((await call("PATCH", "/v1/merchant/settings", { token: t, body: { cash_denominations: [5, 10] } })).status).toBe(400);
    expect((await call("PATCH", "/v1/merchant/settings", { token: t, body: { timezone: "Asia/Singapore", business_day_cutoff: "04:00", cash_rounding_increment: 5 } })).status).toBe(200);
  });

  it("a queued request gives up with 503 instead of waiting forever", async () => {
    const gate = new AdmissionGate(1, 2, 50);
    const r1 = await gate.acquire();
    await expect(gate.acquire()).rejects.toMatchObject({ code: "overloaded", status: 503 });
    expect(gate.timedOut).toBe(1);
    expect(gate.waiting).toBe(0);
    r1();
    r1(); // a double release never frees a second slot
    const r2 = await gate.acquire();
    expect(gate.inFlight).toBe(1);
    r2();
  });
});

describe("nested requests and the admission gate", () => {
  let tight: TestDb;
  let tightApp: App;
  let tcall: ReturnType<typeof api>["call"];
  let B: SeededMerchant;
  const bid = { laksa: randomUUID(), menu: randomUUID(), link: randomUUID(), station: randomUUID(), printer: randomUUID() };
  let bServerPin: string;
  let bAgentToken: string;

  beforeAll(async () => {
    tight = await freshDb({ TX_MAX: "1", QUEUE_MAX: "4", QUEUE_WAIT_MS: "3000" });
    tightApp = buildApp();
    tcall = api(tightApp).call;
    B = await seedMerchant(tight.sql, "Tight");
    await withTransaction(() => seedRulesForMerchant(B.merchantId, sgSeedRules(B)));
    const t = B.admin.token;
    await tcall("POST", "/v1/products", { token: t, body: { id: bid.laksa, name: "Laksa", price: 1600, tags: ["kitchen"] } });
    await tcall("POST", "/v1/menus", { token: t, body: { id: bid.menu, brand_id: B.brandId, name: "M", sections: [{ name: "All", items: [{ product_id: bid.laksa }] }] } });
    await tcall("POST", "/v1/channel-links", { token: t, body: { id: bid.link, channel: "pos", outlet_id: B.outletId, brand_id: B.brandId, menu_id: bid.menu } });
    await tcall("POST", "/v1/printers", { token: t, body: { id: bid.printer, outlet_id: B.outletId, name: "Kitchen", ip: "10.0.0.1", is_default_kitchen: true } });
    await tcall("POST", "/v1/stations", { token: t, body: { id: bid.station, outlet_id: B.outletId, brand_id: B.brandId, name: "Floor" } });
    const code = await tcall<{ data: { code: string } }>("POST", `/v1/stations/${bid.station}/pairing-code`, { token: t, body: {} });
    const paired = await tcall<{ data: { station_token: string } }>("POST", "/v1/stations/pair", { body: { code: code.body.data.code, device_label: "iPad" }, idempotencyKey: null });
    bServerPin = (await tcall<{ data: { session_token: string } }>("POST", "/v1/stations/sessions", { token: paired.body.data.station_token, body: { pin: "444444" } })).body.data.session_token;
    const identity = await tcall<{ data: { credential: string } }>("POST", "/v1/agent-identities", { token: t, body: { name: "Cashier assistant", role: "cashier", toolsets: ["pos.read", "pos.order"], risk_ceiling: "T1" } });
    bAgentToken = (await tcall<{ data: { agent_token: string } }>("POST", "/v1/agent-sessions", { body: { credential: identity.body.data.credential, task_id: "t" }, idempotencyKey: null })).body.data.agent_token;
  });
  afterAll(async () => {
    await tight.drop();
  });

  it("approving a proposal with TX_MAX=1 executes the frozen request instead of deadlocking on the gate", async () => {
    const opened = await tcall<{ data: Snap }>("POST", "/v1/orders", { token: bAgentToken, body: { order_id: randomUUID(), order_type: "takeaway", outlet_id: B.outletId, brand_id: B.brandId } });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    await tcall("POST", `/v1/orders/${opened.body.data.id}/lines`, { token: bAgentToken, body: { lines: [{ line_id: randomUUID(), product_id: bid.laksa, quantity: 1 }] } });
    const fire = await tcall<{ data: { id: string } }>("POST", `/v1/orders/${opened.body.data.id}/fire`, { token: bAgentToken, body: {} });
    expect(fire.status).toBe(202);
    const approved = await tcall<{ data: { status: string; result: { status: number } } }>("POST", `/v1/proposals/${fire.body.data.id}/approve`, { token: bServerPin, body: {} });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data.status).toBe("approved");
    expect(approved.body.data.result.status).toBe(200);
    expect((await tcall<{ data: Snap }>("GET", `/v1/orders/${opened.body.data.id}`, { token: bServerPin })).body.data.status).toBe("fired");
  }, 20_000);
});
