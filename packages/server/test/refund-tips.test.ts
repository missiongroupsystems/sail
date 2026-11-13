import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/modules.js";
import { buildApp } from "../src/app.js";
import { api, freshDb, seedMerchant, type SeededMerchant, type TestDb } from "./helpers.js";

/**
 * A tip is not part of the bill, but it is money the guest paid: a whole-bill refund gives it back with the bill, a
 * refund by item or amount leaves it alone, and the Z-report, the sales summary and the drawer all count it once. A
 * tip is never more than the bill it is left on. Refund refusals speak the merchant's currency.
 */
let db: TestDb;
let call: ReturnType<typeof api>["call"];
let m: SeededMerchant;
const ids = { burger: randomUUID(), soda: randomUUID(), menu: randomUUID(), link: randomUUID(), cash: randomUUID(), card: randomUUID() };

type Tender = { payment_id: string; amount: number; rounding_cents: number; tip_cents: number; is_cash: boolean };
type Quote = { totals: { total: number }; tenders: Tender[]; tip: number; cash_out: number; given_back: number; lines: { line_id: string; quantity: number }[] };
type Check = { id: string; status: string; balance: number; totals: { total: number }; refunded_total: number; allocations: { line_id: string; refunded_quantity: number }[]; payments: { id: string; amount: number; tip_cents: number }[] };
type Snap = { id: string; lines: { id: string; name: string }[]; checks: Check[] };
type Err = { code?: string; message?: string; remedy?: string; details?: Record<string, unknown> };
type Refunds = { count: number; amount: number; net: number; fees: number; tax: number; tips: number };

beforeAll(async () => {
  db = await freshDb();
  call = api(buildApp()).call;
  m = await seedMerchant(db.sql, "Diner", { preset: "us", timeZone: "America/New_York", currency: "USD", locale: "en-US" });
  const t = m.admin.token;
  const must = async (method: string, path: string, body: unknown) => {
    const r = await call(method, path, { token: t, body });
    if (r.status >= 300) throw new Error(`${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  };
  await must("PATCH", "/v1/merchant/settings", { tips_enabled: true });
  await must("POST", "/v1/products", { id: ids.burger, name: "Burger", price: 1650 });
  await must("POST", "/v1/products", { id: ids.soda, name: "Soda", price: 350 });
  await must("POST", "/v1/menus", { id: ids.menu, brand_id: m.brandId, name: "M", sections: [{ name: "All", items: [{ product_id: ids.burger }, { product_id: ids.soda }] }] });
  await must("POST", "/v1/channel-links", { id: ids.link, channel: "pos", outlet_id: m.outletId, brand_id: m.brandId, menu_id: ids.menu });
  await must("POST", "/v1/tender-types", { id: ids.cash, name: "Cash", is_cash: true });
  await must("POST", "/v1/tender-types", { id: ids.card, name: "Card", is_terminal: true });
  await must("POST", "/v1/shifts", { outlet_id: m.outletId, station_id: null, float_cents: 10_000 });
});
afterAll(async () => db.drop());

/** Two burgers and a soda, paid in one go with a tip; returns the order snapshot after payment. */
async function tippedSale(tender: "card" | "cash", tip: number) {
  const o = await call<{ data: Snap }>("POST", "/v1/orders", { token: m.cashier.token, body: { order_id: randomUUID(), order_type: "takeaway", takeaway_ref: "T", outlet_id: m.outletId, brand_id: m.brandId } });
  const lines = await call<{ data: Snap }>("POST", `/v1/orders/${o.body.data.id}/lines`, { token: m.cashier.token, body: { lines: [{ line_id: randomUUID(), product_id: ids.burger, quantity: 2 }, { line_id: randomUUID(), product_id: ids.soda, quantity: 1 }] } });
  const check = lines.body.data.checks[0]!;
  await call("POST", `/v1/orders/${o.body.data.id}/fire`, { token: m.cashier.token, body: {} });
  const paid = await call<{ data: Snap } & Err>("POST", `/v1/checks/${check.id}/payments`, { token: m.cashier.token, body: { payment_id: randomUUID(), tender_type_id: ids[tender], amount: check.balance, tip_cents: tip } });
  expect(paid.status, JSON.stringify(paid.body)).toBe(200);
  return paid.body.data;
}

const quote = (checkId: string, request: unknown) => call<{ data: Quote } & Err>("POST", `/v1/checks/${checkId}/refunds/quote`, { token: m.manager.token, body: { request } });
const refund = (checkId: string, request: unknown) => call<{ data: Snap; refund: { id: string; tip: number; totals: { total: number }; quote: Quote } } & Err>("POST", `/v1/checks/${checkId}/refunds`, { token: m.manager.token, body: { refund_id: randomUUID(), request, reason: "Guest complaint", print: false } });
const zReport = async () => (await call<{ data: { sales: { net: number; fees: number; tax: number; total: number; refunds: number; net_before_refunds: number; total_after_refunds: number }; refunds: Refunds; tenders: { tender: string; tips: number }[]; tenders_summary: { tips: number }; cash: { float: number; cash_payments: number; rounding: number; tips: number; refunds: number; expected: number } } }>("GET", `/v1/outlets/${m.outletId}/z-report`, { token: m.manager.token })).body.data;
const salesSummary = async () => (await call<{ data: { totals: { net: number; fees: number; tax: number; total: number; refunds: number; tips: number; net_before_refunds: number; total_after_refunds: number }; refunds: Refunds } }>("GET", `/v1/reports/sales-summary?outlet_id=${m.outletId}`, { token: m.manager.token })).body.data;

describe("a whole-bill refund gives the tip back", () => {
  it("B-F2: a card payment with an 18% tip is refunded in full, tip included, and the tip cannot be refunded twice", async () => {
    const before = await zReport();
    // The tester's case: about 18% on a $45 bill.
    const s2 = await tippedSale("card", 825);
    const c2 = s2.checks[0]!;
    const tip = c2.payments[0]!.tip_cents;
    expect(tip).toBe(825);

    const q = await quote(c2.id, { kind: "full" });
    expect(q.status, JSON.stringify(q.body)).toBe(200);
    expect(q.body.data.totals.total).toBe(c2.totals.total);
    expect(q.body.data.tip).toBe(tip);
    expect(q.body.data.tenders).toEqual([expect.objectContaining({ payment_id: c2.payments[0]!.id, amount: c2.totals.total, tip_cents: tip })]);
    expect(q.body.data.given_back).toBe(c2.totals.total + tip);

    const r = await refund(c2.id, { kind: "full" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.refund.tip).toBe(tip);
    expect(r.body.data.checks[0]!.status).toBe("refunded");
    // Nothing is left: neither the bill nor the tip.
    const again = await quote(c2.id, { kind: "full" });
    expect(again.body.code).toBe("invariant_violation");
    expect(again.body.details?.refund_error).toBe("nothing_to_refund");
    const listed = await call<{ data: { tip: number }[] }>("GET", `/v1/orders/${s2.id}/refunds`, { token: m.manager.token });
    expect(listed.body.data.map((x) => x.tip)).toEqual([tip]);

    // The refund receipt prints the tip given back on its own row, under the card.
    const [doc] = await db.sql<{ receipt_document: { payments: { tender: string; amount: number; tip?: number }[] } }[]>`select receipt_document from refunds where id = ${r.body.refund.id}`;
    expect(doc!.receipt_document.payments).toEqual([expect.objectContaining({ tender: "Card", amount: -c2.totals.total, tip: -tip })]);

    // The tip taken stays in the tenders' tips; the tip given back is in the refunds, beside the bill's share.
    const after = await zReport();
    expect(after.tenders_summary.tips - before.tenders_summary.tips).toBe(tip);
    expect(after.refunds.tips - before.refunds.tips).toBe(tip);
    expect(after.refunds.amount - before.refunds.amount).toBe(c2.totals.total);
    // A card tip never touches the drawer.
    expect(after.cash.refunds).toBe(before.cash.refunds);
    const summary = await salesSummary();
    expect(summary.refunds.tips).toBe(after.refunds.tips);
  });

  it("a refund by item or amount leaves the tip; the whole-bill refund afterwards gives back the rest of the bill and the tip", async () => {
    const s = await tippedSale("card", 500);
    const check = s.checks[0]!;
    const soda = s.lines.find((l) => l.name === "Soda")!;
    const byItem = await refund(check.id, { kind: "lines", lines: [{ line_id: soda.id, quantity: 1 }] });
    expect(byItem.status, JSON.stringify(byItem.body)).toBe(201);
    expect([byItem.body.refund.tip, byItem.body.refund.quote.tenders[0]!.tip_cents]).toEqual([0, 0]);
    const byAmount = await refund(check.id, { kind: "amount", amount: 100 });
    expect(byAmount.body.refund.tip).toBe(0);
    expect(byAmount.body.data.checks[0]!.status).toBe("partially_refunded");
    const rest = await refund(check.id, { kind: "full" });
    expect(rest.status, JSON.stringify(rest.body)).toBe(201);
    expect(rest.body.refund.tip).toBe(500);
    expect(rest.body.refund.totals.total + byItem.body.refund.totals.total + 100).toBe(check.totals.total);
    expect(rest.body.data.checks[0]!.status).toBe("refunded");
  });

  it("a bill already given back without its tip (refunded before this rule) gets just the tip back from a whole-bill refund", async () => {
    const s = await tippedSale("card", 825);
    const check = s.checks[0]!;
    // Refund every line by item: the bill is all back, the tip is not.
    const byItem = await refund(check.id, { kind: "lines", lines: s.lines.map((l) => ({ line_id: l.id, quantity: l.name === "Burger" ? 2 : 1 })) });
    expect(byItem.status, JSON.stringify(byItem.body)).toBe(201);
    expect(byItem.body.data.checks[0]!.status).toBe("partially_refunded");
    const tipOnly = await refund(check.id, { kind: "full" });
    expect(tipOnly.status, JSON.stringify(tipOnly.body)).toBe(201);
    expect([tipOnly.body.refund.totals.total, tipOnly.body.refund.tip, tipOnly.body.refund.quote.given_back]).toEqual([0, 825, 825]);
    expect(tipOnly.body.data.checks[0]!.status).toBe("refunded");
  });

  it("a cash tip given back comes out of the drawer, and the shift's expected cash still adds up", async () => {
    const before = await zReport();
    const s = await tippedSale("cash", 300);
    const check = s.checks[0]!;
    const r = await refund(check.id, { kind: "full" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const t = r.body.refund.quote.tenders[0]!;
    expect(t.tip_cents).toBe(300);
    expect(r.body.refund.quote.cash_out).toBe(t.amount + t.rounding_cents + 300);
    const after = await zReport();
    expect(after.cash.refunds - before.cash.refunds).toBe(r.body.refund.quote.cash_out);
    // Took bill + tip, gave back bill + tip: the drawer is where it was.
    expect(after.cash.expected).toBe(before.cash.expected);
    const c = after.cash;
    expect(c.expected).toBe(c.float + c.cash_payments + c.rounding + c.tips - c.refunds);
  });

  it("a cash tip given back alone still needs an open shift to pay it out of", async () => {
    const s = await tippedSale("cash", 300);
    const check = s.checks[0]!;
    const byItem = await refund(check.id, { kind: "lines", lines: s.lines.map((l) => ({ line_id: l.id, quantity: l.name === "Burger" ? 2 : 1 })) });
    expect(byItem.status, JSON.stringify(byItem.body)).toBe(201);
    const [shift] = await db.sql<{ id: string }[]>`select id from shifts where outlet_id = ${m.outletId} and status = 'open'`;
    const z = await zReport();
    const closed = await call("POST", `/v1/shifts/${shift!.id}/close`, { token: m.manager.token, body: { counted_cash_cents: z.cash.expected } });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const tipOnly = await refund(check.id, { kind: "full" });
    expect(tipOnly.status).toBe(422);
    expect(tipOnly.body.message).toBe("No shift is open here to pay cash out of");
    expect((await call("POST", "/v1/shifts", { token: m.manager.token, body: { outlet_id: m.outletId, station_id: null, float_cents: 10_000 } })).status).toBe(201);
    const after = await refund(check.id, { kind: "full" });
    expect(after.status, JSON.stringify(after.body)).toBe(201);
    expect(after.body.refund.quote.cash_out).toBe(300);
  });

  it("the database refuses a tip given back beyond the tip the payment took", async () => {
    const s = await tippedSale("card", 200);
    const check = s.checks[0]!;
    const payment = check.payments[0]!;
    const refundId = randomUUID();
    const attempt = db.sql.begin(async (tx) => {
      await tx`insert into refunds (id, merchant_id, outlet_id, order_id, check_id, kind, reason, business_date, base, discount, fee, tax, total, tip, refund_receipt_no, receipt_document)
        values (${refundId}, ${m.merchantId}, ${m.outletId}, ${s.id}, ${check.id}, 'full', 'x', '2026-01-01', 0, 0, 0, 0, 0, 201, 'R-x', '{}'::jsonb)`;
      await tx`insert into refund_tenders (merchant_id, refund_id, payment_id, tender_name, is_cash, amount, rounding_cents, tip_cents) values (${m.merchantId}, ${refundId}, ${payment.id}, 'Card', false, 0, 0, 201)`;
    });
    await expect(attempt).rejects.toThrow(/refund_exceeds_tip/);
  });
});

describe("tips are bounded by the bill", () => {
  it("A-6: a tip above the bill is refused with the amounts in the merchant's currency; a tip of the whole bill is taken", async () => {
    const o = await call<{ data: Snap }>("POST", "/v1/orders", { token: m.cashier.token, body: { order_id: randomUUID(), order_type: "takeaway", takeaway_ref: "T", outlet_id: m.outletId, brand_id: m.brandId } });
    const s = await call<{ data: Snap }>("POST", `/v1/orders/${o.body.data.id}/lines`, { token: m.cashier.token, body: { lines: [{ line_id: randomUUID(), product_id: ids.burger, quantity: 1 }] } });
    const check = s.body.data.checks[0]!;
    const pay = (tip: number, extra: Record<string, unknown> = {}) => call<Err>("POST", `/v1/checks/${check.id}/payments`, { token: m.cashier.token, body: { payment_id: randomUUID(), tender_type_id: ids.card, amount: check.balance, tip_cents: tip, ...extra } });
    const huge = await pay(9_999_999);
    expect(huge.status).toBe(400);
    expect(huge.body.code).toBe("validation");
    const bill = `$${(check.totals.total / 100).toFixed(2)}`;
    expect(huge.body.message).toBe(`A tip of $99,999.99 is more than the bill of ${bill}`);
    expect(huge.body.remedy).toBe(`Enter a tip of ${bill} or less.`);
    expect(huge.body.details).toMatchObject({ max_tip_cents: check.totals.total });
    // The bound is the bill, not this payment: a part payment may carry the tip for the whole bill.
    const part = await call<Err>("POST", `/v1/checks/${check.id}/payments`, { token: m.cashier.token, body: { payment_id: randomUUID(), tender_type_id: ids.card, amount: 100, tip_cents: check.totals.total, dry_run: true } });
    expect(part.status, JSON.stringify(part.body)).toBe(200);
    expect((await pay(check.totals.total + 1, { dry_run: true })).status).toBe(400);
    // All of a bill's tips together are capped: a second part payment cannot tip the bill again.
    const first = await call<Err>("POST", `/v1/checks/${check.id}/payments`, { token: m.cashier.token, body: { payment_id: randomUUID(), tender_type_id: ids.card, amount: 100, tip_cents: check.totals.total - 50 } });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const second = await call<Err>("POST", `/v1/checks/${check.id}/payments`, { token: m.cashier.token, body: { payment_id: randomUUID(), tender_type_id: ids.card, amount: check.balance - 100, tip_cents: 51 } });
    expect(second.status).toBe(400);
    expect(second.body.remedy).toBe("Enter a tip of $0.50 or less.");
    expect(second.body.details).toMatchObject({ max_tip_cents: 50 });
    expect((await call("POST", `/v1/checks/${check.id}/payments`, { token: m.cashier.token, body: { payment_id: randomUUID(), tender_type_id: ids.card, amount: check.balance - 100, tip_cents: 50 } })).status).toBe(200);
  });
});

describe("a cash tip above the bill is refused as a tip (A-6, cash)", () => {
  it("a huge cash tip with too little cash handed over names the tip, not the cash short", async () => {
    const o = await call<{ data: Snap }>("POST", "/v1/orders", { token: m.cashier.token, body: { order_id: randomUUID(), order_type: "takeaway", takeaway_ref: "T", outlet_id: m.outletId, brand_id: m.brandId } });
    const s = await call<{ data: Snap }>("POST", `/v1/orders/${o.body.data.id}/lines`, { token: m.cashier.token, body: { lines: [{ line_id: randomUUID(), product_id: ids.burger, quantity: 1 }] } });
    const check = s.body.data.checks[0]!;
    const r = await call<Err>("POST", `/v1/checks/${check.id}/payments`, { token: m.cashier.token, body: { payment_id: randomUUID(), tender_type_id: ids.cash, amount: check.balance, tendered: 5000, tip_cents: 9_999_999 } });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe(`A tip of $99,999.99 is more than the bill of $${(check.totals.total / 100).toFixed(2)}`);
    expect(r.body.details).toMatchObject({ max_tip_cents: check.totals.total });
  });
});

describe("a tip given back on an invoiced bill", () => {
  it("issues no credit note when only the tip goes back: the invoice never held the tip", async () => {
    const s = await tippedSale("card", 400);
    const check = s.checks[0]!;
    const inv = await call("POST", `/v1/checks/${check.id}/invoice`, { token: m.manager.token, body: {} });
    expect(inv.status, JSON.stringify(inv.body)).toBeLessThan(300);
    const byItem = await call<{ refund: { credit_note_no: string | null; tip: number } }>("POST", `/v1/checks/${check.id}/refunds`, { token: m.manager.token, body: { refund_id: randomUUID(), request: { kind: "lines", lines: s.lines.map((l) => ({ line_id: l.id, quantity: l.name === "Burger" ? 2 : 1 })) }, reason: "Guest complaint", print: false } });
    expect(byItem.status, JSON.stringify(byItem.body)).toBe(201);
    expect(byItem.body.refund.credit_note_no).not.toBeNull();
    const [before] = await db.sql<{ n: number }[]>`select count(*)::int as n from refunds where merchant_id = ${m.merchantId} and credit_note_no is not null`;
    const tipOnly = await call<{ refund: { credit_note_no: string | null; tip: number; totals: { total: number } } }>("POST", `/v1/checks/${check.id}/refunds`, { token: m.manager.token, body: { refund_id: randomUUID(), request: { kind: "full" }, reason: "Guest complaint", print: false } });
    expect(tipOnly.status, JSON.stringify(tipOnly.body)).toBe(201);
    expect([tipOnly.body.refund.totals.total, tipOnly.body.refund.tip, tipOnly.body.refund.credit_note_no]).toEqual([0, 400, null]);
    const [after] = await db.sql<{ n: number }[]>`select count(*)::int as n from refunds where merchant_id = ${m.merchantId} and credit_note_no is not null`;
    expect(after!.n).toBe(before!.n);
  });
});

describe("refund refusals speak the merchant's currency (B-F10)", () => {
  it("an amount above what is left names it in dollars; an item already refunded says so, and the bill shows how many were refunded", async () => {
    const s = await tippedSale("card", 0);
    const check = s.checks[0]!;
    const over = await quote(check.id, { kind: "amount", amount: check.totals.total + 1 });
    expect(over.status).toBe(422);
    const left = `$${(check.totals.total / 100).toFixed(2)}`;
    expect(over.body.message).toBe(`Only ${left} can still be refunded on this bill`);
    expect(over.body.remedy).toBe(`Enter ${left} or less.`);

    const soda = s.lines.find((l) => l.name === "Soda")!;
    const burger = s.lines.find((l) => l.name === "Burger")!;
    const r = await refund(check.id, { kind: "lines", lines: [{ line_id: soda.id, quantity: 1 }, { line_id: burger.id, quantity: 1 }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    // The bill tells the refund sheet what is left of each item, so it never offers a refunded one again.
    const alloc = (id: string) => r.body.data.checks[0]!.allocations.find((a) => a.line_id === id)!.refunded_quantity;
    expect([alloc(soda.id), alloc(burger.id)]).toEqual([1, 1]);
    const sodaAgain = await quote(check.id, { kind: "lines", lines: [{ line_id: soda.id, quantity: 1 }] });
    expect(sodaAgain.body.message).toBe("Soda has already been refunded");
    expect(sodaAgain.body.remedy).toBe("Pick another item, or refund by amount.");
    const burgers = await quote(check.id, { kind: "lines", lines: [{ line_id: burger.id, quantity: 2 }] });
    expect(burgers.body.message).toBe("Only 1 of 2 Burger can still be refunded");
    expect(burgers.body.remedy).toBe("Refund 1 or fewer.");
  });
});

describe("the reports give every figure a consistent presentation needs (E-M8)", () => {
  it("before refunds, net + fees + tax = collected; the refunds split the same way; collected after refunds is collected less refunds", async () => {
    const z = await zReport();
    expect(z.refunds.count).toBeGreaterThan(0);
    expect(z.sales.net_before_refunds + z.sales.fees + z.sales.tax).toBe(z.sales.total);
    expect(z.refunds.net + z.refunds.fees + z.refunds.tax).toBe(z.refunds.amount);
    expect(z.refunds.net).toBe(z.sales.refunds);
    expect(z.sales.net_before_refunds - z.refunds.net).toBe(z.sales.net);
    expect(z.sales.total_after_refunds).toBe(z.sales.total - z.refunds.amount);
    // The us preset taxes every item, so a refund of items gives tax back.
    expect(z.refunds.tax).toBeGreaterThan(0);
    const s = await salesSummary();
    expect(s.totals.net_before_refunds + s.totals.fees + s.totals.tax).toBe(s.totals.total);
    expect(s.refunds.net + s.refunds.fees + s.refunds.tax).toBe(s.refunds.amount);
    expect(s.totals.net_before_refunds - s.refunds.net).toBe(s.totals.net);
    expect(s.totals.total_after_refunds).toBe(s.totals.total - s.refunds.amount);
    expect([s.totals.total, s.refunds.amount, s.refunds.tax, s.refunds.tips]).toEqual([z.sales.total, z.refunds.amount, z.refunds.tax, z.refunds.tips]);
  });
});

describe("the reports give the tax due by component", () => {
  it("tax due is the tax charged less the tax refunded, component by component, in the Z-report and the sales summary", async () => {
    type Tax = { name: string; bps: number; amount: number };
    const z = (await call<{ data: { sales: { tax: number; taxes: Tax[] }; refunds: { tax: number; taxes: Tax[] }; tax_due: Tax[] } }>("GET", `/v1/outlets/${m.outletId}/z-report`, { token: m.manager.token })).body.data;
    expect(z.refunds.tax).toBeGreaterThan(0);
    expect(z.tax_due.length).toBeGreaterThan(0);
    for (const charged of z.sales.taxes) {
      const back = z.refunds.taxes.find((t) => t.name === charged.name && t.bps === charged.bps)?.amount ?? 0;
      expect(z.tax_due.find((t) => t.name === charged.name && t.bps === charged.bps)?.amount, charged.name).toBe(charged.amount - back);
    }
    expect(z.tax_due.reduce((n, t) => n + t.amount, 0)).toBe(z.sales.tax - z.refunds.tax);
    const s = (await call<{ data: { totals: { tax: number }; refunds: { tax: number }; tax_due: Tax[] } }>("GET", `/v1/reports/sales-summary?outlet_id=${m.outletId}`, { token: m.manager.token })).body.data;
    expect(s.tax_due).toEqual(z.tax_due);
    expect(s.tax_due.reduce((n, t) => n + t.amount, 0)).toBe(s.totals.tax - s.refunds.tax);
  });
});

describe("a manager's approval of a refund covers the tip given back", () => {
  it("a cashier's tip-only refund needs an approval that names the tip; the audit records the tip", async () => {
    const s = await tippedSale("card", 650);
    const check = s.checks[0]!;
    const byItem = await refund(check.id, { kind: "lines", lines: s.lines.map((l) => ({ line_id: l.id, quantity: l.name === "Burger" ? 2 : 1 })) });
    expect(byItem.status, JSON.stringify(byItem.body)).toBe(201);
    const grant = (args: Record<string, unknown>) => call<{ data: { override_id: string } }>("POST", "/v1/overrides", { token: m.cashier.token, body: { action: "refunds.create", target_kind: "check", target_id: check.id, approver_pin: "222222", outlet_id: m.outletId, args } });
    const asCashier = (overrideId: string) => call<{ refund: { id: string; tip: number; totals: { total: number } } } & Err>("POST", `/v1/checks/${check.id}/refunds`, { token: m.cashier.token, body: { refund_id: randomUUID(), request: { kind: "full" }, reason: "Guest complaint", print: false, override_id: overrideId } });

    // Approved as "total 0", the manager never saw the tip: refused.
    const blind = await grant({ request: { kind: "full" }, total: 0 });
    expect(blind.status, JSON.stringify(blind.body)).toBe(201);
    const refused = await asCashier(blind.body.data.override_id);
    expect(refused.status).toBe(403);
    expect(refused.body.message).toBe("Manager approval was for a different action");

    const named = await grant({ request: { kind: "full" }, total: 0, tip: 650 });
    expect(named.status, JSON.stringify(named.body)).toBe(201);
    const ok = await asCashier(named.body.data.override_id);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect([ok.body.refund.totals.total, ok.body.refund.tip]).toEqual([0, 650]);
    const [audit] = await db.sql<{ details: { tip?: number; total?: number } }[]>`select details from audit_log where merchant_id = ${m.merchantId} and action = 'refunds.create' and details->>'refund_id' = ${ok.body.refund.id}`;
    expect(audit!.details).toMatchObject({ total: 0, tip: 650 });
  });
});

describe("the refund sheet's refunded quantities are per bill (B step 26)", () => {
  it("on an order split in two, an item refunded from one bill shows as refunded there only, and a refund by amount refunds no item", async () => {
    const o = await call<{ data: Snap }>("POST", "/v1/orders", { token: m.cashier.token, body: { order_id: randomUUID(), order_type: "takeaway", takeaway_ref: "T", outlet_id: m.outletId, brand_id: m.brandId } });
    const orderId = o.body.data.id;
    await call("POST", `/v1/orders/${orderId}/lines`, { token: m.cashier.token, body: { lines: [{ line_id: randomUUID(), product_id: ids.burger, quantity: 2 }, { line_id: randomUUID(), product_id: ids.soda, quantity: 1 }] } });
    const split = await call<{ data: Snap }>("POST", `/v1/orders/${orderId}/checks/split-even`, { token: m.cashier.token, body: { n: 2 } });
    expect(split.status, JSON.stringify(split.body)).toBe(200);
    let snap = split.body.data;
    for (const c of snap.checks) {
      const paid = await call<{ data: Snap }>("POST", `/v1/checks/${c.id}/payments`, { token: m.cashier.token, body: { payment_id: randomUUID(), tender_type_id: ids.card, amount: c.balance } });
      expect(paid.status, JSON.stringify(paid.body)).toBe(200);
      snap = paid.body.data;
    }
    const [b1, b2] = snap.checks;
    const burger = snap.lines.find((l) => l.name === "Burger")!;
    const soda = snap.lines.find((l) => l.name === "Soda")!;
    const refunded = (s: Snap, checkId: string, lineId: string) => s.checks.find((c) => c.id === checkId)!.allocations.find((a) => a.line_id === lineId)!.refunded_quantity;
    expect([refunded(snap, b1!.id, burger.id), refunded(snap, b2!.id, burger.id)]).toEqual([0, 0]);

    const one = await refund(b1!.id, { kind: "lines", lines: [{ line_id: burger.id, quantity: 1 }] });
    expect(one.status, JSON.stringify(one.body)).toBe(201);
    expect([refunded(one.body.data, b1!.id, burger.id), refunded(one.body.data, b2!.id, burger.id), refunded(one.body.data, b1!.id, soda.id)]).toEqual([1, 0, 0]);
    const byAmount = await refund(b2!.id, { kind: "amount", amount: 100 });
    expect(byAmount.status, JSON.stringify(byAmount.body)).toBe(201);
    expect([refunded(byAmount.body.data, b2!.id, burger.id), refunded(byAmount.body.data, b2!.id, soda.id)]).toEqual([0, 0]);
    // The other bill can still give back both of its burger shares; this one has one left, then none.
    expect((await quote(b2!.id, { kind: "lines", lines: [{ line_id: burger.id, quantity: 2 }] })).status).toBe(200);
    const two = await refund(b1!.id, { kind: "lines", lines: [{ line_id: burger.id, quantity: 1 }] });
    expect(refunded(two.body.data, b1!.id, burger.id)).toBe(2);
    const again = await quote(b1!.id, { kind: "lines", lines: [{ line_id: burger.id, quantity: 1 }] });
    expect([again.body.message, again.body.remedy]).toEqual(["Burger has already been refunded", "Pick another item, or refund by amount."]);
    // The order snapshot any client reloads says the same.
    const reloaded = await call<{ data: Snap }>("GET", `/v1/orders/${orderId}`, { token: m.cashier.token });
    expect([refunded(reloaded.body.data, b1!.id, burger.id), refunded(reloaded.body.data, b2!.id, burger.id)]).toEqual([2, 0]);
  });
});

describe("after tips are given back the Z-report still reconciles", () => {
  it("tenders keep what was taken, refunds hold the bills' share and the tips, and the drawer counts the cash tips given back once", async () => {
    // Every sale and refund above is on this business day: check each Z-report figure against the rows it sums.
    const z = (await call<{ data: { scope: { business_date: string }; sales: { total: number }; tenders: { amount: number; tips: number; is_cash: boolean }[]; tenders_summary: { tips: number; cash: number; non_cash: number }; refunds: Refunds; cash: { float: number; cash_payments: number; rounding: number; tips: number; refunds: number; expected: number }; reconciliation: { tenders: number; sales_total: number; paid_on_other_orders: number; paid_elsewhere: number } } }>("GET", `/v1/outlets/${m.outletId}/z-report`, { token: m.manager.token })).body.data;
    const [taken] = await db.sql<{ amount: string; tips: string; cash_tips: string }[]>`select coalesce(sum(amount),0) as amount, coalesce(sum(tip_cents),0) as tips, coalesce(sum(tip_cents) filter (where is_cash),0) as cash_tips from payments where merchant_id = ${m.merchantId} and status = 'recorded'`;
    const [back] = await db.sql<{ count: number; amount: string; tips: string }[]>`select count(*)::int as count, coalesce(sum(total),0) as amount, coalesce(sum(tip),0) as tips from refunds where merchant_id = ${m.merchantId}`;
    const [cashBack] = await db.sql<{ amount: string; tips: string }[]>`select coalesce(sum(amount + rounding_cents + tip_cents),0) as amount, coalesce(sum(tip_cents),0) as tips from refund_tenders where merchant_id = ${m.merchantId} and is_cash`;
    expect(Number(back!.tips)).toBeGreaterThan(0);
    expect(Number(cashBack!.tips)).toBeGreaterThan(0);

    // Refunds never change the tenders: they are what was taken, tips included in their own column.
    const tenderSum = z.tenders.reduce((s, t) => s + t.amount, 0);
    expect(tenderSum).toBe(Number(taken!.amount));
    expect(z.tenders_summary.tips).toBe(Number(taken!.tips));
    expect(z.tenders_summary.cash + z.tenders_summary.non_cash).toBe(tenderSum);
    expect(z.reconciliation.tenders).toBe(tenderSum);
    expect(z.reconciliation.tenders).toBe(z.reconciliation.sales_total + z.reconciliation.paid_on_other_orders - z.reconciliation.paid_elsewhere);
    expect(z.reconciliation.sales_total).toBe(z.sales.total);

    // The refunds row: the bills' share in `amount`, the tips given back beside it, never inside it.
    expect([z.refunds.count, z.refunds.amount, z.refunds.tips]).toEqual([back!.count, Number(back!.amount), Number(back!.tips)]);

    // The drawer: cash tips taken stay in it, cash tips given back come out of it, each once.
    expect(z.cash.tips).toBe(Number(taken!.cash_tips));
    expect(z.cash.refunds).toBe(Number(cashBack!.amount));
    expect(z.cash.expected).toBe(z.cash.float + z.cash.cash_payments + z.cash.rounding + z.cash.tips - z.cash.refunds);

    // The open shift's own report closes with no variance when the drawer holds what the register expects.
    const [shift] = await db.sql<{ id: string }[]>`select id from shifts where outlet_id = ${m.outletId} and status = 'open'`;
    const [inShift] = await db.sql<{ amount: string }[]>`select coalesce(sum(t.amount + t.rounding_cents + t.tip_cents),0) as amount from refund_tenders t join refunds r on r.id = t.refund_id where r.shift_id = ${shift!.id} and t.is_cash`;
    // The day's drawer is both shifts': this one is expected to hold the day's cash less what the closed one held.
    const [earlier] = await db.sql<{ expected: string; counted: string }[]>`select coalesce(sum(expected_cash_cents),0) as expected, coalesce(sum(counted_cash_cents),0) as counted from shifts where outlet_id = ${m.outletId} and status = 'closed'`;
    expect(Number(earlier!.counted)).toBe(Number(earlier!.expected));
    const counted = z.cash.expected - Number(earlier!.expected);
    const closed = await call<{ data: { report: { cash: { refunds: number; expected: number; variance: number; float: number; cash_payments: number; rounding: number; tips: number } } } }>("POST", `/v1/shifts/${shift!.id}/close`, { token: m.manager.token, body: { counted_cash_cents: counted } });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const c = closed.body.data.report.cash;
    expect(c.refunds).toBe(Number(inShift!.amount));
    expect(c.expected).toBe(c.float + c.cash_payments + c.rounding + c.tips - c.refunds);
    expect([c.expected, c.variance]).toEqual([counted, 0]);
  });
});
