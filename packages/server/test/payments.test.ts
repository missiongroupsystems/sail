import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SEED_RULE_IDS } from "@sail/shared";
import "../src/modules.js";
import { buildApp, type App } from "../src/app.js";
import { withTransaction } from "../src/db/client.js";
import { seedRulesForMerchant } from "../src/services/pricing-rules.js";
import { api, freshDb, seedMerchant, type SeededMerchant, type TestDb, sgSeedRules } from "./helpers.js";

let db: TestDb;
let app: App;
let A: SeededMerchant;
let call: ReturnType<typeof api>["call"];
let serverPin: string;
let cashierPin: string;
let managerPin: string;
let counterCashierPin: string;
const ids = { laksa: randomUUID(), kopi: randomUUID(), menu: randomUUID(), link: randomUUID(), area: randomUUID(), table: randomUUID(), table2: randomUUID(), station: randomUUID(), counter: randomUUID(), cash: randomUUID(), card: randomUUID(), receiptPrinter: randomUUID() };

type Check = { id: string; label: string; status: string; totals: { total: number; subtotal: number }; paid_total: number; rounding_total: number; balance: number; locked: boolean; invoice_no: string | null; payments: { id: string; amount: number; rounding_cents: number; change_cents: number; tender: string }[]; allocations: { line_id: string; total: number }[] };
type Snap = { id: string; version: number; status: string; pricing_status: string; totals: { total: number; fee_total: number; discount_total: number }; lines: { id: string; status: string; amounts: { total: number } }[]; adjustments: { rule_key: string; total: number; frozen: boolean }[]; checks: Check[]; paid_total: number; balance: number };
type Mut = { status: number; body: { data: Snap; payment?: { change_due: number; amount: number; rounding_cents: number }; events: { type: string }[]; warnings: string[]; code?: string; message?: string; details?: Record<string, unknown> } };

const open = (token: string, body: Record<string, unknown>) => call<Mut["body"]>("POST", "/v1/orders", { token, body: { order_id: randomUUID(), ...body } });
const addLines = (token: string, orderId: string, lines: Record<string, unknown>[]) => call<Mut["body"]>("POST", `/v1/orders/${orderId}/lines`, { token, body: { lines } });
const pay = (token: string, checkId: string, body: Record<string, unknown>, key?: string) => call<Mut["body"]>("POST", `/v1/checks/${checkId}/payments`, { token, body: { payment_id: randomUUID(), ...body }, idempotencyKey: key });

beforeAll(async () => {
  db = await freshDb();
  app = buildApp();
  call = api(app).call;
  A = await seedMerchant(db.sql, "Alpha");
  await withTransaction(() => seedRulesForMerchant(A.merchantId, sgSeedRules(A)));
  const t = A.admin.token;
  await call("PATCH", "/v1/merchant/settings", { token: t, body: { cash_rounding_increment: 5 } });
  await call("POST", "/v1/products", { token: t, body: { id: ids.laksa, name: "Laksa", price: 1600, tags: ["kitchen"] } });
  await call("POST", "/v1/products", { token: t, body: { id: ids.kopi, name: "Kopi", price: 180, tags: ["bar"] } });
  await call("POST", "/v1/menus", { token: t, body: { id: ids.menu, brand_id: A.brandId, name: "M", sections: [{ name: "All", items: [{ product_id: ids.laksa }, { product_id: ids.kopi }] }] } });
  await call("POST", "/v1/channel-links", { token: t, body: { id: ids.link, channel: "pos", outlet_id: A.outletId, brand_id: A.brandId, menu_id: ids.menu } });
  await call("POST", "/v1/areas", { token: t, body: { id: ids.area, outlet_id: A.outletId, name: "Main" } });
  await call("POST", "/v1/tables", { token: t, body: { id: ids.table, outlet_id: A.outletId, area_id: ids.area, name: "1" } });
  await call("POST", "/v1/tables", { token: t, body: { id: ids.table2, outlet_id: A.outletId, area_id: ids.area, name: "2" } });
  await call("POST", "/v1/tender-types", { token: t, body: { id: ids.cash, name: "Cash", is_cash: true } });
  await call("POST", "/v1/tender-types", { token: t, body: { id: ids.card, name: "Card", is_terminal: true } });
  await call("POST", "/v1/printers", { token: t, body: { id: ids.receiptPrinter, outlet_id: A.outletId, name: "Receipt", ip: "10.0.0.9", role: "receipt" } });
  await call("POST", "/v1/stations", { token: t, body: { id: ids.station, outlet_id: A.outletId, brand_id: A.brandId, name: "Floor", receipt_printer_id: ids.receiptPrinter } });
  await call("POST", "/v1/stations", { token: t, body: { id: ids.counter, outlet_id: A.outletId, brand_id: A.brandId, name: "Counter", pay_before_firing: true, home: "takeaway" } });
  const pair = async (stationId: string) => {
    const code = await call<{ data: { code: string } }>("POST", `/v1/stations/${stationId}/pairing-code`, { token: t, body: {} });
    return (await call<{ data: { station_token: string } }>("POST", "/v1/stations/pair", { body: { code: code.body.data.code, device_label: "iPad" }, idempotencyKey: null })).body.data.station_token;
  };
  const floorToken = await pair(ids.station);
  const counterToken = await pair(ids.counter);
  const signIn = async (stationToken: string, pin: string) => (await call<{ data: { session_token: string } }>("POST", "/v1/stations/sessions", { token: stationToken, body: { pin } })).body.data.session_token;
  serverPin = await signIn(floorToken, "444444");
  cashierPin = await signIn(floorToken, "333333");
  managerPin = await signIn(floorToken, "222222");
  counterCashierPin = await signIn(counterToken, "333333");
});
afterAll(async () => {
  await db.drop();
});

describe("checks and payments", () => {
  it("an order has one bill whose allocations add up to the order; a server cannot take payments", async () => {
    const o = await open(serverPin, { order_type: "dine_in", table_id: ids.table, pax: 2 });
    const added = await addLines(serverPin, o.body.data.id, [{ line_id: randomUUID(), product_id: ids.laksa, quantity: 2 }, { line_id: randomUUID(), product_id: ids.kopi, quantity: 1 }]);
    const s = added.body.data;
    expect(s.checks).toHaveLength(1);
    expect(s.checks[0]!.label).toBe("Bill 1");
    expect(s.checks[0]!.totals.total).toBe(s.totals.total);
    expect(s.checks[0]!.allocations.reduce((a, x) => a + x.total, 0)).toBe(s.totals.total);
    expect(s.balance).toBe(s.totals.total);
    const denied = await pay(serverPin, s.checks[0]!.id, { tender_type_id: ids.card, amount: 100 });
    expect(denied.status).toBe(403);
    expect(denied.body.details).toMatchObject({ required_role: "cashier", override_allowed: true });
    await call("POST", `/v1/orders/${o.body.data.id}/cancel`, { token: serverPin, body: { reason: "test" } });
  });

  it("card part payment, then cash with rounding settles the bill; the first payment freezes order-level pricing and new lines go to a new bill", async () => {
    const o = await open(cashierPin, { order_type: "dine_in", table_id: ids.table, pax: 2 });
    const orderId = o.body.data.id;
    // Laksa 1600 + Kopi 180 = 1780; SC 10% = 178; GST: 144 + 16 + 14 + 2 (16.2→16, 14.4→14, 1.62→2) = 176 → 2134.
    const added = await addLines(cashierPin, orderId, [{ line_id: randomUUID(), product_id: ids.laksa, quantity: 1 }, { line_id: randomUUID(), product_id: ids.kopi, quantity: 1 }]);
    const tenOff = randomUUID();
    const disc = await call<Mut["body"]>("POST", `/v1/orders/${orderId}/adjustments`, { token: managerPin, body: { application_id: tenOff, rule_key: SEED_RULE_IDS.amountOffBill, entered_value: 1000 } });
    expect(disc.status, JSON.stringify(disc.body)).toBe(200);
    expect(disc.body.data.totals.discount_total).toBe(-1000);
    const total = disc.body.data.totals.total;
    expect(total).toBe(disc.body.data.checks[0]!.totals.total);
    await call("POST", `/v1/orders/${orderId}/fire`, { token: cashierPin, body: {} });
    const checkId = disc.body.data.checks[0]!.id;

    const over = await pay(cashierPin, checkId, { tender_type_id: ids.card, amount: total + 1 });
    expect(over.status).toBe(400);
    const card = await pay(cashierPin, checkId, { tender_type_id: ids.card, amount: 500, reference: "Visa 1234" });
    expect(card.status, JSON.stringify(card.body)).toBe(200);
    expect(card.body.payment).toMatchObject({ amount: 500, rounding_cents: 0, change_due: 0 });
    const c1 = card.body.data.checks[0]!;
    expect(c1.paid_total).toBe(500);
    expect(c1.balance).toBe(total - 500);
    expect(c1.locked).toBe(true);
    expect(card.body.data.pricing_status).toBe("frozen");
    expect(card.body.data.adjustments.find((a) => a.rule_key === SEED_RULE_IDS.amountOffBill)!.frozen).toBe(true);
    expect(card.body.events.map((e) => e.type)).toEqual(["payment.recorded"]);

    // Order-level manual rules are frozen now; the type cannot change; a paid line cannot be voided.
    expect((await call<Mut["body"]>("POST", `/v1/orders/${orderId}/adjustments`, { token: managerPin, body: { application_id: randomUUID(), rule_key: SEED_RULE_IDS.percentOffBill, entered_value: 500 } })).status).toBe(422);
    expect((await call("POST", `/v1/orders/${orderId}/change-type`, { token: cashierPin, body: { order_type: "takeaway" } })).status).toBe(422);
    const voidPaid = await call<Mut["body"]>("POST", `/v1/orders/${orderId}/lines/${card.body.data.lines[0]!.id}/void`, { token: managerPin, body: { reason_text: "x" } });
    expect(voidPaid.status).toBe(422);
    expect(voidPaid.body.message).toMatch(/Bill 1 is paid/);

    // A line added after the first payment lands on Bill 2 with line-level rules only (service charge yes, $10 off no).
    const more = await addLines(cashierPin, orderId, [{ line_id: randomUUID(), product_id: ids.kopi, quantity: 1 }]);
    expect(more.status).toBe(200);
    expect(more.body.data.checks.map((c) => c.label)).toEqual(["Bill 1", "Bill 2"]);
    expect(more.body.data.checks[0]!.totals.total).toBe(total); // paid bill unchanged
    const bill2 = more.body.data.checks[1]!;
    expect(bill2.totals.total).toBe(180 + 18 + 16 + 2); // kopi + SC + GST on kopi (16.2→16) + GST on SC (1.62→2)
    expect(more.body.data.adjustments.find((a) => a.rule_key === SEED_RULE_IDS.amountOffBill)!.total).toBe(-1000);

    // Settle Bill 1 in cash: balance rounded to 5 cents, halves up; change from the tendered note.
    const balance = total - 500;
    const expectedRounding = ((Math.floor(balance / 5) + (balance % 5 * 2 >= 5 ? 1 : 0)) * 5) - balance;
    const cash = await pay(cashierPin, checkId, { tender_type_id: ids.cash, amount: balance, tendered: 5000 });
    expect(cash.status, JSON.stringify(cash.body)).toBe(200);
    expect(cash.body.payment!.rounding_cents).toBe(expectedRounding);
    expect(cash.body.payment!.change_due).toBe(5000 - (balance + expectedRounding));
    const paidBill = cash.body.data.checks[0]!;
    expect(paidBill.status).toBe("paid");
    expect(paidBill.balance).toBe(0);
    expect(paidBill.rounding_total).toBe(expectedRounding);
    expect(cash.body.events.map((e) => e.type)).toEqual(["payment.recorded", "check.paid"]);
    expect(cash.body.data.status).not.toBe("completed"); // Bill 2 still open and its kopi unsent

    // Rounding never applies to a card tender, nor to a cash part payment.
    const bill2Card = await pay(cashierPin, bill2.id, { tender_type_id: ids.card, amount: 100 });
    expect(bill2Card.body.payment!.rounding_cents).toBe(0);
    const bill2CashPart = await pay(cashierPin, bill2.id, { tender_type_id: ids.cash, amount: 50 });
    expect(bill2CashPart.body.payment!.rounding_cents).toBe(0);
    // Fire the remaining kopi, settle Bill 2 by cash → the order completes.
    await call("POST", `/v1/orders/${orderId}/fire`, { token: cashierPin, body: {} });
    const rest = bill2.totals.total - 150;
    const finalPay = await pay(cashierPin, bill2.id, { tender_type_id: ids.cash, amount: rest });
    expect(finalPay.status).toBe(200);
    expect(finalPay.body.data.status).toBe("completed");
    expect(finalPay.body.events.map((e) => e.type)).toEqual(["payment.recorded", "check.paid", "order.completed"]);
    const floor = await call<{ data: { tables: { id: string; status: string }[] } }>("GET", `/v1/outlets/${A.outletId}/floor`, { token: cashierPin });
    expect(floor.body.data.tables.find((t) => t.id === ids.table)!.status).toBe("free");
    const [row] = await db.sql`select paid_total, total from checks where id = ${checkId}`;
    expect(row!.paid_total).toBe(row!.total);
  });

  it("a double-tapped tender is recorded once (same idempotency key replays; same payment_id with a new key is refused)", async () => {
    const o = await open(cashierPin, { order_type: "takeaway" });
    const added = await addLines(cashierPin, o.body.data.id, [{ line_id: randomUUID(), product_id: ids.kopi, quantity: 1 }]);
    const checkId = added.body.data.checks[0]!.id;
    const paymentId = randomUUID();
    const key = randomUUID();
    const first = await call<Mut["body"]>("POST", `/v1/checks/${checkId}/payments`, { token: cashierPin, body: { payment_id: paymentId, tender_type_id: ids.card, amount: 50 }, idempotencyKey: key });
    const second = await call<Mut["body"]>("POST", `/v1/checks/${checkId}/payments`, { token: cashierPin, body: { payment_id: paymentId, tender_type_id: ids.card, amount: 50 }, idempotencyKey: key });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.data.checks[0]!.paid_total).toBe(50);
    const third = await call<Mut["body"]>("POST", `/v1/checks/${checkId}/payments`, { token: cashierPin, body: { payment_id: paymentId, tender_type_id: ids.card, amount: 50 } });
    expect(third.status).toBe(409);
    const [n] = await db.sql`select count(*)::int as n from payments where check_id = ${checkId}`;
    expect(n!.n).toBe(1);
  });

  it("a pay-before-firing counter station cannot send until the bill is paid; paying then sending completes the order", async () => {
    const o = await open(counterCashierPin, { order_type: "takeaway", takeaway_ref: "Tan" });
    const added = await addLines(counterCashierPin, o.body.data.id, [{ line_id: randomUUID(), product_id: ids.kopi, quantity: 2 }]);
    const blocked = await call<Mut["body"]>("POST", `/v1/orders/${o.body.data.id}/fire`, { token: counterCashierPin, body: {} });
    expect(blocked.status).toBe(422);
    expect(blocked.body.details).toMatchObject({ invariant: "pay_before_firing" });
    const checkId = added.body.data.checks[0]!.id;
    const paid = await pay(counterCashierPin, checkId, { tender_type_id: ids.card, amount: added.body.data.totals.total });
    expect(paid.body.data.status).toBe("open"); // nothing sent yet
    const fired = await call<Mut["body"]>("POST", `/v1/orders/${o.body.data.id}/fire`, { token: counterCashierPin, body: {} });
    expect(fired.status).toBe(200);
    const final = await call<{ data: Snap }>("GET", `/v1/orders/${o.body.data.id}`, { token: counterCashierPin });
    expect(final.body.data.status).toBe("fired"); // completion is a payment-time or explicit step
    const complete = await call<Mut["body"]>("POST", `/v1/orders/${o.body.data.id}/complete`, { token: counterCashierPin, body: {} });
    expect(complete.status).toBe(200);
    expect(complete.body.data.status).toBe("completed");
  });

  it("invoices are numbered gap-free even when issued concurrently; reissuing returns the same number; the PDF renders", async () => {
    const checksToInvoice: string[] = [];
    for (let i = 0; i < 5; i++) {
      const o = await open(cashierPin, { order_type: "takeaway" });
      const added = await addLines(cashierPin, o.body.data.id, [{ line_id: randomUUID(), product_id: ids.kopi, quantity: 1 }]);
      await call("POST", `/v1/orders/${o.body.data.id}/fire`, { token: cashierPin, body: {} });
      await pay(cashierPin, added.body.data.checks[0]!.id, { tender_type_id: ids.card, amount: added.body.data.totals.total });
      checksToInvoice.push(added.body.data.checks[0]!.id);
    }
    const unpaidOrder = await open(cashierPin, { order_type: "takeaway" });
    const unpaid = await addLines(cashierPin, unpaidOrder.body.data.id, [{ line_id: randomUUID(), product_id: ids.kopi, quantity: 1 }]);
    expect((await call("POST", `/v1/checks/${unpaid.body.data.checks[0]!.id}/invoice`, { token: cashierPin, body: {} })).status).toBe(409);

    const results = await Promise.all(checksToInvoice.map((id) => call<{ data: { invoice_no: string; reused: boolean } }>("POST", `/v1/checks/${id}/invoice`, { token: cashierPin, body: {} })));
    const numbers = results.map((r) => r.body.data.invoice_no).sort();
    expect(numbers).toEqual(["INV-000001", "INV-000002", "INV-000003", "INV-000004", "INV-000005"]);
    const again = await call<{ data: { invoice_no: string; reused: boolean } }>("POST", `/v1/checks/${checksToInvoice[0]}/invoice`, { token: cashierPin, body: {} });
    expect(again.body.data.reused).toBe(true);
    expect(again.body.data.invoice_no).toBe(results[0]!.body.data.invoice_no);
    const pdf = await app.request(`/v1/checks/${checksToInvoice[0]}/invoice.pdf`, { headers: { authorization: `Bearer ${cashierPin}` } });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    const bytes = Buffer.from(await pdf.arrayBuffer());
    expect(bytes.subarray(0, 4).toString()).toBe("%PDF");
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it("pre-bill prints on the station's receipt printer and marks the table as bill requested; digital receipts are public by token", async () => {
    const o = await open(cashierPin, { order_type: "dine_in", table_id: ids.table2, pax: 1 });
    const added = await addLines(cashierPin, o.body.data.id, [{ line_id: randomUUID(), product_id: ids.laksa, quantity: 1 }]);
    await call("POST", `/v1/orders/${o.body.data.id}/fire`, { token: cashierPin, body: {} });
    const prebill = await call<Mut["body"] & { jobs: { printer_id: string; kind: string }[] }>("POST", `/v1/orders/${o.body.data.id}/prebill`, { token: cashierPin, body: {} });
    expect(prebill.status, JSON.stringify(prebill.body)).toBe(200);
    expect((prebill.body as unknown as { jobs: { printer_id: string; kind: string }[] }).jobs[0]).toMatchObject({ printer_id: ids.receiptPrinter, kind: "prebill" });
    const floor = await call<{ data: { tables: { id: string; status: string }[] } }>("GET", `/v1/outlets/${A.outletId}/floor`, { token: cashierPin });
    expect(floor.body.data.tables.find((t) => t.id === ids.table2)!.status).toBe("bill_requested");
    const jobs = await call<{ data: { kind: string; text: string }[] }>("GET", `/v1/outlets/${A.outletId}/print-jobs?order_id=${o.body.data.id}`, { token: cashierPin });
    const pre = jobs.body.data.find((j) => j.kind === "prebill")!;
    expect(pre.text).toMatch(/Laksa/);
    expect(pre.text).toMatch(/Service charge/);
    expect(pre.text).toMatch(/GST/);

    const checkId = added.body.data.checks[0]!.id;
    await pay(cashierPin, checkId, { tender_type_id: ids.card, amount: added.body.data.totals.total });
    const printed = await call<{ data: { kind: string }[] }>("POST", `/v1/checks/${checkId}/receipt/print`, { token: cashierPin, body: {} });
    expect(printed.status).toBe(200);
    const sent = await call<{ data: { token: string; url: string; delivery_status: string }; warnings: string[] }>("POST", `/v1/checks/${checkId}/receipt/send`, { token: cashierPin, body: { channel: "qr" } });
    expect(sent.status).toBe(200);
    expect(sent.body.data.delivery_status).toBe("link_only");
    const email = await call<{ warnings: string[] }>("POST", `/v1/checks/${checkId}/receipt/send`, { token: cashierPin, body: { channel: "email", destination: "guest@example.com" } });
    expect(email.body.warnings[0]).toMatch(/not configured/);
    const pub = await call<{ data: { document: { kind: string; currency: string; currency_exponent: number; totals: { total: number }; payments: unknown[] }; settings: Record<string, unknown> } }>("GET", `/v1/receipts/${sent.body.data.token}`);
    expect(pub.status).toBe(200);
    expect(pub.body.data.settings).toEqual({ currency: "SGD", locale: "en-SG", timezone: "Asia/Singapore", currency_exponent: 2 });
    expect(pub.body.data.document).toMatchObject({ currency: "SGD", currency_exponent: 2 });
    expect(pub.body.data.document.kind).toBe("receipt");
    expect(pub.body.data.document.totals.total).toBe(added.body.data.totals.total);
    expect(pub.body.data.document.payments).toHaveLength(1);
    expect((await call("GET", "/v1/receipts/not-a-real-token-xyz")).status).toBe(404);
  });

  it("shifts: payments attach to the open shift; closing reconciles expected cash including rounding; the Z-report agrees", async () => {
    const shift = await call<{ data: { id: string; float_cents: number } }>("POST", "/v1/shifts", { token: cashierPin, body: { float_cents: 20_000, name: "Dinner" } });
    expect(shift.status, JSON.stringify(shift.body)).toBe(201);
    expect((await call("POST", "/v1/shifts", { token: cashierPin, body: { float_cents: 100 } })).status).toBe(409);
    const o = await open(cashierPin, { order_type: "takeaway" });
    const added = await addLines(cashierPin, o.body.data.id, [{ line_id: randomUUID(), product_id: ids.laksa, quantity: 1 }]); // 1600 + GST 144 = 1744 → cash rounding to 1745 (+1)
    await call("POST", `/v1/orders/${o.body.data.id}/fire`, { token: cashierPin, body: {} });
    const total = added.body.data.totals.total;
    const cash = await pay(cashierPin, added.body.data.checks[0]!.id, { tender_type_id: ids.cash, amount: total, tendered: 2000 });
    const rounding = cash.body.payment!.rounding_cents;
    expect(total).toBe(1744);
    expect(rounding).toBe(1);
    const z = await call<{ data: { tenders: { tender: string; amount: number; rounding: number }[]; cash: { expected: number; float: number } } }>("GET", `/v1/outlets/${A.outletId}/z-report`, { token: cashierPin });
    expect(z.status).toBe(200);
    const cashTender = z.body.data.tenders.find((t) => t.tender === "Cash")!;
    const [dayCash] = await db.sql`select coalesce(sum(amount),0)::int as amount, coalesce(sum(rounding_cents),0)::int as rounding from payments where outlet_id = ${A.outletId} and is_cash and status = 'recorded' and business_date = ${(await db.sql`select business_date from payments where id = ${cash.body.payment!.amount ? (await db.sql`select id from payments where check_id = ${added.body.data.checks[0]!.id}`)[0]!.id : ""}`)[0]!.business_date}`;
    expect(cashTender).toMatchObject({ amount: dayCash!.amount, rounding: dayCash!.rounding });
    expect(cashTender.amount).toBeGreaterThanOrEqual(total);
    const closed = await call<{ data: { expected_cash_cents: number; variance_cents: number; report: { cash: { float: number; cash_payments: number; rounding: number; expected: number } } } }>("POST", `/v1/shifts/${shift.body.data.id}/close`, { token: cashierPin, body: { counted_cash_cents: 20_000 + total + rounding - 100, variance_reason: "Short $1" } });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.data.report.cash).toMatchObject({ float: 20_000, cash_payments: total, rounding, expected: 20_000 + total + rounding });
    expect(closed.body.data.variance_cents).toBe(-100);
    // Another cashier's shift needs Manager+ to close.
    const s2 = await call<{ data: { id: string } }>("POST", "/v1/shifts", { token: cashierPin, body: { float_cents: 0 } });
    expect((await call("POST", `/v1/shifts/${s2.body.data.id}/close`, { token: serverPin, body: { counted_cash_cents: 0 } })).status).toBe(403);
    expect((await call("POST", `/v1/shifts/${s2.body.data.id}/close`, { token: managerPin, body: { counted_cash_cents: 0 } })).status).toBe(200);
    const day = await call<{ data: { report: { sales: { net: number }; orders: { count: number } } } }>("POST", `/v1/outlets/${A.outletId}/business-days/close`, { token: managerPin, body: {} });
    expect(day.status, JSON.stringify(day.body)).toBe(200);
    expect(day.body.data.report.orders.count).toBeGreaterThan(3);
  });

  it("reopen on the same business day reverses payments and recharges; a server cannot reopen", async () => {
    const o = await open(cashierPin, { order_type: "takeaway" });
    const added = await addLines(cashierPin, o.body.data.id, [{ line_id: randomUUID(), product_id: ids.kopi, quantity: 1 }]);
    await call("POST", `/v1/orders/${o.body.data.id}/fire`, { token: cashierPin, body: {} });
    const total = added.body.data.totals.total;
    const paid = await pay(cashierPin, added.body.data.checks[0]!.id, { tender_type_id: ids.card, amount: total });
    expect(paid.body.data.status).toBe("completed");
    expect((await call("POST", `/v1/orders/${o.body.data.id}/reopen`, { token: serverPin, body: { reason: "wrong tender" } })).status).toBe(403);
    const reopened = await call<Mut["body"]>("POST", `/v1/orders/${o.body.data.id}/reopen`, { token: managerPin, body: { reason: "wrong tender" } });
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    expect(reopened.body.data.status).toBe("fired");
    expect(reopened.body.data.pricing_status).toBe("live");
    expect(reopened.body.data.balance).toBe(total);
    expect(reopened.body.data.checks[0]!.locked).toBe(false);
    expect(reopened.body.events.map((e) => e.type)).toEqual(["payment.reversed", "order.reopened"]);
    const [n] = await db.sql`select count(*)::int as n from payments where order_id = ${o.body.data.id} and status = 'reversed'`;
    expect(n!.n).toBe(1);
    const again = await pay(cashierPin, reopened.body.data.checks[0]!.id, { tender_type_id: ids.cash, amount: total });
    expect(again.body.data.status).toBe("completed");
    // Yesterday's order cannot be reopened.
    await db.sql`update orders set business_date = '2020-01-01' where id = ${o.body.data.id}`;
    const old = await call<Mut["body"]>("POST", `/v1/orders/${o.body.data.id}/reopen`, { token: managerPin, body: { reason: "late" } });
    expect(old.status).toBe(422);
    expect(old.body.details).toMatchObject({ invariant: "reopen_same_business_day" });
  });
});
