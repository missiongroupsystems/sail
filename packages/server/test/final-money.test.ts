import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TaxBreakdown } from "@sail/shared";
import "../src/modules.js";
import { buildApp, type App } from "../src/app.js";
import { resetGuestRateLimitsForTests } from "../src/services/guest.js";
import { startListener, stopListener } from "../src/sse/listener.js";
import { api, backOfficeSession, freshDb, readSse, settleOpenOrders, seedMerchant, type SeededMerchant, type TestDb } from "./helpers.js";

/** Final review round, money: a US diner (4% state + 4.5% local, rounded per rate). */
let db: TestDb;
let app: App;
let US: SeededMerchant;
let call: ReturnType<typeof api>["call"];
let pin: string;
const qr: Record<string, string> = {};
const ids = { t5: randomUUID(), t6: randomUUID(), hot: randomUUID(), bar: randomUUID(), card: randomUUID(), mint: randomUUID(), a: randomUUID(), b: randomUUID(), c: randomUUID(), qrLink: randomUUID(), t2: randomUUID(), t3: randomUUID(), t4: randomUUID(), burger: randomUUID(), soda: randomUUID(), menu: randomUUID(), link: randomUUID(), area: randomUUID(), t1: randomUUID(), station: randomUUID(), cash: randomUUID(), };

type Snap = { id: string; version: number; status: string; totals: { subtotal: number; tax_total: number; taxes: TaxBreakdown[]; total: number }; lines: { id: string; status: string; amounts: { total: number; tax: number } }[]; checks: { id: string; total?: number; totals: { total: number; subtotal: number; tax_total: number }; balance: number; allocations: { line_id: string }[] }[]; balance: number; paid_total: number };
type Mut = { data: Snap; code?: string };

beforeAll(async () => {
  db = await freshDb({ GUEST_APP_URL: "https://order.example.test" });
  app = buildApp();
  call = api(app).call;
  await startListener();
  US = await seedMerchant(db.sql, "Diner", { preset: "us", timeZone: "America/New_York", locale: "en-US" });
  const t = US.admin.token;
  const must = async (path: string, body: unknown) => {
    const r = await call("POST", path, { token: t, body });
    expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBeLessThan(300);
  };
  await must("/v1/products", { id: ids.burger, name: "Burger", price: 3596, tags: ["kitchen"] });
  await must("/v1/products", { id: ids.soda, name: "Soda", price: 4320, tags: ["bar"] });
  await must("/v1/products", { id: ids.a, name: "Platter", price: 5275, tags: ["kitchen"] });
  await must("/v1/products", { id: ids.mint, name: "Mint", price: 100, tags: ["bar"] });
  await must("/v1/products", { id: ids.b, name: "Ribs", price: 2845, tags: ["kitchen"] });
  await must("/v1/products", { id: ids.c, name: "Pie", price: 2098, tags: ["kitchen"] });
  await must("/v1/menus", { id: ids.menu, brand_id: US.brandId, name: "M", sections: [{ name: "All", items: [{ product_id: ids.burger }, { product_id: ids.soda }, { product_id: ids.a }, { product_id: ids.b }, { product_id: ids.c }, { product_id: ids.mint }] }] });
  await must("/v1/channel-links", { id: ids.link, channel: "pos", outlet_id: US.outletId, brand_id: US.brandId, menu_id: ids.menu });
  await must("/v1/display-destinations", { id: ids.hot, outlet_id: US.outletId, name: "Hot line", include_tags: ["kitchen"], is_default: true });
  await must("/v1/display-destinations", { id: ids.bar, outlet_id: US.outletId, name: "Bar", include_tags: ["bar"] });
  await must("/v1/areas", { id: ids.area, outlet_id: US.outletId, name: "Main" });
  await must("/v1/channel-links", { id: ids.qrLink, channel: "scan_to_order", outlet_id: US.outletId, brand_id: US.brandId, menu_id: ids.menu, hold_orders: true, open_on_first_scan: true, service_requests: ["call_for_bill"] });
  for (const [k, name] of [["t1", "1"], ["t2", "2"], ["t3", "3"], ["t4", "4"], ["t5", "5"], ["t6", "6"]] as const) {
    await must("/v1/tables", { id: ids[k], outlet_id: US.outletId, area_id: ids.area, name });
    qr[k] = (await call<{ data: { url: string } }>("POST", `/v1/tables/${ids[k]}/qr/rotate`, { token: t, body: {} })).body.data.url;
  }
  await must("/v1/tender-types", { id: ids.cash, name: "Cash", is_cash: true });
  await must("/v1/tender-types", { id: ids.card, name: "Card" });
  await must("/v1/shifts", { outlet_id: US.outletId, station_id: null, float_cents: 0 });
  await must("/v1/stations", { id: ids.station, outlet_id: US.outletId, brand_id: US.brandId, name: "Floor" });
  const code = await call<{ data: { code: string } }>("POST", `/v1/stations/${ids.station}/pairing-code`, { token: t, body: {} });
  const paired = await call<{ data: { station_token: string } }>("POST", "/v1/stations/pair", { body: { code: code.body.data.code, device_label: "iPad" }, idempotencyKey: null });
  pin = (await call<{ data: { session_token: string } }>("POST", "/v1/stations/sessions", { token: paired.body.data.station_token, body: { pin: "333333" } })).body.data.session_token;
});
afterAll(async () => {
  await stopListener();
  await db.drop();
});

const open = (body: Record<string, unknown>) => call<Mut>("POST", "/v1/orders", { token: pin, body: { order_id: randomUUID(), ...body } });
const add = (orderId: string, product_id: string, quantity = 1) => call<Mut>("POST", `/v1/orders/${orderId}/lines`, { token: pin, body: { lines: [{ line_id: randomUUID(), product_id, quantity }] } });
const component = (s: Snap, name: string) => s.totals.taxes.find((x) => x.name === name)!;

describe("M13: tax after a quantity change", () => {
  it("each tax component is its own rate times its taxable amount, rounded once", async () => {
    const o = await open({ order_type: "takeaway" });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    const a = await add(o.body.data.id, ids.burger);
    const lineId = a.body.data.lines[0]!.id;
    const p = await call<Mut>("PATCH", `/v1/orders/${o.body.data.id}/lines/${lineId}`, { token: pin, body: { quantity: 2 } });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.data.version).toBeGreaterThan(a.body.data.version);
    expect(p.body.data.totals.subtotal).toBe(7192);
    expect(component(p.body.data, "State sales tax").amount).toBe(288);
    expect(component(p.body.data, "Local sales tax").amount).toBe(324);
    expect(p.body.data.totals.tax_total).toBe(612);
    expect(p.body.data.totals.total).toBe(7804);
  });
});

const phone = async (table: string, device: string) => {
  await resetGuestRateLimitsForTests();
  const r = await call<{ data: { guest_token: string } }>("POST", "/v1/guest/sessions", { body: { token: qr[table]!.split("/t/")[1]!, device_id: device }, idempotencyKey: null });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data.guest_token;
};
const guestRound = async (g: string, product_id: string, quantity = 1) => {
  await resetGuestRateLimitsForTests();
  const round_id = randomUUID();
  const r = await call<{ data: { order: { id: string } } }>("POST", "/v1/guest/rounds", { token: g, body: { round_id, lines: [{ line_id: randomUUID(), product_id, quantity }] } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { roundId: round_id, orderId: r.body.data.order.id };
};
const snap = async (id: string) => (await call<{ data: Snap }>("GET", `/v1/orders/${id}`, { token: pin })).body.data;
const pay = (orderId: string, checkId: string, amount: number, extra: Record<string, unknown> = {}) => call<Mut & { payment?: { change_due: number } }>("POST", `/v1/checks/${checkId}/payments`, { token: pin, body: { payment_id: randomUUID(), tender_type_id: ids.cash, amount, ...extra } });

describe("M1: a QR round waiting for acceptance is not part of the order", () => {
  it("is on no bill and not in the total; paying takes only accepted items; rejecting it then leaves nothing owed either way", async () => {
    const g = await phone("t2", "device-m1-0001");
    const first = await guestRound(g, ids.burger);
    expect((await call("POST", `/v1/rounds/${first.roundId}/accept`, { token: pin, body: {} })).status).toBe(200);
    const accepted = await snap(first.orderId);
    expect(accepted.totals.subtotal).toBe(3596);
    const second = await guestRound(g, ids.soda);
    const waiting = await snap(first.orderId);
    // The waiting soda adds nothing: not to the total, not to any bill, not to the balance.
    expect(waiting.totals.total).toBe(accepted.totals.total);
    expect(waiting.balance).toBe(accepted.totals.total);
    const sodaLine = waiting.lines.find((l) => l.status === "held")!;
    expect(sodaLine.amounts.total).toBe(0);
    expect(waiting.checks.flatMap((c) => c.allocations.map((a) => a.line_id))).not.toContain(sodaLine.id);
    // Paying the whole balance pays the burger only; the order stays open (an item still waits).
    const paid = await pay(first.orderId, waiting.checks[0]!.id, waiting.balance);
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.data.balance).toBe(0);
    expect(paid.body.data.status).not.toBe("completed");
    // Nothing is left to pay while the round waits: the register says why.
    const again = await pay(first.orderId, waiting.checks[0]!.id, 100);
    expect(again.status).toBe(409);
    expect(JSON.stringify(again.body)).toContain("QR order is waiting");
    // Rejected: the total and the paid amount still agree, nothing is owed either way, and the order can complete.
    const rej = await call<Mut>("POST", `/v1/rounds/${second.roundId}/reject`, { token: pin, body: { reason: "Sold out" } });
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    expect(rej.body.data.totals.total).toBe(accepted.totals.total);
    expect(rej.body.data.paid_total).toBe(accepted.totals.total);
    expect(rej.body.data.balance).toBe(0);
    expect(rej.body.data.status).toBe("completed");
  });

  it("accepting the round puts it on a new bill when the first is paid, at its own price", async () => {
    const g = await phone("t3", "device-m1-0002");
    const first = await guestRound(g, ids.burger);
    await call("POST", `/v1/rounds/${first.roundId}/accept`, { token: pin, body: {} });
    const before = await snap(first.orderId);
    const second = await guestRound(g, ids.soda);
    await pay(first.orderId, before.checks[0]!.id, before.balance);
    const acc = await call<Mut>("POST", `/v1/rounds/${second.roundId}/accept`, { token: pin, body: {} });
    expect(acc.status, JSON.stringify(acc.body)).toBe(200);
    const after = await snap(first.orderId);
    expect(after.totals.subtotal).toBe(3596 + 4320);
    expect(after.balance).toBe(after.totals.total - before.totals.total);
    expect(after.checks).toHaveLength(2);
    expect(after.checks[1]!.totals.subtotal).toBe(4320);
  });
});

describe("M7: table requests close with the order", () => {
  it("a 'Bill, please' is closed when the order is paid", async () => {
    const g = await phone("t4", "device-m7-0001");
    const r = await guestRound(g, ids.burger);
    await call("POST", `/v1/rounds/${r.roundId}/accept`, { token: pin, body: {} });
    await resetGuestRateLimitsForTests();
    const req = await call("POST", "/v1/guest/requests", { token: g, body: { type: "call_for_bill" } });
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    const open = async () => (await call<{ data: { table_id: string }[] }>("GET", `/v1/outlets/${US.outletId}/service-requests?status=open`, { token: pin })).body.data.filter((x) => x.table_id === ids.t4);
    expect(await open()).toHaveLength(1);
    const s = await snap(r.orderId);
    const paid = await pay(r.orderId, s.checks[0]!.id, s.balance);
    expect(paid.body.data.status).toBe("completed");
    expect(await open()).toHaveLength(0);
  });
});

describe("M17: an order paid before it is sent completes when it is sent", () => {
  it("a takeaway paid in cash, then sent, is completed by the send", async () => {
    const o = await open({ order_type: "takeaway" });
    const a = await add(o.body.data.id, ids.burger);
    const p = await pay(o.body.data.id, a.body.data.checks[0]!.id, a.body.data.balance);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.data.status).toBe("open");
    const f = await call<Mut & { events: { type: string }[] }>("POST", `/v1/orders/${o.body.data.id}/fire`, { token: pin, body: {} });
    expect(f.status, JSON.stringify(f.body)).toBe(200);
    expect(f.body.data.status).toBe("completed");
    expect(f.body.events.map((e) => e.type)).toContain("order.completed");
  });
});

type Bill = { id: string; totals: { subtotal: number; tax_total: number; taxes: { name: string; bps: number; amount: number }[]; total: number } };
const billTax = (b: Bill, name: string) => b.totals.taxes.find((t) => t.name === name)?.amount ?? 0;
const ownTax = (subtotal: number, bps: number) => Math.round((subtotal * bps) / 10_000 + 1e-9);

describe("M14: each split bill's tax is its own rate times its own subtotal", () => {
  it("split by item: $52.75 and $28.45 bills carry 4% and 4.5% of themselves, and add up to the order", async () => {
    const o = await open({ order_type: "takeaway" });
    await add(o.body.data.id, ids.a);
    const s1 = await add(o.body.data.id, ids.b);
    const ribs = s1.body.data.lines.find((l) => l.amounts.total > 0 && s1.body.data.lines.indexOf(l) === 1)!;
    const split = await call<{ data: Snap & { checks: Bill[] } }>("POST", `/v1/orders/${o.body.data.id}/checks/allocate`, { token: pin, body: { moves: [], add_checks: 1 } });
    expect(split.status, JSON.stringify(split.body)).toBe(200);
    const moved = await call<{ data: Snap & { checks: Bill[] } }>("POST", `/v1/orders/${o.body.data.id}/checks/allocate`, { token: pin, body: { moves: [{ line_id: ribs.id, check_ids: [split.body.data.checks[1]!.id] }] } });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const d = moved.body.data;
    for (const b of d.checks) {
      expect(billTax(b, "State sales tax")).toBe(ownTax(b.totals.subtotal, 400));
      expect(billTax(b, "Local sales tax")).toBe(ownTax(b.totals.subtotal, 450));
    }
    expect(d.checks.map((b) => b.totals.subtotal).sort()).toEqual([2845, 5275]);
    expect(d.checks.reduce((s, b) => s + b.totals.tax_total, 0)).toBe(d.totals.tax_total);
    expect(d.checks.reduce((s, b) => s + b.totals.total, 0)).toBe(d.totals.total);
    expect(d.totals.tax_total).toBe(325 + 365);
    // Paying the first bill keeps both bills right.
    const paid = await pay(o.body.data.id, d.checks[0]!.id, d.checks[0]!.totals.total);
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const after = (await snap(o.body.data.id)) as unknown as Snap & { checks: Bill[] };
    for (const b of after.checks) expect(billTax(b, "Local sales tax")).toBe(ownTax(b.totals.subtotal, 450));
  });

  it("three $1.00 items split two and one: the order's odd cent of tax goes where each bill's own 4.5% puts it", async () => {
    const o = await open({ order_type: "takeaway" });
    const r = await call<Mut>("POST", `/v1/orders/${o.body.data.id}/lines`, { token: pin, body: { lines: [1, 2, 3].map(() => ({ line_id: randomUUID(), product_id: ids.mint, quantity: 1 })) } });
    const third = r.body.data.lines[2]!.id;
    const two = await call<{ data: Snap & { checks: Bill[] } }>("POST", `/v1/orders/${o.body.data.id}/checks/allocate`, { token: pin, body: { moves: [], add_checks: 1 } });
    const d = (await call<{ data: Snap & { checks: Bill[] } }>("POST", `/v1/orders/${o.body.data.id}/checks/allocate`, { token: pin, body: { moves: [{ line_id: third, check_ids: [two.body.data.checks[1]!.id] }] } })).body.data;
    expect(d.totals.tax_total).toBe(12 + 14);
    const [b1, b2] = d.checks;
    expect(b1!.totals.subtotal).toBe(200);
    expect(billTax(b1!, "Local sales tax")).toBe(9);
    expect(billTax(b2!, "Local sales tax")).toBe(5);
    expect(d.checks.reduce((s, b) => s + b.totals.total, 0)).toBe(d.totals.total);
    // Each bill's printed tax rows are its own: nothing to note on either.
    const docs = await Promise.all(d.checks.map((b) => db.sql<{ n: number }[]>`select count(*)::int as n from check_allocations where check_id = ${b.id}`));
    expect(docs.map((x) => x[0]!.n)).toEqual([2, 1]);
  });

  it("even split of $20.98: two bills of $10.49, each with its own 4% and 4.5%", async () => {
    const o = await open({ order_type: "takeaway" });
    await add(o.body.data.id, ids.c);
    const r = await call<{ data: Snap & { checks: Bill[] } }>("POST", `/v1/orders/${o.body.data.id}/checks/split-even`, { token: pin, body: { n: 2 } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    for (const b of r.body.data.checks) {
      expect(b.totals.subtotal).toBe(1049);
      expect(billTax(b, "State sales tax")).toBe(42);
      expect(billTax(b, "Local sales tax")).toBe(47);
    }
    expect(r.body.data.totals.tax_total).toBe(84 + 94);
  });
});

type Z = {
  scope: { business_date: string };
  sales: { total: number };
  tenders: { tender_type_id: string; count: number; amount: number; rounding: number; tips: number; refunds: number; reversed: number; net: number }[];
  reconciliation: { tenders: number; sales_total: number; paid_on_other_orders: number; paid_elsewhere: number; held_on_open_orders: number; paid_for_other_orders: number };
  reversals: { count: number; amount: number; items: { order_no: string; amount: number }[] };
  closed: { closed_at: string } | null;
  previous_closed_date: string | null;
};
const zr = async (q = "") => {
  const r = await call<{ data: Z }>("GET", `/v1/outlets/${US.outletId}/z-report${q}`, { token: US.admin.token });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.data;
};

describe("M2, M20, M16: the Z-report reconciles on its face, per tender, and stays readable once the day is closed", () => {
  it("per tender: sales, tips, refunds, reversals and the net the terminal shows; payments = collected + held on open orders + other orders − paid elsewhere", async () => {
    // A: $35.96 + 4% + 4.5% = $39.02, paid by card with a $5 tip, sent (completes), then $10 refunded by amount.
    const a = await open({ order_type: "takeaway" });
    const al = await add(a.body.data.id, ids.burger);
    expect(al.body.data.totals.total).toBe(3596 + 144 + 162);
    const ap = await call<Mut>("POST", `/v1/checks/${al.body.data.checks[0]!.id}/payments`, { token: US.admin.token, body: { payment_id: randomUUID(), tender_type_id: ids.card, amount: 3902, tip_cents: 500 } });
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    expect((await call<Mut>("POST", `/v1/orders/${a.body.data.id}/fire`, { token: pin, body: {} })).body.data.status).toBe("completed");
    const rf = await call("POST", `/v1/checks/${al.body.data.checks[0]!.id}/refunds`, { token: US.admin.token, body: { refund_id: randomUUID(), request: { kind: "amount", amount: 1000 }, reason: "Cold" } });
    expect(rf.status, JSON.stringify(rf.body)).toBe(201);
    // B: $46.87 by card, then voided: reversed, counted in no tender.
    const b = await open({ order_type: "takeaway" });
    const bl = await add(b.body.data.id, ids.soda);
    expect(bl.body.data.totals.total).toBe(4320 + 173 + 194);
    const paymentId = randomUUID();
    const bp = await call("POST", `/v1/checks/${bl.body.data.checks[0]!.id}/payments`, { token: US.admin.token, body: { payment_id: paymentId, tender_type_id: ids.card, amount: 4687 } });
    expect(bp.status, JSON.stringify(bp.body)).toBe(200);
    const v = await call("POST", `/v1/payments/${paymentId}/void`, { token: US.admin.token, body: { reason: "Charged twice" } });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    // C: an open table part-paid $10.00 in cash: money held on an open order.
    const c = await open({ order_type: "takeaway" });
    const cl = await add(c.body.data.id, ids.a);
    const cp = await pay(c.body.data.id, cl.body.data.checks[0]!.id, 1000);
    expect(cp.status, JSON.stringify(cp.body)).toBe(200);

    const z = await zr();
    const card = z.tenders.find((t) => t.tender_type_id === ids.card)!;
    expect(card).toMatchObject({ count: 1, amount: 3902, tips: 500, refunds: 1000, reversed: 4687, net: 3902 + 500 - 1000 });
    expect(z.reversals.items.map((x) => x.amount)).toContain(4687);
    const rec = z.reconciliation;
    expect(rec.held_on_open_orders).toBeGreaterThanOrEqual(1000);
    expect(rec.held_on_open_orders + rec.paid_for_other_orders).toBe(rec.paid_on_other_orders);
    expect(rec.tenders).toBe(rec.sales_total + rec.held_on_open_orders + rec.paid_for_other_orders - rec.paid_elsewhere);
    expect(rec.sales_total).toBe(z.sales.total);
    expect(rec.tenders).toBe(z.tenders.reduce((n, t) => n + t.amount, 0));
    for (const t of z.tenders) expect(t.net).toBe(t.amount + t.rounding + t.tips - t.refunds);
  });

  it("once the day is closed its Z-report is the snapshot, and the next day's report names it", async () => {
    await settleOpenOrders(db.sql, call, US.admin.token, US.outletId, ids.card);
    const before = await zr();
    const day = before.scope.business_date;
    const shifts = await call<{ data: { id: string; status: string }[] }>("GET", `/v1/outlets/${US.outletId}/shifts?status=open`, { token: US.admin.token });
    for (const sh of shifts.body.data.filter((x) => x.status === "open")) {
      const r = await call("POST", `/v1/shifts/${sh.id}/close`, { token: US.admin.token, body: { counted_cash_cents: 0, variance_reason: "Test count" } });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    const close = await call("POST", `/v1/outlets/${US.outletId}/business-days/close`, { token: US.admin.token, body: {} });
    expect(close.status, JSON.stringify(close.body)).toBe(200);
    const closedDay = await zr(`?business_date=${day}`);
    expect(closedDay.closed).not.toBeNull();
    expect(closedDay.reconciliation.tenders).toBe(before.reconciliation.tenders);
    const next = await zr();
    expect(next.scope.business_date).not.toBe(day);
    expect(next.closed).toBeNull();
    expect(next.previous_closed_date).toBe(day);
  });
});

describe("M6: the guest's steps and the POS status follow the kitchen, round by round", () => {
  type GV = { data: { order: { status: string }; rounds: { id: string; status: string; kitchen_done: boolean }[]; lines: { round_id: string; kitchen_done: boolean }[] } };
  it("a round is Done when every ticket it sent is bumped, at every station; the order is ready when all are", async () => {
    const g = await phone("t1", "device-m6-0001");
    const r1 = await guestRound(g, ids.burger);
    await call("POST", `/v1/rounds/${r1.roundId}/accept`, { token: pin, body: {} });
    const r2 = await guestRound(g, ids.soda);
    await call("POST", `/v1/rounds/${r2.roundId}/accept`, { token: pin, body: {} });
    const tickets = (await call<{ data: { id: string; order_id: string; destination_id: string; round_no: number }[] }>("GET", `/v1/outlets/${US.outletId}/kitchen-tickets`, { token: US.admin.token })).body.data.filter((t) => t.order_id === r1.orderId);
    expect(tickets).toHaveLength(2);
    const view = async () => (await call<GV>("GET", "/v1/guest/order", { token: g })).body.data;
    const first = tickets.find((t) => t.destination_id === ids.hot)!;
    const b1 = await call<{ events: { type: string }[] }>("POST", `/v1/kitchen-tickets/${first.id}/bump`, { token: US.admin.token, body: {} });
    expect(b1.status, JSON.stringify(b1.body)).toBe(200);
    expect(b1.body.events.map((e) => e.type)).toContain("order.kitchen_progress");
    let v = await view();
    expect(v.rounds.find((x) => x.id === r1.roundId)!.kitchen_done).toBe(true);
    expect(v.rounds.find((x) => x.id === r2.roundId)!.kitchen_done).toBe(false);
    expect(v.order.status).toBe("fired");
    await call("POST", `/v1/kitchen-tickets/${tickets.find((t) => t.destination_id === ids.bar)!.id}/bump`, { token: US.admin.token, body: {} });
    v = await view();
    expect(v.rounds.every((x) => x.kitchen_done)).toBe(true);
    expect(v.order.status).toBe("ready");
    // A recall takes the order back to sent, and that round is no longer done.
    await call("POST", `/v1/kitchen-tickets/${tickets.find((t) => t.destination_id === ids.bar)!.id}/recall`, { token: US.admin.token, body: {} });
    v = await view();
    expect(v.order.status).toBe("fired");
    expect(v.rounds.find((x) => x.id === r2.roundId)!.kitchen_done).toBe(false);
  });
});

describe("M9, M10: a rotated code and a paid bill reach every open phone at once, on the stream, with no 401", () => {
  const stream = async (g: string) => {
    const res = await app.request("/v1/guest/stream", { headers: { authorization: `Bearer ${g}` } });
    expect(res.status).toBe(200);
    return res;
  };
  it("rotating the table's code sends `ended` (code_rotated) on the open stream straight away", async () => {
    const g = await phone("t5", "device-m9-0001");
    await guestRound(g, ids.burger);
    const res = await stream(g);
    const got = readSse(res, 2, 3000);
    await new Promise((r) => setTimeout(r, 100));
    const rot = await call("POST", `/v1/tables/${ids.t5}/qr/rotate`, { token: US.admin.token, body: {} });
    expect(rot.status).toBe(201);
    const events = await got;
    expect(events[0]!.event).toBe("hello");
    expect(events[1]).toMatchObject({ event: "ended", data: { reason: "code_rotated" } });
  });

  it("paying the table's bill sends `ended` with order_paid, and the 401 afterwards says the bill is paid", async () => {
    const g = await phone("t6", "device-m9-0002");
    const r = await guestRound(g, ids.burger);
    await call("POST", `/v1/rounds/${r.roundId}/accept`, { token: pin, body: {} });
    const s = await snap(r.orderId);
    const res = await stream(g);
    const got = readSse(res, 2, 3000);
    await new Promise((x) => setTimeout(x, 100));
    const paid = await call<Mut>("POST", `/v1/checks/${s.checks[0]!.id}/payments`, { token: US.admin.token, body: { payment_id: randomUUID(), tender_type_id: ids.card, amount: s.balance } });
    expect(paid.body.data.status).toBe("completed");
    const events = await got;
    expect(events[1]).toMatchObject({ event: "ended", data: { reason: "order_paid" } });
    const after = await call<{ details: { reason: string } }>("GET", "/v1/guest/order", { token: g });
    expect(after.status).toBe(401);
    expect(after.body.details.reason).toBe("order_paid");
  });
});

describe("M5: an issued invoice shows on the bill wherever the bill is read", () => {
  it("the order, its bills and a reload all carry the invoice number", async () => {
    const o = await open({ order_type: "takeaway" });
    const a = await add(o.body.data.id, ids.burger);
    const checkId = a.body.data.checks[0]!.id;
    await call("POST", `/v1/checks/${checkId}/payments`, { token: US.admin.token, body: { payment_id: randomUUID(), tender_type_id: ids.card, amount: a.body.data.balance } });
    // Issued from the back office, as the owner does it (a signed-in session, not a station).
    const owner = await backOfficeSession(db.sql, US.merchantId, US.admin.id);
    const inv = await call<{ data: { invoice_no: string } }>("POST", `/v1/checks/${checkId}/invoice`, { token: owner, body: {} });
    expect(inv.status, JSON.stringify(inv.body)).toBeLessThan(300);
    const again = await call<{ data: { checks: { id: string; invoice_no: string | null }[] } }>("GET", `/v1/orders/${o.body.data.id}`, { token: owner });
    expect(again.body.data.checks.find((c) => c.id === checkId)!.invoice_no).toBe(inv.body.data.invoice_no);
    const list = await call<{ data: { id: string; invoice_no: string | null }[] }>("GET", `/v1/orders/${o.body.data.id}/checks`, { token: US.admin.token });
    expect(list.body.data.find((c) => c.id === checkId)!.invoice_no).toBe(inv.body.data.invoice_no);
  });
});
