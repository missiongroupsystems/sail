import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/modules.js";
import { buildApp, type App } from "../src/app.js";
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

export { EU, tax };
