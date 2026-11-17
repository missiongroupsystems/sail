import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/modules.js";
import { buildApp, type App } from "../src/app.js";
import { readFileSync } from "node:fs";
import { pdfStrings } from "./pdf-strings.js";
import { api, freshDb, seedMerchant, type SeededMerchant, type TestDb } from "./helpers.js";

/** Fourth review round, money: a US diner (4% state + 4.5% local) and an EU café (VAT 10% and 20% inside the price). */
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
    { key: "soda", price: 249, taxClass: "prepared_food" },
    { key: "cheeseburger", price: 1749, taxClass: "prepared_food" },
    { key: "largesoda", price: 399, taxClass: "prepared_food" },
    { key: "veggie", price: 1249, taxClass: "prepared_food" },
    { key: "rings", price: 549, taxClass: "prepared_food" },
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
/** A refund from the back office: the manager's own session, which has no station. */
const boRefund = (w: World, checkId: string, request: unknown, extra: Record<string, unknown> = {}) => call<RefundRes>("POST", `/v1/checks/${checkId}/refunds`, { token: w.m.manager.token, body: { refund_id: randomUUID(), request, reason: "Wrong item keyed", print: false, ...extra } });
const openShift = (w: World, i: number, float: number) => call<{ data: { id: string } } & Err>("POST", "/v1/shifts", { token: pos(w, i), body: { float_cents: float } });
type Z = { sales: { net: number; net_before_refunds: number; total: number; total_after_refunds: number; refunds: number }; tenders: { tender: string; refunds: number; net: number }[]; refunds: { count: number; amount: number; tax: number; taxes: Tax[] }; tax_due: Tax[]; cash: Cash & { open_shifts?: Cash } };
type Cash = { float: number; cash_payments: number; rounding: number; tips: number; refunds: number; expected: number };
const zFor = async (w: World, stationId?: string) => (await call<{ data: Z }>("GET", `/v1/outlets/${w.m.outletId}/z-report${stationId ? `?station_id=${stationId}` : ""}`, { token: w.m.manager.token })).body.data;

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

const sumBy = <T,>(rows: T[], key: (r: T) => string, val: (r: T) => number) => {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + val(r));
  return Object.fromEntries([...m].filter(([, v]) => v !== 0).sort());
};
/** The stations' Z-reports add up to the day's: refunds, net sales, each tender's refunds and net, and tax due per rate. */
async function expectStationsAddUp(w: World) {
  const day = await zFor(w);
  const st = await Promise.all(w.stations.map((s) => zFor(w, s.id)));
  const add = (f: (z: Z) => number) => st.reduce((a, z) => a + f(z), 0);
  expect(add((z) => z.refunds.count)).toBe(day.refunds.count);
  expect(add((z) => z.refunds.amount)).toBe(day.refunds.amount);
  expect(add((z) => z.sales.refunds)).toBe(day.sales.refunds);
  expect(add((z) => z.sales.net)).toBe(day.sales.net);
  expect(add((z) => z.sales.total_after_refunds)).toBe(day.sales.total_after_refunds);
  expect(sumBy(st.flatMap((z) => z.tenders), (t) => t.tender, (t) => t.refunds)).toEqual(sumBy(day.tenders, (t) => t.tender, (t) => t.refunds));
  expect(sumBy(st.flatMap((z) => z.tenders), (t) => t.tender, (t) => t.net)).toEqual(sumBy(day.tenders, (t) => t.tender, (t) => t.net));
  expect(sumBy(st.flatMap((z) => z.tax_due), (t) => `${t.name}@${t.bps}`, (t) => t.amount)).toEqual(sumBy(day.tax_due, (t) => `${t.name}@${t.bps}`, (t) => t.amount));
  return { day, st };
}

describe("T1: a back-office card refund counts on the station of the payment it gives back", () => {
  beforeAll(async () => {
    for (const w of [US, EU]) for (const i of [0, 1]) expect((await openShift(w, i, 10_000)).status).toBe(201);
  });
  for (const which of ["US", "EU"] as const) {
    it(`${which}: card refunds from the back office (whole bill and by items) land on the paying station; stations add up to the day`, async () => {
      const w = which === "US" ? US : EU;
      const keys = which === "US" ? ["burger", "fries", "tea"] : ["soup", "wine", "cake"];
      // Station 1 takes one order in cash; Station 2 one by card and one in cash.
      await paidOrder(w, [keys[0]!], "cash", 0);
      const card = await paidOrder(w, keys, "card", 1);
      const cash2 = await paidOrder(w, [keys[1]!], "card", 1);
      const before = await expectStationsAddUp(w);
      expect(before.day.refunds.count).toBe(0);

      const byItems = await boRefund(w, card.checks[0]!.id, { kind: "lines", lines: [{ line_id: card.lines[0]!.id, quantity: 1 }] });
      expect(byItems.status, JSON.stringify(byItems.body)).toBe(201);
      const whole = await boRefund(w, cash2.checks[0]!.id, { kind: "full" });
      expect(whole.status, JSON.stringify(whole.body)).toBe(201);
      const rows = await db.sql<{ station_id: string | null; shift_id: string | null }[]>`select station_id, shift_id from refunds where id in ${db.sql([byItems.body.refund.id, whole.body.refund.id])}`;
      expect(rows.map((r) => r.station_id)).toEqual([w.stations[1]!.id, w.stations[1]!.id]);
      expect(rows.every((r) => r.shift_id === null)).toBe(true);

      const after = await expectStationsAddUp(w);
      const given = byItems.body.refund.totals.total + whole.body.refund.totals.total;
      expect(after.day.refunds.amount).toBe(given);
      expect(after.st[1]!.refunds.amount).toBe(given);
      expect(after.st[0]!.refunds.amount).toBe(0);
      expect(after.st[1]!.tenders.find((t) => t.tender === "Card")!.refunds).toBe(given);
      // Reports › Sales filtered by station follows the same rule.
      const sales = async (stationId?: string) => (await call<{ data: { refunds: { amount: number }; totals: { net: number } } }>("GET", `/v1/reports/sales-summary?outlet_id=${w.m.outletId}${stationId ? `&station_id=${stationId}` : ""}`, { token: w.m.manager.token })).body.data;
      const [d, s1, s2] = [await sales(), await sales(w.stations[0]!.id), await sales(w.stations[1]!.id)];
      expect(s1.refunds.amount + s2.refunds.amount).toBe(d.refunds.amount);
      expect(s1.totals.net + s2.totals.net).toBe(d.totals.net);

      // Migration 0055 gives an older back-office refund, written with no station, the station of the payment it gave back.
      await db.sql.unsafe(`alter table refunds disable trigger refunds_immutable; update refunds set station_id = null where id = '${whole.body.refund.id}'; alter table refunds enable trigger refunds_immutable`);
      expect((await zFor(w, w.stations[1]!.id)).refunds.amount).toBe(given - whole.body.refund.totals.total);
      await db.sql.unsafe(readFileSync(new URL("../drizzle/0055_refund_station.sql", import.meta.url), "utf8").replaceAll("--> statement-breakpoint", ""));
      expect((await zFor(w, w.stations[1]!.id)).refunds.amount).toBe(given);
      await expectStationsAddUp(w);
    });
  }
});

describe("T2: reopen is asked once per click; the register refuses a second reopen and replays a retried one", () => {
  it("a dry run changes nothing; the reopen goes through once; a retry with the same key replays it; a new reopen is refused", async () => {
    const order = await paidOrder(US, ["coffee"], "card", 1);
    const path = `/v1/orders/${order.id}/reopen`;
    const dry = await call<Mut>("POST", path, { token: US.m.manager.token, body: { reason: "dry run", dry_run: true } });
    expect(dry.status, JSON.stringify(dry.body)).toBe(200);
    expect((await snap(US, order.id)).status).toBe("completed");
    const key = randomUUID();
    const first = await call<Mut>("POST", path, { token: US.m.manager.token, body: { reason: "Wrong items" }, idempotencyKey: key });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const replay = await call<Mut>("POST", path, { token: US.m.manager.token, body: { reason: "Wrong items" }, idempotencyKey: key });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    const again = await call<Mut>("POST", path, { token: US.m.manager.token, body: { reason: "Wrong items" } });
    expect(again.status).toBe(409);
    expect(again.body.message).toMatch(/^Only completed orders can be reopened/);
    const reversed = await db.sql<{ n: number }[]>`select count(*)::int as n from payments where order_id = ${order.id} and status = 'reversed'`;
    expect(reversed[0]!.n).toBe(1);
  });
});

describe("T3: the Z-report and Sales give what the rows need to add up as written", () => {
  it("with tax in prices and a taxed fee: gross + discounts + fees as charged = collected = net before refunds + fees before tax + tax", async () => {
    // A 50 cent bag fee on takeaways, with 20% VAT inside it.
    const rule = await call("POST", "/v1/pricing-rules", { token: EU.m.admin.token, body: { rule_key: "bag-fee", body: { kind: "fee", name: "Bag", calc: "fixed_per_order", value: { type: "fixed", amount: 50 }, scope: { type: "all" }, conditions: { order_types: ["takeaway"] }, priority: 950, application: "auto", tax_class_id: EU.m.taxClassIds.standard, report_class: "packaging_fee" } } });
    expect(rule.status, JSON.stringify(rule.body)).toBe(201);
    const order = await paidOrder(EU, ["soup", "wine"], "card", 1);
    expect(order.checks[0]!.totals.total).toBe(650 + 745 + 50);
    type Sales = { gross: number; discounts: number; fees: number; fees_charged: number; tax: number; total: number; net_before_refunds: number };
    const z = (await call<{ data: { sales: Sales; tenders: { tender: string; terminal: boolean }[] } }>("GET", `/v1/outlets/${EU.m.outletId}/z-report`, { token: EU.m.manager.token })).body.data;
    const summary = (await call<{ data: { totals: Sales } }>("GET", `/v1/reports/sales-summary?outlet_id=${EU.m.outletId}`, { token: EU.m.manager.token })).body.data.totals;
    for (const s of [z.sales, summary]) {
      expect(s.fees_charged - s.fees, "the fees' VAT: 50 cents at 20% inside").toBeGreaterThan(0);
      expect(s.gross + s.discounts + s.fees_charged).toBe(s.total);
      expect(s.net_before_refunds + s.fees + s.tax).toBe(s.total);
    }
    // A keyed card and cash have no terminal of their own.
    // The daily summary PDF lists the same rows in the same order.
    const pdf = await app.request(`/v1/outlets/${EU.m.outletId}/reports/daily?format=pdf`, { headers: { authorization: `Bearer ${EU.m.manager.token}` } });
    expect(pdf.status).toBe(200);
    const words = (await pdfStrings(new Uint8Array(await pdf.arrayBuffer()))).join("\n");
    const at = ["Gross (items)", "Discounts", "Fees", "Collected", "Of which net before refunds", "Of which fees before tax", "Of which VAT", "Refunded (", "Net sales", "Collected after refunds"].map((w) => words.indexOf(w));
    expect(at.every((i) => i >= 0), words).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(z.tenders.length).toBeGreaterThan(0);
    for (const t of z.tenders) expect(t.terminal, t.tender).toBe(false);
  });

  it("only a tender sent to a card terminal (one with a provider) is marked as the terminal", async () => {
    await db.sql`update tender_types set provider = 'simulator', terminal_id = 'sim-1' where id = ${US.card}`;
    const z = (await call<{ data: { tenders: { tender: string; terminal: boolean }[] } }>("GET", `/v1/outlets/${US.m.outletId}/z-report`, { token: US.m.manager.token })).body.data;
    expect(z.tenders.find((t) => t.tender === "Card")!.terminal).toBe(true);
    expect(z.tenders.find((t) => t.tender === "Cash")!.terminal).toBe(false);
    await db.sql`update tender_types set provider = null, terminal_id = null where id = ${US.card}`;
  });
});

const splitEven = async (w: World, orderId: string, n: number) => {
  const r = await call<Mut>("POST", `/v1/orders/${orderId}/checks/split-even`, { token: w.m.manager.token, body: { n } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.data;
};
async function openWith(w: World, keys: string[], i = 1) {
  const o = await open(w, i);
  const s = await add(w, o.body.data.id, keys, i);
  expect(s.status, JSON.stringify(s.body)).toBe(200);
  return s.body.data;
}

type Alloc = { check_id: string; order_line_id: string; base: number; discount: number; fee: number; tax: number; total: number; taxes: Tax[] };
type LineRow = { id: string; base_amount: number; discount_amount: number; fee_amount: number; tax_amount: number; total: number; taxes: Tax[] };
const key = (t: { name: string; bps: number }) => `${t.bps}|${t.name}`;
const byRate = (lists: Tax[][]) => {
  const m = new Map<string, number>();
  for (const l of lists) for (const t of l) m.set(key(t), (m.get(key(t)) ?? 0) + t.amount);
  for (const [k, v] of m) if (v === 0) m.delete(k);
  return Object.fromEntries([...m].sort());
};

/** What an even split must hold: bills a cent apart at most, the order's tax per rate, and every line's shares adding up. */
async function expectEven(orderId: string, n: number, label: string) {
  const [o] = await db.sql<{ total: number; taxes: Tax[] }[]>`select total, taxes from orders where id = ${orderId}`;
  const checks = await db.sql<{ id: string; total: number; taxes: Tax[] }[]>`select id, total, taxes from checks where order_id = ${orderId} order by index`;
  expect(checks.length, label).toBe(n);
  const totals = checks.map((c) => c.total);
  expect(Math.max(...totals) - Math.min(...totals), `${label}: ${totals.join(" / ")}`).toBeLessThanOrEqual(1);
  expect(totals.reduce((a, b) => a + b, 0), label).toBe(o!.total);
  expect(byRate(checks.map((c) => c.taxes)), label).toEqual(byRate([o!.taxes]));
  const allocs = await db.sql<Alloc[]>`select a.check_id, a.order_line_id, a.base, a.discount, a.fee, a.tax, a.total, a.taxes from check_allocations a join checks c on c.id = a.check_id where c.order_id = ${orderId}`;
  const lines = await db.sql<LineRow[]>`select id, base_amount, discount_amount, fee_amount, tax_amount, total, taxes from order_lines where order_id = ${orderId} and status <> 'voided'`;
  for (const l of lines) {
    const mine = allocs.filter((a) => a.order_line_id === l.id);
    const add = (f: (a: Alloc) => number) => mine.reduce((s, a) => s + f(a), 0);
    expect([add((a) => a.base), add((a) => a.discount), add((a) => a.fee), add((a) => a.tax), add((a) => a.total)], `${label}: line ${l.id}`).toEqual([l.base_amount, l.discount_amount, l.fee_amount, l.tax_amount, l.total]);
    expect(byRate(mine.map((a) => a.taxes)), label).toEqual(byRate([l.taxes]));
  }
  return checks;
}

describe("T4: an even split is even", () => {
  it("B's baskets: $21.67 two ways is $10.84 / $10.83; $40.80 five ways is $8.16 each; the header has at most two figures", async () => {
    for (const [keys, n] of [[["burger", "soda", "fries"], 2], [["cheeseburger", "burger", "largesoda", "largesoda", "veggie", "tea", "rings", "rings", "fries"], 5], [["burger", "soda"], 4], [["burger", "soda", "fries"], 4]] as const) {
      const o = await openWith(US, [...keys]);
      await splitEven(US, o.id, n);
      const checks = await expectEven(o.id, n, `${keys.join("+")} / ${n}`);
      expect(new Set(checks.map((c) => c.total)).size).toBeLessThanOrEqual(2);
      if (n === 2 && keys.length === 3) expect(checks.map((c) => c.total)).toEqual([1084, 1083]);
      expect((await call("POST", `/v1/orders/${o.id}/cancel`, { token: US.m.manager.token, body: { reason: "test" } })).status).toBeLessThan(300);
    }
  });

  it("with 15% off the bill: $40.80 five ways is $8.16 each", async () => {
    // Table 2 in B's report: $44.25 of items, 15% off ($6.64), tax $1.50 + $1.69 = $40.80.
    const rule = await call("POST", "/v1/pricing-rules", { token: US.m.admin.token, body: { rule_key: "fifteen-off", body: { kind: "discount", name: "15% off", calc: "percent", level: "order", value: { type: "fixed", amount: 1500 }, scope: { type: "all" }, priority: 70, application: "manual", min_role: "manager", report_class: "promo" } } });
    expect(rule.status, JSON.stringify(rule.body)).toBe(201);
    const o = await openWith(US, ["cheeseburger", "burger", "largesoda", "veggie"]);
    const applied = await call<Mut>("POST", `/v1/orders/${o.id}/adjustments`, { token: US.m.manager.token, body: { application_id: randomUUID(), rule_key: "fifteen-off", reason: "Regular" } });
    expect(applied.status, JSON.stringify(applied.body)).toBeLessThan(300);
    for (const n of [2, 3, 4, 5, 6]) {
      await splitEven(US, o.id, n);
      await expectEven(o.id, n, `15% off / ${n}`);
    }
    expect((await call("POST", `/v1/orders/${o.id}/cancel`, { token: US.m.manager.token, body: { reason: "test" } })).status).toBeLessThan(300);
  });
});
