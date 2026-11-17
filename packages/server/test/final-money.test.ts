import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TaxBreakdown } from "@sail/shared";
import "../src/modules.js";
import { buildApp, type App } from "../src/app.js";
import { resetGuestRateLimitsForTests } from "../src/services/guest.js";
import { api, freshDb, seedMerchant, type SeededMerchant, type TestDb } from "./helpers.js";

/** Final review round, money: a US diner (4% state + 4.5% local, rounded per rate). */
let db: TestDb;
let app: App;
let US: SeededMerchant;
let call: ReturnType<typeof api>["call"];
let pin: string;
const qr: Record<string, string> = {};
const ids = { mint: randomUUID(), a: randomUUID(), b: randomUUID(), c: randomUUID(), qrLink: randomUUID(), t2: randomUUID(), t3: randomUUID(), t4: randomUUID(), burger: randomUUID(), soda: randomUUID(), menu: randomUUID(), link: randomUUID(), area: randomUUID(), t1: randomUUID(), station: randomUUID(), cash: randomUUID(), card: randomUUID() };

type Snap = { id: string; version: number; status: string; totals: { subtotal: number; tax_total: number; taxes: TaxBreakdown[]; total: number }; lines: { id: string; status: string; amounts: { total: number; tax: number } }[]; checks: { id: string; total?: number; totals: { total: number; subtotal: number; tax_total: number }; balance: number; allocations: { line_id: string }[] }[]; balance: number; paid_total: number };
type Mut = { data: Snap; code?: string };

beforeAll(async () => {
  db = await freshDb({ GUEST_APP_URL: "https://order.example.test" });
  app = buildApp();
  call = api(app).call;
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
  await must("/v1/areas", { id: ids.area, outlet_id: US.outletId, name: "Main" });
  await must("/v1/channel-links", { id: ids.qrLink, channel: "scan_to_order", outlet_id: US.outletId, brand_id: US.brandId, menu_id: ids.menu, hold_orders: true, open_on_first_scan: true, service_requests: ["call_for_bill"] });
  for (const [k, name] of [["t1", "1"], ["t2", "2"], ["t3", "3"], ["t4", "4"]] as const) {
    await must("/v1/tables", { id: ids[k], outlet_id: US.outletId, area_id: ids.area, name });
    qr[k] = (await call<{ data: { url: string } }>("POST", `/v1/tables/${ids[k]}/qr/rotate`, { token: t, body: {} })).body.data.url;
  }
  await must("/v1/tender-types", { id: ids.cash, name: "Cash", is_cash: true });
  await must("/v1/shifts", { outlet_id: US.outletId, station_id: null, float_cents: 0 });
  await must("/v1/stations", { id: ids.station, outlet_id: US.outletId, brand_id: US.brandId, name: "Floor" });
  const code = await call<{ data: { code: string } }>("POST", `/v1/stations/${ids.station}/pairing-code`, { token: t, body: {} });
  const paired = await call<{ data: { station_token: string } }>("POST", "/v1/stations/pair", { body: { code: code.body.data.code, device_label: "iPad" }, idempotencyKey: null });
  pin = (await call<{ data: { session_token: string } }>("POST", "/v1/stations/sessions", { token: paired.body.data.station_token, body: { pin: "333333" } })).body.data.session_token;
});
afterAll(async () => db.drop());

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
