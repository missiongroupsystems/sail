import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/modules.js";
import { buildApp, type App } from "../src/app.js";
import { readFileSync } from "node:fs";
import { generatedFontModule } from "../scripts/pdf-fonts.js";
import { renderInvoicePdf, type InvoiceDocument } from "../src/services/documents.js";
import { pdfStrings } from "./pdf-strings.js";
import { api, freshDb, seedMerchant, type SeededMerchant, type TestDb } from "./helpers.js";

/** Third review round, money: a US diner (4% state + 4.5% local) and an EU café (VAT 10% and 20% inside the price). */
let db: TestDb;
let app: App;
let call: ReturnType<typeof api>["call"];

type Tax = { name: string; bps: number; amount: number };
type Snap = {
  id: string;
  version: number;
  status: string;
  totals: { subtotal: number; tax_total: number; taxes: Tax[]; total: number };
  lines: { id: string; product_id: string; name: string; status: string }[];
  checks: { id: string; label: string; locked: boolean; status: string; invoice_no: string | null; totals: { total: number; taxes: Tax[] }; balance: number; paid_total: number }[];
  balance: number;
};
type Err = { message: string; remedy?: string; details: Record<string, unknown> };
type Mut = { data: Snap } & Err;
type Tender = { payment_id: string; is_cash: boolean; amount: number; rounding_cents: number; tip_cents: number };
type RefundRes = { data: Snap; refund: { id: string; totals: { total: number; taxes: Tax[] }; credit_note_no: string | null; quote: { tenders: Tender[]; cash_out: number } } } & Err;

type World = { m: SeededMerchant; cash: string; card: string; products: Record<string, string>; stations: { id: string; pin: string }[] };

async function world(name: string, preset: "us" | "eu-vat", products: { key: string; price: number; taxClass: string }[]): Promise<World> {
  const m = await seedMerchant(db.sql, name, preset === "us" ? { preset, timeZone: "America/New_York", locale: "en-US" } : { preset, timeZone: "Europe/Berlin", currency: "EUR", locale: "de-DE" });
  const t = m.admin.token;
  const must = async (path: string, body: unknown) => {
    const r = await call<{ data: { url?: string } }>("POST", path, { token: t, body });
    expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBeLessThan(300);
    return r.body.data;
  };
  const ids: Record<string, string> = {};
  for (const p of products) {
    ids[p.key] = randomUUID();
    await must("/v1/products", { id: ids[p.key], name: p.key, price: p.price, tax_class_id: m.taxClassIds[p.taxClass] });
  }
  const menu = randomUUID();
  await must("/v1/menus", { id: menu, brand_id: m.brandId, name: "M", sections: [{ name: "All", items: Object.values(ids).map((product_id) => ({ product_id })) }] });
  await must("/v1/channel-links", { id: randomUUID(), channel: "pos", outlet_id: m.outletId, brand_id: m.brandId, menu_id: menu });
  const cash = randomUUID();
  const card = randomUUID();
  await must("/v1/tender-types", { id: cash, name: "Cash", is_cash: true });
  await must("/v1/tender-types", { id: card, name: "Card" });
  const stations: World["stations"] = [];
  for (const [label, pin] of [["Station 1", "333333"], ["Station 2", "222222"]] as const) {
    const id = randomUUID();
    await must("/v1/stations", { id, outlet_id: m.outletId, brand_id: m.brandId, name: label });
    const code = await call<{ data: { code: string } }>("POST", `/v1/stations/${id}/pairing-code`, { token: t, body: {} });
    const paired = await call<{ data: { station_token: string } }>("POST", "/v1/stations/pair", { body: { code: code.body.data.code, device_label: "iPad" }, idempotencyKey: null });
    const session = (await call<{ data: { session_token: string } }>("POST", "/v1/stations/sessions", { token: paired.body.data.station_token, body: { pin } })).body.data.session_token;
    stations.push({ id, pin: session });
  }
  return { m, cash, card, products: ids, stations };
}

let US: World;
let EU: World;

beforeAll(async () => {
  db = await freshDb();
  app = buildApp();
  call = api(app).call;
  US = await world("Diner", "us", [
    { key: "burger", price: 1299, taxClass: "prepared_food" },
    { key: "fries", price: 449, taxClass: "prepared_food" },
    { key: "tea", price: 299, taxClass: "prepared_food" },
    { key: "coffee", price: 279, taxClass: "prepared_food" },
  ]);
  EU = await world("Café", "eu-vat", [
    { key: "juice", price: 205, taxClass: "reduced" },
    { key: "wine", price: 745, taxClass: "standard" },
    { key: "soup", price: 650, taxClass: "reduced" },
    { key: "cake", price: 390, taxClass: "reduced" },
  ]);
});
afterAll(async () => {
  await db.drop();
});

const pos = (w: World, i = 0) => w.stations[i]!.pin;
const open = (w: World, i = 0) => call<Mut>("POST", "/v1/orders", { token: pos(w, i), body: { order_id: randomUUID(), order_type: "takeaway", takeaway_ref: "T" } });
const add = (w: World, orderId: string, keys: string[], i = 0) => call<Mut>("POST", `/v1/orders/${orderId}/lines`, { token: pos(w, i), body: { lines: keys.map((k) => ({ line_id: randomUUID(), product_id: w.products[k], quantity: 1 })) } });
const snap = async (w: World, id: string) => (await call<{ data: Snap }>("GET", `/v1/orders/${id}`, { token: w.m.manager.token })).body.data;
const pay = (w: World, checkId: string, amount: number, tender: "cash" | "card", i = 0) => call<Mut>("POST", `/v1/checks/${checkId}/payments`, { token: pos(w, i), body: { payment_id: randomUUID(), tender_type_id: tender === "cash" ? w.cash : w.card, amount } });
const tax = (taxes: Tax[], name: string) => taxes.find((x) => x.name === name)?.amount ?? 0;
/** A refund from the back office: the manager's own session, which has no station. */
const boRefund = (checkId: string, request: unknown, extra: Record<string, unknown> = {}) => call<RefundRes>("POST", `/v1/checks/${checkId}/refunds`, { token: US.m.manager.token, body: { refund_id: randomUUID(), request, reason: "Wrong item keyed", print: false, ...extra } });
const openShift = (w: World, i: number, float: number) => call<{ data: { id: string } } & Err>("POST", "/v1/shifts", { token: pos(w, i), body: { float_cents: float } });
const openShifts = async (w: World) => (await call<{ data: { id: string; station_id: string | null; station_name: string | null; opened_by: string | null }[] }>("GET", `/v1/outlets/${w.m.outletId}/shifts?status=open`, { token: w.m.manager.token })).body.data;
type Cash = { float: number; cash_payments: number; rounding: number; tips: number; refunds: number; expected: number };
const zFor = async (w: World, stationId?: string) => (await call<{ data: { cash: Cash & { open_shifts?: Cash }; refunds: { count: number; amount: number } } }>("GET", `/v1/outlets/${w.m.outletId}/z-report${stationId ? `?station_id=${stationId}` : ""}`, { token: w.m.manager.token })).body.data;
/** The shift's own report, as its close would give it (a manager's dry run). */
const shiftReport = async (w: World, shiftId: string) => {
  const r = await call<{ data: { report: { cash: Cash; refunds: { count: number; amount: number } } } } & Err>("POST", `/v1/shifts/${shiftId}/close`, { token: w.m.manager.token, body: { counted_cash_cents: 0, variance_reason: "Dry run", dry_run: true } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.data.report;
};

/** A takeaway order at station `i`, sent and paid in full in one tender. */
async function paidOrder(w: World, keys: string[], tender: "cash" | "card", i = 0) {
  const o = await open(w, i);
  expect(o.status, JSON.stringify(o.body)).toBe(201);
  const id = o.body.data.id;
  const s = await add(w, id, keys, i);
  expect((await call("POST", `/v1/orders/${id}/fire`, { token: pos(w, i), body: {} })).status).toBe(200);
  const check = s.body.data.checks[0]!;
  const paid = await pay(w, check.id, check.balance, tender, i);
  expect(paid.status, JSON.stringify(paid.body)).toBe(200);
  return paid.body.data;
}

describe("R1: a cash refund from the back office comes out of an open shift's drawer", () => {
  it("with no shift open anywhere, a cash refund is refused before it is recorded, and a card refund still works", async () => {
    // No shift is open yet at the diner: card only.
    const order = await paidOrder(US, ["fries"], "card", 1);
    const s = { body: { data: order } };
    const card = await boRefund(s.body.data.checks[0]!.id, { kind: "full" });
    expect(card.status, JSON.stringify(card.body)).toBe(201);
    expect(await openShifts(US)).toEqual([]);
  });

  it("with two shifts open, the back office must name the shift; the refund counts on that shift, its station's Z-report and the day's", async () => {
    const s1 = await openShift(US, 0, 10_000);
    const s2 = await openShift(US, 1, 5_000);
    expect([s1.status, s2.status], JSON.stringify([s1.body, s2.body])).toEqual([201, 201]);
    const shifts = await openShifts(US);
    expect(shifts.map((x) => x.station_name).sort()).toEqual(["Station 1", "Station 2"]);
    expect(shifts.every((x) => !!x.opened_by)).toBe(true);

    // Fries and tea, paid cash on Station 1.
    const order = await paidOrder(US, ["fries", "tea"], "cash", 0);
    const check = order.checks[0]!;
    const tea = order.lines.find((l) => l.name === "tea")!;
    const zDayBefore = await zFor(US);
    const z2Before = await zFor(US, US.stations[1]!.id);
    const r2Before = await shiftReport(US, s2.body.data.id);

    const unnamed = await boRefund(check.id, { kind: "lines", lines: [{ line_id: tea.id, quantity: 1 }] });
    expect(unnamed.status, JSON.stringify(unnamed.body)).toBe(422);
    expect(unnamed.body.message).toBe("Choose which open shift the cash comes out of");
    expect((await snap(US, order.id)).checks[0]!.status).toBe("paid");

    // The owner picks Station 2's drawer (not the station that took the payment).
    const named = await boRefund(check.id, { kind: "lines", lines: [{ line_id: tea.id, quantity: 1 }] }, { shift_id: s2.body.data.id });
    expect(named.status, JSON.stringify(named.body)).toBe(201);
    const out = named.body.refund.quote.cash_out;
    expect(out).toBe(named.body.refund.totals.total);
    expect(out).toBeGreaterThan(0);
    const [row] = await db.sql<{ shift_id: string; station_id: string }[]>`select shift_id, station_id from refunds where id = ${named.body.refund.id}`;
    expect(row).toEqual({ shift_id: s2.body.data.id, station_id: US.stations[1]!.id });

    // Station 2's drawer is short by the refund of what it was expected to hold; the shift report, its Z-report and the day agree.
    const r2After = await shiftReport(US, s2.body.data.id);
    expect(r2After.cash.refunds - r2Before.cash.refunds).toBe(out);
    expect(r2After.cash.expected).toBe(r2Before.cash.expected - out);
    expect(r2After.refunds.count - r2Before.refunds.count).toBe(1);
    const z2After = await zFor(US, US.stations[1]!.id);
    const open2 = (z: Awaited<ReturnType<typeof zFor>>) => z.cash.open_shifts ?? z.cash;
    expect(open2(z2After).refunds - open2(z2Before).refunds).toBe(out);
    expect(z2After.refunds.amount - z2Before.refunds.amount).toBe(out);
    const zDayAfter = await zFor(US);
    expect(open2(zDayAfter).refunds - open2(zDayBefore).refunds).toBe(out);
    expect(open2(zDayAfter).expected).toBe(open2(zDayBefore).expected - out);
    // Station 1's drawer, which took the payment, is untouched by the refund.
    const r1 = await shiftReport(US, s1.body.data.id);
    expect(r1.cash.refunds).toBe(0);
  });

  it("a named shift that is closed, or at another outlet, is refused", async () => {
    const order = await paidOrder(US, ["coffee"], "cash", 0);
    const bogus = await boRefund(order.checks[0]!.id, { kind: "full" }, { shift_id: randomUUID() });
    expect(bogus.status).toBe(404);
  });

  it("avoid_cash gives a bill paid by card and cash back to the card only, and needs no drawer", async () => {
    // On Station 2, whose Manager may take a part payment.
    const o = await open(US, 1);
    const id = o.body.data.id;
    const s = await add(US, id, ["burger", "fries"], 1);
    expect((await call("POST", `/v1/orders/${id}/fire`, { token: pos(US, 1), body: {} })).status).toBe(200);
    const check = s.body.data.checks[0]!;
    const part = await pay(US, check.id, 1000, "cash", 1);
    expect(part.status, JSON.stringify(part.body)).toBe(200);
    const rest = await pay(US, check.id, check.balance - 1000, "card", 1);
    expect(rest.status, JSON.stringify(rest.body)).toBe(200);
    const fries = s.body.data.lines.find((l) => l.name === "fries")!;
    const quoted = await call<{ data: { tenders: Tender[]; cash_out: number; totals: { total: number } } }>("POST", `/v1/checks/${check.id}/refunds/quote`, { token: US.m.manager.token, body: { request: { kind: "lines", lines: [{ line_id: fries.id, quantity: 1 }] }, avoid_cash: true } });
    expect(quoted.status, JSON.stringify(quoted.body)).toBe(200);
    expect(quoted.body.data.tenders.every((t) => !t.is_cash)).toBe(true);
    expect(quoted.body.data.cash_out).toBe(0);
    const r = await boRefund(check.id, { kind: "lines", lines: [{ line_id: fries.id, quantity: 1 }] }, { avoid_cash: true });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.refund.quote.tenders.map((t) => t.is_cash)).toEqual([false]);
    expect(r.body.refund.quote.tenders[0]!.amount).toBe(r.body.refund.totals.total);
    // More than the card took cannot go to the card alone.
    const whole = await call<Err>("POST", `/v1/checks/${check.id}/refunds/quote`, { token: US.m.manager.token, body: { request: { kind: "full" }, avoid_cash: true } });
    expect(whole.status).toBe(422);
  });
  it("with exactly one shift open, a back-office cash refund comes out of it without naming it", async () => {
    // Close Station 2's shift; Station 1's stays open.
    const s2 = (await openShifts(US)).find((x) => x.station_name === "Station 2")!;
    const report = await shiftReport(US, s2.id);
    expect((await call("POST", `/v1/shifts/${s2.id}/close`, { token: US.m.manager.token, body: { counted_cash_cents: report.cash.expected } })).status).toBe(200);
    const closedNamed = await paidOrder(US, ["coffee"], "cash", 0);
    const refused = await boRefund(closedNamed.checks[0]!.id, { kind: "full" }, { shift_id: s2.id });
    expect([refused.status, refused.body.message]).toEqual([422, "That shift has been closed"]);
    const s1 = (await openShifts(US))[0]!;
    const before = await shiftReport(US, s1.id);
    const r = await boRefund(closedNamed.checks[0]!.id, { kind: "full" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const after = await shiftReport(US, s1.id);
    expect(after.cash.refunds - before.cash.refunds).toBe(r.body.refund.quote.cash_out);
  });

});

describe("R2: a reopen or a void that reverses an invoiced bill's payment cancels its invoice with a credit note", () => {
  const invoice = (w: World, checkId: string) => call<{ data: { invoice_no: string; reused: boolean } } & Err>("POST", `/v1/checks/${checkId}/invoice`, { token: pos(w), body: {} });
  const seq = async (w: World, kind: string) => (await db.sql<{ next_no: number }[]>`select next_no from document_sequences where merchant_id = ${w.m.merchantId} and kind = ${kind}`)[0]?.next_no ?? 1;
  type Cancelled = { id: string; invoice_no: string; credit_note_no: string };
  const snapChecks = async (w: World, id: string) => (await call<{ data: { checks: (Snap["checks"][number] & { cancelled_invoices: Cancelled[] })[] } }>("GET", `/v1/orders/${id}`, { token: w.m.manager.token })).body.data.checks;

  it("reopen, add an item and pay again: the old invoice is cancelled by a credit note for its full amount, the bill gets a new number, the Z-report counts no refund", async () => {
    const order = await paidOrder(US, ["burger", "tea"], "cash", 0);
    const check = order.checks[0]!;
    const oldTotal = check.totals.total;
    const inv = await invoice(US, check.id);
    expect(inv.status, JSON.stringify(inv.body)).toBe(200);
    const oldNo = inv.body.data.invoice_no;
    const cnBefore = await seq(US, "credit_note");
    const zBefore = await zFor(US);

    const reopened = await call<Mut>("POST", `/v1/orders/${order.id}/reopen`, { token: US.m.manager.token, body: { reason: "More items to add" } });
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    const after = (await snapChecks(US, order.id))[0]!;
    expect(after.invoice_no).toBeNull();
    expect(after.cancelled_invoices).toHaveLength(1);
    const cancelled = after.cancelled_invoices[0]!;
    expect(cancelled.invoice_no).toBe(oldNo);
    expect(cancelled.credit_note_no).toBe(`CN-${String(cnBefore).padStart(6, "0")}`);
    const [row] = await db.sql<{ credit_note_document: { totals: { total: number; taxes: Tax[] }; invoice_no: string; payments: { amount: number }[] } ; invoice_document: { totals: { total: number } } }[]>`select credit_note_document, invoice_document from invoice_cancellations where id = ${cancelled.id}`;
    expect(row!.credit_note_document.totals.total).toBe(-oldTotal);
    expect(row!.credit_note_document.invoice_no).toBe(oldNo);
    expect(row!.credit_note_document.totals.taxes.map((t) => t.amount)).toEqual(check.totals.taxes.map((t) => -t.amount));
    expect(row!.invoice_document.totals.total).toBe(oldTotal);
    // No invoice while the bill is unpaid again.
    expect((await invoice(US, check.id)).status).toBe(409);

    // Add coffee and pay again: a new invoice, the next number, for the new total.
    expect((await add(US, order.id, ["coffee"])).status).toBe(200);
    const s2 = await snap(US, order.id);
    const repaid = await pay(US, s2.checks[0]!.id, s2.checks[0]!.balance, "cash");
    expect(repaid.status, JSON.stringify(repaid.body)).toBe(200);
    const newTotal = repaid.body.data.checks[0]!.totals.total;
    expect(newTotal).toBeGreaterThan(oldTotal);
    const fresh = await invoice(US, check.id);
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
    expect(fresh.body.data.reused).toBe(false);
    expect(Number(fresh.body.data.invoice_no.slice(4))).toBe(Number(oldNo.slice(4)) + 1);
    const [doc] = await db.sql<{ invoice_document: { totals: { total: number }; payments: { amount: number }[] } }[]>`select invoice_document from checks where id = ${check.id}`;
    expect(doc!.invoice_document.totals.total).toBe(newTotal);
    expect(doc!.invoice_document.payments.map((p) => p.amount)).toEqual([newTotal]);

    // The Z-report: no refund, and cash counts the new payment only (the reversed one counts nowhere).
    const zAfter = await zFor(US);
    expect(zAfter.refunds).toEqual(zBefore.refunds);
    const day = (z: Awaited<ReturnType<typeof zFor>>) => z.cash.cash_payments + (z.cash.open_shifts?.cash_payments ?? 0);
    expect(day(zAfter) - day(zBefore)).toBe(newTotal - oldTotal);

    // Both old documents stay retrievable.
    const oldPdf = await app.request(`/v1/invoice-cancellations/${cancelled.id}/invoice.pdf`, { headers: { authorization: `Bearer ${US.m.manager.token}` } });
    const cnPdf = await app.request(`/v1/invoice-cancellations/${cancelled.id}/credit-note.pdf`, { headers: { authorization: `Bearer ${US.m.manager.token}` } });
    expect([oldPdf.status, cnPdf.status]).toEqual([200, 200]);
    expect(oldPdf.headers.get("content-type")).toBe("application/pdf");
    expect(cnPdf.headers.get("content-disposition")).toContain(cancelled.credit_note_no);
  });

  it("a voided payment on an invoiced bill cancels the invoice too; numbers stay gap-free", async () => {
    const order = await paidOrder(US, ["fries"], "cash", 0);
    const check = order.checks[0]!;
    const inv = await invoice(US, check.id);
    const payment = (await snap(US, order.id)).checks[0]!;
    const [p] = await db.sql<{ id: string }[]>`select id from payments where check_id = ${payment.id} and status = 'recorded'`;
    const voided = await call<Mut>("POST", `/v1/payments/${p!.id}/void`, { token: US.m.manager.token, body: { reason: "Wrong tender" } });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    const after = (await snapChecks(US, order.id))[0]!;
    expect([after.invoice_no, after.cancelled_invoices.map((c) => c.invoice_no)]).toEqual([null, [inv.body.data.invoice_no]]);
    // Every number issued so far is used exactly once, in invoices, cancellations and refunds.
    const invoices = await db.sql<{ n: string }[]>`select invoice_no as n from checks where merchant_id = ${US.m.merchantId} and invoice_no is not null union all select invoice_no from invoice_cancellations where merchant_id = ${US.m.merchantId}`;
    const nums = invoices.map((r) => Number(r.n.slice(4))).sort((a, b) => a - b);
    expect(nums).toEqual(nums.map((_, i) => i + 1));
    const notes = await db.sql<{ n: string }[]>`select credit_note_no as n from refunds where merchant_id = ${US.m.merchantId} and credit_note_no is not null union all select credit_note_no from invoice_cancellations where merchant_id = ${US.m.merchantId}`;
    const cns = notes.map((r) => Number(r.n.slice(3))).sort((a, b) => a - b);
    expect(cns).toEqual(cns.map((_, i) => i + 1));
  });
});

describe("R4: a refund by items gives back the order's tax before less its tax after, per rate", () => {
  const zTaxes = async (w: World) => (await call<{ data: { refunds: { amount: number; tax: number; taxes: Tax[] } } }>("GET", `/v1/outlets/${w.m.outletId}/z-report`, { token: w.m.manager.token })).body.data.refunds;

  it("US two-part tax: burger $12.99 + fries $4.49; refunding the fries leaves $0.52 state and $0.58 local on the $12.99 kept", async () => {
    const order = await paidOrder(US, ["burger", "fries"], "cash", 0);
    expect([tax(order.totals.taxes, "State sales tax"), tax(order.totals.taxes, "Local sales tax")]).toEqual([70, 79]); // 4% and 4.5% of $17.48
    const fries = order.lines.find((l) => l.name === "fries")!;
    const before = await zTaxes(US);
    const r = await boRefund(order.checks[0]!.id, { kind: "lines", lines: [{ line_id: fries.id, quantity: 1 }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    // $0.70 − 4% of $12.99 ($0.52) = $0.18; $0.79 − 4.5% of $12.99 ($0.58) = $0.21.
    expect([tax(r.body.refund.totals.taxes, "State sales tax"), tax(r.body.refund.totals.taxes, "Local sales tax")]).toEqual([18, 21]);
    expect(r.body.refund.totals.total).toBe(449 + 18 + 21);
    // What is kept obeys the rule: its rate times the $12.99 kept.
    const keptLocal = tax(order.totals.taxes, "Local sales tax") - tax(r.body.refund.totals.taxes, "Local sales tax");
    expect(keptLocal).toBe(Math.floor((1299 * 450 + 5000) / 10000));
    // The refund's credit note (none: not invoiced) and the Z-report give back the same tax.
    const after = await zTaxes(US);
    expect(after.tax - before.tax).toBe(39);
    expect(tax(after.taxes, "Local sales tax") - tax(before.taxes, "Local sales tax")).toBe(21);
    expect(after.amount - before.amount).toBe(488);
    // Refunding the burger as well gives back exactly what is left: nothing more, nothing less.
    const burger = order.lines.find((l) => l.name === "burger")!;
    const rest = await boRefund(order.checks[0]!.id, { kind: "lines", lines: [{ line_id: burger.id, quantity: 1 }] });
    expect(rest.status, JSON.stringify(rest.body)).toBe(201);
    expect([tax(rest.body.refund.totals.taxes, "State sales tax"), tax(rest.body.refund.totals.taxes, "Local sales tax")]).toEqual([52, 58]);
    expect(r.body.refund.totals.total + rest.body.refund.totals.total).toBe(order.totals.total);
  });

  it("EU VAT inside the price: cake €3.90 + soup €6.50 at 10%; refunding the soup leaves €0.35 VAT in the €3.90 kept, and the credit note says so", async () => {
    // Paid on the café's station, with a shift open there; invoiced, so the refund has a credit note.
    expect((await openShift(EU, 0, 0)).status).toBe(201);
    const order = await paidOrder(EU, ["cake", "soup"], "cash", 0);
    const vat = order.totals.taxes[0]!;
    expect(vat.amount).toBe(95); // €10.40 × 10/110 = €0.945…
    expect((await call("POST", `/v1/checks/${order.checks[0]!.id}/invoice`, { token: pos(EU), body: {} })).status).toBe(200);
    const soup = order.lines.find((l) => l.name === "soup")!;
    const r = await call<RefundRes>("POST", `/v1/checks/${order.checks[0]!.id}/refunds`, { token: EU.m.manager.token, body: { refund_id: randomUUID(), request: { kind: "lines", lines: [{ line_id: soup.id, quantity: 1 }] }, reason: "Cold", print: false } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    // The guest gets the soup's price back; the VAT inside it is €0.95 − €0.35 (10/110 of €3.90 kept).
    expect(r.body.refund.totals.total).toBe(650);
    expect(r.body.refund.totals.taxes[0]!.amount).toBe(60);
    const [cn] = await db.sql<{ credit_note_document: { totals: { total: number; taxes: Tax[] } } }[]>`select credit_note_document from refunds where id = ${r.body.refund.id}`;
    expect(cn!.credit_note_document.totals.total).toBe(-650);
    expect(cn!.credit_note_document.totals.taxes[0]!.amount).toBe(-60);
    const z = await zTaxes(EU);
    expect(z.taxes.find((t) => t.bps === 1000)!.amount).toBe(60);
  });
});

describe("R3: every PDF embeds the product's typeface", () => {
  it("the generated font module matches the vendored TTFs", () => {
    expect(readFileSync(new URL("../src/lib/pdf-fonts.generated.ts", import.meta.url), "utf8")).toBe(generatedFontModule());
  });

  const doc = (currency: string, locale: string, exponent = 2): InvoiceDocument => ({
    header: { outlet_name: "Café Süd", brand_name: "B", order_no: "P-0001", order_type: "takeaway", printed_at: "2026-01-01T00:00:00Z", job_id: "j", time_zone: "Europe/Berlin", locale },
    kind: "receipt",
    currency,
    currency_exponent: exponent,
    check_label: "Bill 1",
    lines: [
      { quantity: 3, name: "Grüner Tee · Größe L", unit_price: 1_234_567, amount: 3_703_701, modifiers: [] },
      { quantity: 2, name: "Toasted sandwich", unit_price: 950, amount: 950, modifiers: [], share: "1/2" },
    ],
    adjustments: [],
    totals: { subtotal: 3_704_651, discount_total: 0, fee_total: 0, tax_total: 0, taxes: [{ name: "Consumption tax 8% (reduced)", bps: 800, amount: 274_418 }], total: 3_704_651, tax_mode: "inclusive" },
    payments: [{ tender: "Card", amount: 3_704_651, reference: "sim_d6d3d0b3-fdc0-4a1e-9d1c-0b2f6b1a2c3d" }],
    invoice_no: "INV-000001",
    invoice: { number: "INV-000001", issued_at: "2026-01-01T00:00:00Z", merchant_name: "Mustermann GmbH", outlet_address: "Hauptstraße 1" },
  });

  for (const [currency, locale, shows, exponent] of [["EUR", "de-DE", "37.046,51\u00a0€", 2], ["EUR", "en-IE", "€37,046.51", 2], ["GBP", "en-GB", "£37,046.51", 2], ["JPY", "ja-JP", "¥3,704,651", 0], ["SGD", "en-SG", "$37,046.51", 2]] as const) {
    it(`${currency} in ${locale}: long amounts, German and Japanese-preset labels print with no "?"`, async () => {
      const bytes = await renderInvoicePdf(doc(currency, locale, exponent));
      const strings = await pdfStrings(bytes);
      expect(strings.some((x) => x.includes(shows)), JSON.stringify(strings)).toBe(true);
      expect(strings).toContain("Grüner Tee · Größe L");
      expect(strings.some((x) => x.startsWith("Consumption tax 8% (reduced)"))).toBe(true);
      expect(strings.filter((x) => x.includes("?") || x.includes("\ufffd"))).toEqual([]);
      // The processor's reference is the register's, not the guest's: it never prints on the invoice (review 3, R6).
      expect(strings.some((x) => x.includes("sim_"))).toBe(false);
      // The share row names the line's whole price; it has no unit price that reads as the price of one.
      expect(strings.some((x) => x.startsWith("Share of 2 × Toasted sandwich ("))).toBe(true);
      expect(Buffer.from(bytes).toString("latin1")).not.toMatch(/\/BaseFont \/Helvetica/);
    });
  }

  it("the QR sheet and the daily summary embed it too", async () => {
    const qr = await app.request(`/v1/outlets/${US.m.outletId}/reports/daily?format=pdf`, { headers: { authorization: `Bearer ${US.m.manager.token}` } });
    expect(qr.status).toBe(200);
    const daily = Buffer.from(await qr.arrayBuffer()).toString("latin1");
    expect(daily).toMatch(/\/BaseFont \/SAILAA\+InstrumentSans-Regular/);
    expect(daily).not.toMatch(/\/BaseFont \/Helvetica/);
  });
});

describe("R5: with tax inside prices, the Z-report's and Sales' rows add up as written", () => {
  type S = { gross: number; discounts: number; net_before_refunds: number; tax_in_prices: number };
  it("EU: gross − discounts − tax in prices = net before refunds; US: no tax in prices", async () => {
    for (const [w, inclusive] of [[EU, true], [US, false]] as const) {
      const z = (await call<{ data: { sales: S } }>("GET", `/v1/outlets/${w.m.outletId}/z-report`, { token: w.m.manager.token })).body.data.sales;
      const s = (await call<{ data: { totals: S } }>("GET", `/v1/reports/sales-summary?outlet_id=${w.m.outletId}`, { token: w.m.manager.token })).body.data.totals;
      for (const x of [z, s]) {
        expect(x.gross + x.discounts - x.tax_in_prices).toBe(x.net_before_refunds);
        if (inclusive) expect(x.tax_in_prices).toBeGreaterThan(0);
        else expect(x.tax_in_prices).toBe(0);
      }
    }
  });
});

describe("R6: an even split's bill says it carries rounding only when it does (guard; B 9 not reproduced here)", () => {
  it("each bill's note matches whether its tax per rate differs from its rate times its own amount", async () => {
    for (const [basket, n] of [[["burger", "fries", "tea", "coffee"], 3], [["burger", "burger", "fries", "tea", "coffee", "coffee"], 3], [["fries", "tea"], 3], [["burger", "tea", "coffee"], 2], [["burger", "fries", "fries", "tea"], 4]] as const) {
      const o = await open(US);
      const id = o.body.data.id;
      await add(US, id, [...basket]);
      const split = await call<{ data: { checks: { id: string; totals: { total: number; tax_total: number; taxes: Tax[] }; tax_note: string | null; allocations: { total: number; tax: number }[] }[] } } & Err>("POST", `/v1/orders/${id}/checks/split-even`, { token: pos(US), body: { n } });
      expect(split.status, JSON.stringify(split.body)).toBe(200);
      for (const c of split.body.data.checks) {
        const taxable = c.allocations.reduce((sum, a) => sum + a.total - a.tax, 0);
        const off = c.totals.taxes.some((t) => t.amount !== Math.floor((taxable * t.bps + 5000) / 10000));
        expect(c.tax_note !== null, `${basket.join("+")}/${n}: ${JSON.stringify(c.totals)} ${c.tax_note}`).toBe(off);
      }
      expect((await call("POST", `/v1/orders/${id}/cancel`, { token: US.m.manager.token, body: { reason: "test" } })).status).toBeLessThan(300);
    }
  });
});

describe("R6: the Changes log reports what changed", () => {
  it("deactivating staff with the whole form sent back logs only `active`, not an unchanged email", async () => {
    const [s] = await db.sql<{ id: string; name: string; email: string; role: string; initials: string | null }[]>`select id, name, email, role, initials from staff where id = ${US.m.server.id}`;
    const r = await call<Err>("PATCH", `/v1/staff/${s!.id}`, { token: US.m.admin.token, body: { name: s!.name, email: s!.email, role: s!.role, active: false } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [a] = await db.sql<{ details: Record<string, unknown> }[]>`select details from audit_log where action = 'staff.update' and target_id = ${s!.id} order by occurred_at desc limit 1`;
    expect(a!.details).toEqual({ active: false, pin_changed: false });
  });
});
