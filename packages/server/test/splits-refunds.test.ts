import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
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
const ids = { laksa: randomUUID(), wine: randomUUID(), kopi: randomUUID(), menu: randomUUID(), link: randomUUID(), area: randomUUID(), station: randomUUID(), cash: randomUUID(), card: randomUUID(), printer: randomUUID() };

type Check = { id: string; index: number; label: string; status: string; seat_no: number | null; totals: { total: number; subtotal: number; tax_total: number; fee_total: number }; paid_total: number; balance: number; locked: boolean; refunded_total: number; allocations: { line_id: string; share: string; total: number }[]; payments: { id: string; amount: number; tender: string }[] };
type Snap = { id: string; version: number; status: string; totals: { total: number; tax_total: number }; lines: { id: string; name: string; quantity: number; seat_no: number | null; amounts: { total: number } }[]; checks: Check[]; balance: number };
type Body = { data: Snap; refund?: { id: string; refund_receipt_no: string; credit_note_no: string | null; totals: { total: number; tax: number; base: number }; quote: { lines: { line_id: string; quantity: number; total: number; tax: number }[]; tenders: { payment_id: string; amount: number; rounding_cents: number; is_cash: boolean }[]; cash_out: number } }; events: { type: string }[]; warnings: string[]; code?: string; message?: string; details?: Record<string, unknown> };

const open = (token: string, body: Record<string, unknown>) => call<Body>("POST", "/v1/orders", { token, body: { order_id: randomUUID(), ...body } });
const addLines = (token: string, orderId: string, lines: Record<string, unknown>[]) => call<Body>("POST", `/v1/orders/${orderId}/lines`, { token, body: { lines } });
const pay = (token: string, checkId: string, body: Record<string, unknown>) => call<Body>("POST", `/v1/checks/${checkId}/payments`, { token, body: { payment_id: randomUUID(), ...body } });
const sumChecks = (s: Snap) => s.checks.reduce((a, c) => a + c.totals.total, 0);

beforeAll(async () => {
  db = await freshDb();
  app = buildApp();
  call = api(app).call;
  A = await seedMerchant(db.sql, "Alpha");
  await withTransaction(() => seedRulesForMerchant(A.merchantId, sgSeedRules(A)));
  const t = A.admin.token;
  await call("PATCH", "/v1/merchant/settings", { token: t, body: { cash_rounding_increment: 5 } });
  await call("POST", "/v1/products", { token: t, body: { id: ids.laksa, name: "Laksa", price: 1600, tags: ["kitchen", "food"] } });
  await call("POST", "/v1/products", { token: t, body: { id: ids.wine, name: "House wine", price: 6600, tags: ["bar", "alcohol"] } });
  await call("POST", "/v1/products", { token: t, body: { id: ids.kopi, name: "Kopi", price: 180, tags: ["bar"] } });
  await call("POST", "/v1/pricing-rules", { token: t, body: { rule_key: "promo:food25", body: { kind: "discount", name: "25% off food", calc: "percent", value: { type: "fixed", amount: 2500 }, scope: { type: "tags", tags: ["food"] }, priority: 10, application: "auto", report_class: "promo" }, effective_from: "2026-01-01T00:00:00Z" } });
  await call("POST", "/v1/menus", { token: t, body: { id: ids.menu, brand_id: A.brandId, name: "M", sections: [{ name: "All", items: [ids.laksa, ids.wine, ids.kopi].map((product_id) => ({ product_id })) }] } });
  await call("POST", "/v1/channel-links", { token: t, body: { id: ids.link, channel: "pos", outlet_id: A.outletId, brand_id: A.brandId, menu_id: ids.menu } });
  await call("POST", "/v1/areas", { token: t, body: { id: ids.area, outlet_id: A.outletId, name: "Main" } });
  for (let i = 1; i <= 6; i++) await call("POST", "/v1/tables", { token: t, body: { outlet_id: A.outletId, area_id: ids.area, name: String(i) } });
  await call("POST", "/v1/tender-types", { token: t, body: { id: ids.cash, name: "Cash", is_cash: true } });
  await call("POST", "/v1/tender-types", { token: t, body: { id: ids.card, name: "Card", is_terminal: true } });
  await call("POST", "/v1/printers", { token: t, body: { id: ids.printer, outlet_id: A.outletId, name: "Receipt", ip: "10.0.0.9", role: "receipt" } });
  await call("POST", "/v1/stations", { token: t, body: { id: ids.station, outlet_id: A.outletId, brand_id: A.brandId, name: "Floor", seats_enabled: true, receipt_printer_id: ids.printer } });
  const code = await call<{ data: { code: string } }>("POST", `/v1/stations/${ids.station}/pairing-code`, { token: t, body: {} });
  const paired = await call<{ data: { station_token: string } }>("POST", "/v1/stations/pair", { body: { code: code.body.data.code, device_label: "iPad" }, idempotencyKey: null });
  const signIn = async (pin: string) => (await call<{ data: { session_token: string } }>("POST", "/v1/stations/sessions", { token: paired.body.data.station_token, body: { pin } })).body.data.session_token;
  serverPin = await signIn("444444");
  cashierPin = await signIn("333333");
  managerPin = await signIn("222222");
});
afterAll(async () => {
  await db.drop();
});

async function tableId(name: string) {
  const [t] = await db.sql`select id from tables where outlet_id = ${A.outletId} and name = ${name}`;
  return t!.id as string;
}

describe("bill splitting", () => {
  it("even split: N bills add up to the order to the cent; switching modes is free before payment; unsplit returns to one bill", async () => {
    const o = await open(serverPin, { order_type: "dine_in", table_id: await tableId("1"), pax: 3 });
    const added = await addLines(serverPin, o.body.data.id, [{ line_id: randomUUID(), product_id: ids.laksa, quantity: 1, seat_no: 1 }, { line_id: randomUUID(), product_id: ids.kopi, quantity: 1, seat_no: 2 }, { line_id: randomUUID(), product_id: ids.wine, quantity: 1 }]);
    const total = added.body.data.totals.total;
    for (const n of [3, 2, 7]) {
      const r = await call<Body>("POST", `/v1/orders/${o.body.data.id}/checks/split-even`, { token: serverPin, body: { n } });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.data.checks).toHaveLength(n);
      expect(sumChecks(r.body.data)).toBe(total);
      expect(r.body.data.checks.every((c) => c.allocations.every((a) => a.share === `1/${n}`))).toBe(true);
      // Ties go to earlier bills: totals are non-increasing by index.
      const totals = r.body.data.checks.map((c) => c.totals.total);
      for (let i = 1; i < totals.length; i++) expect(totals[i - 1]!).toBeGreaterThanOrEqual(totals[i]!);
      const tax = r.body.data.checks.reduce((a, c) => a + c.totals.tax_total, 0);
      expect(tax).toBe(added.body.data.totals.tax_total);
    }
    const one = await call<Body>("POST", `/v1/orders/${o.body.data.id}/checks/unsplit`, { token: serverPin, body: {} });
    expect(one.body.data.checks).toHaveLength(1);
    expect(one.body.data.checks[0]!.totals.total).toBe(total);
  });

  it("by seat: one bill per seat, shared lines split evenly or kept on a Shared bill", async () => {
    const o = await open(serverPin, { order_type: "dine_in", table_id: await tableId("2"), pax: 2 });
    const laksaLine = randomUUID();
    const kopiLine = randomUUID();
    const wineLine = randomUUID();
    const added = await addLines(serverPin, o.body.data.id, [{ line_id: laksaLine, product_id: ids.laksa, quantity: 1, seat_no: 1 }, { line_id: kopiLine, product_id: ids.kopi, quantity: 1, seat_no: 2 }, { line_id: wineLine, product_id: ids.wine, quantity: 1 }]);
    const even = await call<Body>("POST", `/v1/orders/${o.body.data.id}/checks/split-by-seat`, { token: serverPin, body: { shared: "even" } });
    expect(even.status, JSON.stringify(even.body)).toBe(200);
    expect(even.body.data.checks.map((c) => c.seat_no)).toEqual([1, 2]);
    expect(sumChecks(even.body.data)).toBe(added.body.data.totals.total);
    const seat1 = even.body.data.checks[0]!;
    expect(seat1.allocations.find((a) => a.line_id === laksaLine)!.share).toBe("1");
    expect(seat1.allocations.find((a) => a.line_id === wineLine)!.share).toBe("1/2");
    expect(seat1.allocations.find((a) => a.line_id === kopiLine)).toBeUndefined();
    const manual = await call<Body>("POST", `/v1/orders/${o.body.data.id}/checks/split-by-seat`, { token: serverPin, body: { shared: "manual" } });
    expect(manual.body.data.checks.map((c) => c.label)).toEqual(["Bill 1 · Seat 1", "Bill 2 · Seat 2", "Shared"]);
    expect(manual.body.data.checks[2]!.allocations.map((a) => a.line_id)).toEqual([wineLine]);
    expect(sumChecks(manual.body.data)).toBe(added.body.data.totals.total);
  });

  it("by item: move a line to a bill, share the wine three ways, pay one bill, then the paid bill is locked", async () => {
    const o = await open(cashierPin, { order_type: "dine_in", table_id: await tableId("3"), pax: 3 });
    const laksaLine = randomUUID();
    const kopiLine = randomUUID();
    const wineLine = randomUUID();
    const added = await addLines(cashierPin, o.body.data.id, [{ line_id: laksaLine, product_id: ids.laksa, quantity: 1 }, { line_id: kopiLine, product_id: ids.kopi, quantity: 1 }, { line_id: wineLine, product_id: ids.wine, quantity: 1 }]);
    const total = added.body.data.totals.total;
    const three = await call<Body>("POST", `/v1/orders/${o.body.data.id}/checks/split-even`, { token: cashierPin, body: { n: 3 } });
    const [b1, b2, b3] = three.body.data.checks.map((c) => c.id) as [string, string, string];
    const moved = await call<Body>("POST", `/v1/orders/${o.body.data.id}/checks/allocate`, { token: cashierPin, body: { moves: [{ line_id: laksaLine, check_ids: [b1] }, { line_id: kopiLine, check_ids: [b2] }, { line_id: wineLine, check_ids: [b1, b2, b3] }] } });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(sumChecks(moved.body.data)).toBe(total);
    const c1 = moved.body.data.checks.find((c) => c.id === b1)!;
    expect(c1.allocations.map((a) => [a.line_id, a.share]).sort()).toEqual([[laksaLine, "1"], [wineLine, "1/3"]].sort());
    const c3 = moved.body.data.checks.find((c) => c.id === b3)!;
    expect(c3.allocations.map((a) => a.line_id)).toEqual([wineLine]);
    // Wine 6600 + SC 660 + GST 594 + 59.4→59 = 7913 across three bills: 2638/2638/2637 style split; the three shares add up.
    const wineShares = moved.body.data.checks.map((c) => c.allocations.find((a) => a.line_id === wineLine)!.total);
    expect(wineShares.reduce((a, b) => a + b, 0)).toBe(added.body.data.lines.find((l) => l.id === wineLine)!.amounts.total);

    await call("POST", `/v1/orders/${o.body.data.id}/fire`, { token: cashierPin, body: {} });
    const paid = await pay(cashierPin, b3, { tender_type_id: ids.card, amount: c3.totals.total });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.data.checks.find((c) => c.id === b3)!.status).toBe("paid");
    const blocked = await call<Body>("POST", `/v1/orders/${o.body.data.id}/checks/allocate`, { token: cashierPin, body: { moves: [{ line_id: wineLine, check_ids: [b1] }] } });
    expect(blocked.status).toBe(422);
    expect(blocked.body.message).toMatch(/Bill 3 is paid/);
    expect((await call("POST", `/v1/orders/${o.body.data.id}/checks/split-even`, { token: cashierPin, body: { n: 2 } })).status).toBe(422);
    // Unpaid lines can still move between unpaid bills.
    const ok = await call<Body>("POST", `/v1/orders/${o.body.data.id}/checks/allocate`, { token: cashierPin, body: { moves: [{ line_id: kopiLine, check_ids: [b1] }] } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(sumChecks(ok.body.data)).toBe(total);
    expect(ok.body.data.checks.find((c) => c.id === b3)!.totals.total).toBe(c3.totals.total);
    // Each bill rounds cash on its own.
    const c1After = ok.body.data.checks.find((c) => c.id === b1)!;
    const cash1 = await pay(cashierPin, b1, { tender_type_id: ids.cash, amount: c1After.totals.total, tendered: 10_000 });
    expect(cash1.status).toBe(200);
    expect(Math.abs((cash1.body as unknown as { payment: { rounding_cents: number } }).payment.rounding_cents) * 2).toBeLessThanOrEqual(5);
  });

  it("property: random baskets split N ways always add up to the order", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.record({ p: fc.constantFrom(ids.laksa, ids.wine, ids.kopi), q: fc.integer({ min: 1, max: 4 }) }), { minLength: 1, maxLength: 5 }), fc.integer({ min: 1, max: 9 }), async (basket, n) => {
        const o = await open(serverPin, { order_type: "takeaway" });
        const added = await addLines(serverPin, o.body.data.id, basket.map((b) => ({ line_id: randomUUID(), product_id: b.p, quantity: b.q })));
        const r = await call<Body>("POST", `/v1/orders/${o.body.data.id}/checks/split-even`, { token: serverPin, body: { n } });
        expect(r.status).toBe(200);
        expect(sumChecks(r.body.data)).toBe(added.body.data.totals.total);
        await call("POST", `/v1/orders/${o.body.data.id}/cancel`, { token: serverPin, body: { reason: "property" } });
      }),
      { numRuns: 12 },
    );
  });
});

describe("refunds", () => {
  it("full refund of a bill: receipt numbered, status refunded, tenders reversed to the original payments, cash rounded; caps stop a second refund", async () => {
    const o = await open(cashierPin, { order_type: "dine_in", table_id: await tableId("4"), pax: 1 });
    const added = await addLines(cashierPin, o.body.data.id, [{ line_id: randomUUID(), product_id: ids.laksa, quantity: 2 }]);
    await call("POST", `/v1/orders/${o.body.data.id}/fire`, { token: cashierPin, body: {} });
    const check = added.body.data.checks[0]!;
    const total = check.totals.total;
    await pay(cashierPin, check.id, { tender_type_id: ids.card, amount: 1000 });
    const cashPaid = await pay(cashierPin, check.id, { tender_type_id: ids.cash, amount: total - 1000, tendered: 5000 });
    expect(cashPaid.body.data.status).toBe("completed");

    const unpaidQuote = await call("POST", `/v1/checks/${randomUUID()}/refunds/quote`, { token: managerPin, body: { request: { kind: "full" } } });
    expect(unpaidQuote.status).toBe(404);
    const q = await call<{ data: { totals: { total: number; tax: number }; tenders: { tender: string; amount: number; rounding_cents: number }[]; cash_out: number } }>("POST", `/v1/checks/${check.id}/refunds/quote`, { token: cashierPin, body: { request: { kind: "full" } } });
    expect(q.status, JSON.stringify(q.body)).toBe(200);
    expect(q.body.data.totals.total).toBe(total);
    expect(q.body.data.totals.tax).toBe(check.totals.tax_total);
    expect(q.body.data.tenders.map((t) => [t.tender, t.amount])).toEqual([["Card", 1000], ["Cash", total - 1000]]);

    const denied = await call<Body>("POST", `/v1/checks/${check.id}/refunds`, { token: cashierPin, body: { refund_id: randomUUID(), request: { kind: "full" }, reason: "Guest unhappy" } });
    expect(denied.status).toBe(403);
    expect(denied.body.details).toMatchObject({ required_role: "manager", override_allowed: true });
    const noReason = await call<Body>("POST", `/v1/checks/${check.id}/refunds`, { token: managerPin, body: { refund_id: randomUUID(), request: { kind: "full" } } });
    expect(noReason.status).toBe(400);
    const refund = await call<Body>("POST", `/v1/checks/${check.id}/refunds`, { token: managerPin, body: { refund_id: randomUUID(), request: { kind: "full" }, reason: "Guest unhappy" } });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    expect(refund.body.refund!.refund_receipt_no).toBe("RR-000001");
    expect(refund.body.refund!.credit_note_no).toBeNull();
    expect(refund.body.refund!.totals.total).toBe(total);
    expect(refund.body.data.checks[0]!.status).toBe("refunded");
    expect(refund.body.data.checks[0]!.refunded_total).toBe(total);
    expect(refund.body.events.map((e) => e.type)).toEqual(["refund.created", "check.refunded"]);
    expect(refund.body.warnings).toEqual([]);
    const jobs = await call<{ data: { kind: string; text: string }[] }>("GET", `/v1/outlets/${A.outletId}/print-jobs?order_id=${o.body.data.id}`, { token: cashierPin });
    const rr = jobs.body.data.find((j) => j.kind === "refund_receipt")!;
    expect(rr.text).toMatch(/RR-000001/);
    expect(rr.text).toMatch(/Guest unhappy/);
    const again = await call<Body>("POST", `/v1/checks/${check.id}/refunds`, { token: managerPin, body: { refund_id: randomUUID(), request: { kind: "amount", amount: 100 }, reason: "again" } });
    expect(again.status).toBe(422);
    expect(again.body.details).toMatchObject({ refund_error: "exceeds_line" });
  });

  it("partial refund by line reverses the line's share of each adjustment and GST; a cashier can refund with a manager override; refunds reduce expected cash", async () => {
    const shift = await call<{ data: { id: string } }>("POST", "/v1/shifts", { token: cashierPin, body: { float_cents: 10_000 } });
    const o = await open(cashierPin, { order_type: "dine_in", table_id: await tableId("5"), pax: 2 });
    const laksaLine = randomUUID();
    const added = await addLines(cashierPin, o.body.data.id, [{ line_id: laksaLine, product_id: ids.laksa, quantity: 2 }, { line_id: randomUUID(), product_id: ids.kopi, quantity: 1 }]);
    await call("POST", `/v1/orders/${o.body.data.id}/fire`, { token: cashierPin, body: {} });
    const check = added.body.data.checks[0]!;
    const paid = await pay(cashierPin, check.id, { tender_type_id: ids.cash, amount: check.totals.total, tendered: 10_000 });
    expect(paid.status).toBe(200);
    const laksaTotal = added.body.data.lines.find((l) => l.id === laksaLine)!.amounts.total;
    const q = await call<{ data: { lines: { quantity: number; total: number; tax: number; base: number; discount: number; fee: number }[]; tenders: { is_cash: boolean; amount: number; rounding_cents: number }[]; cash_out: number } }>("POST", `/v1/checks/${check.id}/refunds/quote`, { token: cashierPin, body: { request: { kind: "lines", lines: [{ line_id: laksaLine, quantity: 1 }] } } });
    const l = q.body.data.lines[0]!;
    // 1 of 2 laksa: base 1600, 25% off −400, SC 10% of 1200 = 120, GST 9%: 108 + 10.8→11 (half of 2 × ...) → the half of the line.
    expect(l.quantity).toBe(1);
    expect(l.base).toBe(1600);
    expect(l.discount).toBe(-400);
    expect(l.fee).toBe(120);
    expect(l.base + l.discount + l.fee + l.tax).toBe(l.total);
    expect(Math.abs(l.total * 2 - laksaTotal)).toBeLessThanOrEqual(1);
    const grant = await call<{ data: { override_id: string } }>("POST", "/v1/overrides", { token: cashierPin, body: { action: "refunds.create", target_kind: "check", target_id: check.id, approver_pin: "222222", args: { request: { kind: "lines", lines: [{ line_id: laksaLine, quantity: 1 }] }, total: l.total } } });
    expect(grant.status).toBe(201);
    const refund = await call<Body>("POST", `/v1/checks/${check.id}/refunds`, { token: cashierPin, body: { refund_id: randomUUID(), request: { kind: "lines", lines: [{ line_id: laksaLine, quantity: 1 }] }, reason: "Dish was cold", override_id: grant.body.data.override_id } });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    expect(refund.body.refund!.totals.total).toBe(l.total);
    expect(refund.body.data.checks[0]!.status).toBe("partially_refunded");
    const cashOut = refund.body.refund!.quote.cash_out;
    expect(Math.abs(cashOut - l.total)).toBeLessThanOrEqual(2);
    const audit = await call<{ data: { action: string; approver_name: string; reason: string }[] }>("GET", "/v1/audit?action=refunds.create", { token: A.admin.token });
    expect(audit.body.data[0]).toMatchObject({ approver_name: "Mia Manager", reason: "Dish was cold" });
    // The second laksa can still be refunded, the third cannot.
    expect((await call<Body>("POST", `/v1/checks/${check.id}/refunds/quote`, { token: managerPin, body: { request: { kind: "lines", lines: [{ line_id: laksaLine, quantity: 2 }] } } })).status).toBe(422);
    // Shift close: expected cash = float + cash payments + rounding − cash refunds.
    const closed = await call<{ data: { report: { cash: { float: number; cash_payments: number; rounding: number; refunds: number; expected: number }; refunds: { count: number; amount: number } } } }>("POST", `/v1/shifts/${shift.body.data.id}/close`, { token: cashierPin, body: { counted_cash_cents: 0, variance_reason: "Drawer emptied before the count" } });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const cash = closed.body.data.report.cash;
    expect(cash.refunds).toBe(cashOut);
    expect(cash.expected).toBe(cash.float + cash.cash_payments + cash.rounding - cash.refunds);
    expect(closed.body.data.report.refunds.count).toBe(1);
  });

  it("goodwill refund by amount against an invoiced bill produces a credit note PDF referencing the invoice", async () => {
    const o = await open(cashierPin, { order_type: "takeaway" });
    const added = await addLines(cashierPin, o.body.data.id, [{ line_id: randomUUID(), product_id: ids.wine, quantity: 1 }, { line_id: randomUUID(), product_id: ids.kopi, quantity: 2 }]);
    await call("POST", `/v1/orders/${o.body.data.id}/fire`, { token: cashierPin, body: {} });
    const check = added.body.data.checks[0]!;
    await pay(cashierPin, check.id, { tender_type_id: ids.card, amount: check.totals.total });
    const inv = await call<{ data: { invoice_no: string } }>("POST", `/v1/checks/${check.id}/invoice`, { token: cashierPin, body: {} });
    expect(inv.body.data.invoice_no).toBe("INV-000001");
    const refund = await call<Body>("POST", `/v1/checks/${check.id}/refunds`, { token: managerPin, body: { refund_id: randomUUID(), request: { kind: "amount", amount: 1000 }, reason: "Late by 40 minutes", print: false } });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    expect(refund.body.refund!.totals.total).toBe(1000);
    expect(refund.body.refund!.credit_note_no).toBe("CN-000001");
    expect(refund.body.refund!.quote.lines.every((l) => l.quantity === 0)).toBe(true);
    expect(refund.body.refund!.totals.tax).toBeGreaterThan(0);
    const pdf = await app.request(`/v1/refunds/${refund.body.refund!.id}/credit-note.pdf`, { headers: { authorization: `Bearer ${managerPin}` } });
    expect(pdf.status).toBe(200);
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString()).toBe("%PDF");
    const list = await call<{ data: { credit_note_no: string; business_date: string }[] }>("GET", `/v1/orders/${o.body.data.id}/refunds`, { token: cashierPin });
    expect(list.body.data[0]!.credit_note_no).toBe("CN-000001");
    const sent = await call<{ data: { url: string } }>("POST", `/v1/refunds/${refund.body.refund!.id}/receipt/send`, { token: cashierPin, body: { channel: "qr" } });
    expect(sent.status).toBe(200);
    const pub = await call<{ data: { document: { kind: string; credit_note_no: string; totals: { total: number } } } }>("GET", `/v1/receipts/${sent.body.data.url.split("/").pop()}`);
    expect(pub.body.data.document.kind).toBe("refund_receipt");
    expect(pub.body.data.document.credit_note_no).toBe("CN-000001");
    expect(pub.body.data.document.totals.total).toBe(-1000);
  });

  it("refunds are capped per payment in the database and never restore daily caps", async () => {
    await call("POST", "/v1/stock/daily-cap", { token: A.manager.token, body: { outlet_id: A.outletId, product_id: ids.kopi, quantity: 1 } });
    const o = await open(cashierPin, { order_type: "takeaway" });
    const added = await addLines(cashierPin, o.body.data.id, [{ line_id: randomUUID(), product_id: ids.kopi, quantity: 1 }]);
    await call("POST", `/v1/orders/${o.body.data.id}/fire`, { token: cashierPin, body: {} });
    const check = added.body.data.checks[0]!;
    const p1 = await pay(cashierPin, check.id, { tender_type_id: ids.card, amount: 100 });
    await pay(cashierPin, check.id, { tender_type_id: ids.cash, amount: check.totals.total - 100 });
    const paymentId = (p1.body as unknown as { payment: { id: string } }).payment.id;
    const over = await call<Body>("POST", `/v1/checks/${check.id}/refunds`, { token: managerPin, body: { refund_id: randomUUID(), request: { kind: "full" }, reason: "x", tender_split: [{ payment_id: paymentId, amount: check.totals.total }], print: false } });
    expect(over.status).toBe(422);
    expect(over.body.details).toMatchObject({ refund_error: "exceeds_payment" });
    const ok = await call<Body>("POST", `/v1/checks/${check.id}/refunds`, { token: managerPin, body: { refund_id: randomUUID(), request: { kind: "full" }, reason: "x", print: false } });
    expect(ok.status).toBe(201);
    const stock = await call<{ data: { product_id: string; cap_remaining: number }[] }>("GET", `/v1/outlets/${A.outletId}/stock`, { token: cashierPin });
    expect(stock.body.data.find((s) => s.product_id === ids.kopi)!.cap_remaining).toBe(0); // not restored
    await call("POST", "/v1/stock/daily-cap", { token: A.manager.token, body: { outlet_id: A.outletId, product_id: ids.kopi, quantity: null } });
    // Refund rows are immutable.
    await expect(db.sql`delete from refunds where check_id = ${check.id}`).rejects.toThrow(/append_only/);
  });
});
