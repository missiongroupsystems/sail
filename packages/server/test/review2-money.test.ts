import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TaxBreakdown } from "@sail/shared";
import "../src/modules.js";
import { presetSeedRules, REGION_PRESETS } from "@sail/shared";
import { buildApp, type App } from "../src/app.js";
import { withTransaction } from "../src/db/client.js";
import { seedRulesForMerchant } from "../src/services/pricing-rules.js";
import { resetGuestRateLimitsForTests } from "../src/services/guest.js";
import { api, freshDb, seedMerchant, type SeededMerchant, type TestDb } from "./helpers.js";

/** Second review round, money: a US diner (4% state + 4.5% local) and an EU café (VAT 10% and 20% inside the price). */
let db: TestDb;
let app: App;
let call: ReturnType<typeof api>["call"];

type Snap = {
  id: string;
  version: number;
  status: string;
  totals: { subtotal: number; tax_total: number; taxes: TaxBreakdown[]; total: number };
  lines: { id: string; product_id: string; status: string; amounts: { total: number; tax: number } }[];
  checks: { id: string; label: string; locked: boolean; totals: { total: number; subtotal: number; tax_total: number; taxes: { name: string; amount: number }[] }; balance: number }[];
  balance: number;
};
type Mut = { data: Snap };

type World = { m: SeededMerchant; pin: string; station: string; cash: string; card: string; hot: string; products: Record<string, string>; qr: Record<string, string> };

async function world(name: string, preset: "us" | "eu-vat", products: { key: string; price: number; taxClass: string }[]): Promise<World> {
  const m = await seedMerchant(db.sql, name, preset === "us" ? { preset, timeZone: "America/New_York", locale: "en-US" } : { preset, timeZone: "Europe/Berlin", currency: "EUR", locale: "de-DE" });
  const t = m.admin.token;
  // The preset's manual discounts (no automatic rule in the US preset), for the items report's discounted row.
  if (preset === "us") await withTransaction(() => seedRulesForMerchant(m.merchantId, presetSeedRules(REGION_PRESETS.us, m.taxClassIds)));
  const must = async (path: string, body: unknown) => {
    const r = await call<{ data: { url?: string } }>("POST", path, { token: t, body });
    expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBeLessThan(300);
    return r.body.data;
  };
  const ids: Record<string, string> = {};
  for (const p of products) {
    ids[p.key] = randomUUID();
    await must("/v1/products", { id: ids[p.key], name: p.key, price: p.price, tags: ["kitchen"], tax_class_id: m.taxClassIds[p.taxClass] });
  }
  const menu = randomUUID();
  await must("/v1/menus", { id: menu, brand_id: m.brandId, name: "M", sections: [{ name: "All", items: Object.values(ids).map((product_id) => ({ product_id })) }] });
  await must("/v1/channel-links", { id: randomUUID(), channel: "pos", outlet_id: m.outletId, brand_id: m.brandId, menu_id: menu });
  await must("/v1/channel-links", { id: randomUUID(), channel: "scan_to_order", outlet_id: m.outletId, brand_id: m.brandId, menu_id: menu, hold_orders: true, open_on_first_scan: true });
  const hot = randomUUID();
  await must("/v1/display-destinations", { id: hot, outlet_id: m.outletId, name: "Hot line", include_tags: ["kitchen"], is_default: true });
  const area = randomUUID();
  await must("/v1/areas", { id: area, outlet_id: m.outletId, name: "Main" });
  const qr: Record<string, string> = {};
  for (const n of ["1", "2", "3", "4"]) {
    const id = randomUUID();
    await must("/v1/tables", { id, outlet_id: m.outletId, area_id: area, name: n });
    qr[n] = (await call<{ data: { url: string } }>("POST", `/v1/tables/${id}/qr/rotate`, { token: t, body: {} })).body.data.url;
    qr[`id${n}`] = id;
  }
  const cash = randomUUID();
  const card = randomUUID();
  await must("/v1/tender-types", { id: cash, name: "Cash", is_cash: true });
  await must("/v1/tender-types", { id: card, name: "Card" });
  await must("/v1/shifts", { outlet_id: m.outletId, station_id: null, float_cents: 0 });
  const station = randomUUID();
  await must("/v1/stations", { id: station, outlet_id: m.outletId, brand_id: m.brandId, name: "Floor" });
  const code = await call<{ data: { code: string } }>("POST", `/v1/stations/${station}/pairing-code`, { token: t, body: {} });
  const paired = await call<{ data: { station_token: string } }>("POST", "/v1/stations/pair", { body: { code: code.body.data.code, device_label: "iPad" }, idempotencyKey: null });
  const pin = (await call<{ data: { session_token: string } }>("POST", "/v1/stations/sessions", { token: paired.body.data.station_token, body: { pin: "333333" } })).body.data.session_token;
  return { m, pin, station, cash, card, hot, products: ids, qr };
}

let US: World;
let EU: World;

beforeAll(async () => {
  db = await freshDb({ GUEST_APP_URL: "https://order.example.test" });
  app = buildApp();
  call = api(app).call;
  US = await world("Diner", "us", [
    { key: "coffee", price: 279, taxClass: "prepared_food" },
    { key: "burger", price: 1449, taxClass: "prepared_food" },
    { key: "tea", price: 299, taxClass: "prepared_food" },
    { key: "water", price: 150, taxClass: "exempt" },
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

const open = (w: World, body: Record<string, unknown>) => call<Mut>("POST", "/v1/orders", { token: w.pin, body: { order_id: randomUUID(), ...body } });
const add = (w: World, orderId: string, keys: string[]) => call<Mut>("POST", `/v1/orders/${orderId}/lines`, { token: w.pin, body: { lines: keys.map((k) => ({ line_id: randomUUID(), product_id: w.products[k], quantity: 1 })) } });
const snap = async (w: World, id: string) => (await call<{ data: Snap }>("GET", `/v1/orders/${id}`, { token: w.pin })).body.data;
const pay = (w: World, checkId: string, amount: number) => call<Mut>("POST", `/v1/checks/${checkId}/payments`, { token: w.pin, body: { payment_id: randomUUID(), tender_type_id: w.cash, amount } });
const tax = (taxes: { name: string; amount: number }[], name: string) => taxes.find((x) => x.name === name)?.amount ?? 0;
const phone = async (w: World, table: string, device: string) => {
  await resetGuestRateLimitsForTests();
  const r = await call<{ data: { guest_token: string } }>("POST", "/v1/guest/sessions", { body: { token: w.qr[table]!.split("/t/")[1]!, device_id: device }, idempotencyKey: null });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data.guest_token;
};
const guestRound = async (w: World, g: string, keys: string[]) => {
  await resetGuestRateLimitsForTests();
  const round_id = randomUUID();
  const r = await call<{ data: { order: { id: string } } }>("POST", "/v1/guest/rounds", { token: g, body: { round_id, lines: keys.map((k) => ({ line_id: randomUUID(), product_id: w.products[k], quantity: 1 })) } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { roundId: round_id, orderId: r.body.data.order.id };
};
const bumpAll = async (w: World, orderId: string) => {
  const tickets = (await call<{ data: { id: string; order_id: string; status: string }[] }>("GET", `/v1/outlets/${w.m.outletId}/kitchen-tickets`, { token: w.m.admin.token })).body.data;
  for (const t of tickets.filter((x) => x.order_id === orderId && x.status !== "ready")) expect((await call("POST", `/v1/kitchen-tickets/${t.id}/bump`, { token: w.m.admin.token, body: {} })).status).toBe(200);
};
const settle = async (w: World, orderId: string) => {
  const s = await snap(w, orderId);
  for (const c of s.checks) if (c.balance > 0) expect((await pay(w, c.id, c.balance)).status).toBe(200);
};

/** Each rate's tax on the order is its rate times the order's taxable amount, rounded once, half up. */
const exclusiveRate = (taxableCents: number, bps: number) => Math.floor((taxableCents * bps + 5000) / 10000);
const inclusiveRate = (gross: number, bps: number) => Math.floor((gross * bps * 2 + (10000 + bps)) / (2 * (10000 + bps)));

describe("N1: a paid bill keeps its tax and the open bill takes the rest of the order's tax", () => {
  it("US: a QR round accepted after the first bill is paid leaves the order's tax its rate times its subtotal ($20.27 → $0.81 + $0.91)", async () => {
    const table = await open(US, { order_type: "dine_in", table_id: US.qr.id1, pax: 2 });
    expect(table.status, JSON.stringify(table.body)).toBe(201);
    const id = table.body.data.id;
    await add(US, id, ["coffee"]);
    expect((await call("POST", `/v1/orders/${id}/fire`, { token: US.pin, body: {} })).status).toBe(200);
    const g = await phone(US, "1", "device-n1-0001");
    const round = await guestRound(US, g, ["burger", "tea"]);
    expect(round.orderId).toBe(id);
    const before = await snap(US, id);
    expect(before.balance).toBe(303); // $2.79 + $0.11 + $0.13; the waiting round is not on the bill
    expect((await pay(US, before.checks[0]!.id, 303)).status).toBe(200);
    const accepted = await call<Mut>("POST", `/v1/rounds/${round.roundId}/accept`, { token: US.pin, body: {} });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const s = await snap(US, id);
    expect(s.totals.subtotal).toBe(2027);
    expect(tax(s.totals.taxes, "State sales tax")).toBe(81);
    expect(tax(s.totals.taxes, "Local sales tax")).toBe(91);
    expect(s.totals.total).toBe(2199);
    // The paid bill is unchanged; the open bill holds the rest of each rate, a cent from its own rate × taxable.
    const paid = s.checks.find((c) => c.locked)!;
    const rest = s.checks.find((c) => !c.locked)!;
    expect(paid.totals.total).toBe(303);
    expect(tax(paid.totals.taxes, "Local sales tax")).toBe(13);
    expect(tax(rest.totals.taxes, "Local sales tax")).toBe(78);
    expect(tax(rest.totals.taxes, "State sales tax")).toBe(70);
    expect(rest.balance).toBe(2199 - 303);
    for (const n of ["State sales tax", "Local sales tax"]) {
      const bps = n.startsWith("State") ? 400 : 450;
      expect(Math.abs(tax(rest.totals.taxes, n) - exclusiveRate(rest.totals.subtotal, bps))).toBeLessThanOrEqual(1);
    }
    await settle(US, id);
  });

  it("US: lines added after a part payment, and a tax-exempt line beside them, keep the order exact", async () => {
    const o = await open(US, { order_type: "takeaway" });
    const id = o.body.data.id;
    await add(US, id, ["coffee"]);
    const s0 = await snap(US, id);
    expect((await pay(US, s0.checks[0]!.id, 100)).status).toBe(200); // a part payment locks the bill
    await add(US, id, ["burger", "tea", "water"]);
    const s = await snap(US, id);
    expect(s.totals.subtotal).toBe(2177);
    expect(tax(s.totals.taxes, "State sales tax")).toBe(exclusiveRate(2027, 400));
    expect(tax(s.totals.taxes, "Local sales tax")).toBe(exclusiveRate(2027, 450));
    expect(s.totals.total).toBe(2177 + 81 + 91);
    expect(s.balance).toBe(s.totals.total - 100);
    expect(s.checks.reduce((n, c) => n + c.totals.total, 0)).toBe(s.totals.total);
    await settle(US, id);
    expect((await call("POST", `/v1/orders/${id}/fire`, { token: US.pin, body: {} })).status).toBe(200);
  });

  it("EU: VAT inside the price stays its rate's part of the order's gross after a paid bill (10% on €4.10 is €0.37, not €0.38)", async () => {
    const o = await open(EU, { order_type: "takeaway" });
    const id = o.body.data.id;
    await add(EU, id, ["juice", "wine"]);
    const s0 = await snap(EU, id);
    expect((await pay(EU, s0.checks[0]!.id, s0.balance)).status).toBe(200);
    await add(EU, id, ["juice", "soup", "wine"]);
    const s = await snap(EU, id);
    expect(s.totals.total).toBe(205 * 2 + 650 + 745 * 2);
    expect(tax(s.totals.taxes, "VAT 10%")).toBe(inclusiveRate(205 * 2 + 650, 1000));
    expect(tax(s.totals.taxes, "VAT 20%")).toBe(inclusiveRate(745 * 2, 2000));
    const rest = s.checks.find((c) => !c.locked)!;
    expect(rest.totals.total).toBe(205 + 650 + 745);
    expect(Math.abs(tax(rest.totals.taxes, "VAT 10%") - inclusiveRate(205 + 650, 1000))).toBeLessThanOrEqual(1);
    await settle(EU, id);
    expect((await call("POST", `/v1/orders/${id}/fire`, { token: EU.pin, body: {} })).status).toBe(200);
  });
});

describe("N4: a fire takes a ready order back to fired", () => {
  it("bump round 1, accept a QR round 2: the order is fired and round 2 is not done for the guest", async () => {
    const g = await phone(EU, "2", "device-n4-0001");
    const r1 = await guestRound(EU, g, ["soup"]);
    expect((await call("POST", `/v1/rounds/${r1.roundId}/accept`, { token: EU.pin, body: {} })).status).toBe(200);
    await bumpAll(EU, r1.orderId);
    expect((await snap(EU, r1.orderId)).status).toBe("ready");
    const r2 = await guestRound(EU, g, ["juice"]);
    expect((await snap(EU, r1.orderId)).status).toBe("ready"); // waiting for staff: nothing new is in the kitchen yet
    const acc = await call<Mut>("POST", `/v1/rounds/${r2.roundId}/accept`, { token: EU.pin, body: {} });
    expect(acc.status).toBe(200);
    expect((await snap(EU, r1.orderId)).status).toBe("fired");
    type View = { data: { order: { status: string }; rounds: { id: string; kitchen_done: boolean }[]; lines: { round_id: string | null; kitchen_done: boolean }[] } };
    const view = (await call<View>("GET", "/v1/guest/order", { token: g })).body.data;
    expect(view.order.status).toBe("fired");
    expect(view.rounds.find((r) => r.id === r1.roundId)!.kitchen_done).toBe(true);
    expect(view.rounds.find((r) => r.id === r2.roundId)!.kitchen_done).toBe(false);
    await bumpAll(EU, r1.orderId);
    expect((await snap(EU, r1.orderId)).status).toBe("ready");
    const done = (await call<View>("GET", "/v1/guest/order", { token: g })).body.data;
    expect(done.rounds.find((r) => r.id === r2.roundId)!.kitchen_done).toBe(true);
    await settle(EU, r1.orderId);
  });
});

describe("N10: the attached customer's name is the order's name", () => {
  it("a pickup for Pat with Robin attached is Robin's on the order, its kitchen ticket and the orders list", async () => {
    const o = await open(US, { order_type: "pickup", customer_ref: { name: "Pat", mobile: "555 010 2233" } });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    const id = o.body.data.id;
    await add(US, id, ["burger"]);
    expect((await call("POST", `/v1/orders/${id}/fire`, { token: US.pin, body: {} })).status).toBe(200);
    const robin = await call<{ data: { id: string } }>("PUT", "/v1/customers", { token: US.m.admin.token, body: { name: "Robin", mobile: "+1 555 010 7788" } });
    expect(robin.status, JSON.stringify(robin.body)).toBeLessThan(300);
    const at = await call<{ data: Snap & { customer_id: string; customer_ref: { name: string; mobile?: string } } }>("POST", `/v1/orders/${id}/customer`, { token: US.pin, body: { customer_id: robin.body.data.id } });
    expect(at.status, JSON.stringify(at.body)).toBe(200);
    expect(at.body.data.customer_ref).toEqual({ name: "Robin" }); // the mobile stays on the customer row
    const tickets = (await call<{ data: { order_id: string; customer_name: string | null }[] }>("GET", `/v1/outlets/${US.m.outletId}/kitchen-tickets`, { token: US.m.admin.token })).body.data.filter((t) => t.order_id === id);
    expect(tickets.length).toBeGreaterThan(0);
    expect(tickets.every((t) => t.customer_name === "Robin")).toBe(true);
    const list = await call<{ data: { id: string; customer_ref: { name: string } | null }[] }>("GET", `/v1/outlets/${US.m.outletId}/orders?q=Robin`, { token: US.m.admin.token });
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.data.find((x) => x.id === id)?.customer_ref?.name).toBe("Robin");
    await settle(US, id);
  });
});

describe("N2: split by seat with a shared line", () => {
  it("each bill is within a cent per rate of its own rate × subtotal, the bills add up to the order, and a bill with rounding says so", async () => {
    const o = await open(US, { order_type: "dine_in", table_id: US.qr.id3, pax: 3 });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    const id = o.body.data.id;
    const lines = [
      { key: "burger", seat: 1 },
      { key: "tea", seat: 2 },
      { key: "coffee", seat: 3 },
      { key: "burger", seat: null },
      { key: "coffee", seat: null },
    ];
    const r = await call<Mut>("POST", `/v1/orders/${id}/lines`, { token: US.pin, body: { lines: lines.map((l) => ({ line_id: randomUUID(), product_id: US.products[l.key], quantity: 1, seat_no: l.seat })) } });
    expect(r.status).toBe(200);
    const split = await call<Mut>("POST", `/v1/orders/${id}/checks/split-by-seat`, { token: US.pin, body: { shared: "even" } });
    expect(split.status, JSON.stringify(split.body).slice(0, 300)).toBe(200);
    const s = await snap(US, id);
    expect(s.checks.length).toBe(3);
    type C = Snap["checks"][number] & { tax_note: string | null };
    for (const n of ["State sales tax", "Local sales tax"]) {
      const bps = n.startsWith("State") ? 400 : 450;
      expect(s.checks.reduce((x, c) => x + tax(c.totals.taxes, n), 0)).toBe(tax(s.totals.taxes, n));
      for (const c of s.checks) expect(Math.abs(tax(c.totals.taxes, n) - exclusiveRate(c.totals.subtotal, bps)), `${c.label} ${n}`).toBeLessThanOrEqual(1);
    }
    expect(s.checks.reduce((x, c) => x + c.totals.total, 0)).toBe(s.totals.total);
    for (const c of s.checks as C[]) {
      const off = ["State sales tax", "Local sales tax"].some((n) => tax(c.totals.taxes, n) !== exclusiveRate(c.totals.subtotal, n.startsWith("State") ? 400 : 450));
      expect(c.tax_note, c.label).toBe(off ? "Tax includes rounding so the bills add up to the order's tax." : null);
    }
    expect((s.checks as C[]).filter((c) => c.tax_note).length).toBeGreaterThan(0); // these prices leave a cent to place
    await settle(US, id);
  });
});

describe("N5: a void of a sent item counts on the Z-report whatever became of its order", () => {
  it("a QR order's sent soup voided with a Manager, then the order cancelled: Voids 1 on the outlet's and the station's Z-report", async () => {
    type Z = { voids: { count: number; quantity: number; value: number } };
    const z = async (station?: string) => (await call<{ data: Z }>("GET", `/v1/outlets/${EU.m.outletId}/z-report${station ? `?station_id=${station}` : ""}`, { token: EU.m.admin.token })).body.data.voids;
    const before = { outlet: await z(), station: await z(EU.station) };
    const g = await phone(EU, "4", "device-n5-0001");
    const r = await guestRound(EU, g, ["soup"]);
    expect((await call("POST", `/v1/rounds/${r.roundId}/accept`, { token: EU.pin, body: {} })).status).toBe(200);
    const s = await snap(EU, r.orderId);
    const line = s.lines.find((l) => l.status === "fired")!;
    const v = await call("POST", `/v1/orders/${r.orderId}/lines/${line.id}/void`, { token: EU.m.manager.token, body: { reason_text: "Guest changed their mind" } });
    expect(v.status, JSON.stringify(v.body).slice(0, 300)).toBe(200);
    const cancel = await call("POST", `/v1/orders/${r.orderId}/cancel`, { token: EU.pin, body: { reason: "Guest left" } });
    expect(cancel.status, JSON.stringify(cancel.body).slice(0, 300)).toBe(200);
    expect(await z()).toEqual({ count: before.outlet.count + 1, quantity: before.outlet.quantity + 1, value: before.outlet.value + 650 });
    expect(await z(EU.station)).toEqual({ count: before.station.count + 1, quantity: before.station.quantity + 1, value: before.station.value + 650 });
  });
});

describe("N6: every row of the items report adds up after a refund", () => {
  type Row = { name: string; quantity: number; gross: number; discounts: number; tax: number; refunds: number; net: number };
  const mix = async (w: World) => (await call<{ data: Row[] }>("GET", `/v1/reports/product-mix?outlet_id=${w.m.outletId}&group_by=item`, { token: w.m.admin.token })).body.data;
  const refundOne = async (w: World, keys: string[], refundKey: string) => {
    const o = await open(w, { order_type: "takeaway" });
    const id = o.body.data.id;
    await add(w, id, keys);
    const s = await snap(w, id);
    expect((await pay(w, s.checks[0]!.id, s.balance)).status).toBe(200);
    expect((await call("POST", `/v1/orders/${id}/fire`, { token: w.pin, body: {} })).status).toBe(200);
    const after = await snap(w, id);
    const lineId = after.lines.find((l) => l.product_id === w.products[refundKey])!.id;
    const r = await call("POST", `/v1/checks/${after.checks[0]!.id}/refunds`, { token: w.m.manager.token, body: { refund_id: randomUUID(), request: { kind: "lines", lines: [{ line_id: lineId, quantity: 1 }] }, reason: "Spilled", print: false } });
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(201);
  };
  it("US: a refunded tea has its own Refunds figure, a discounted burger's row adds up, and nothing is tax in prices", async () => {
    await refundOne(US, ["tea", "tea"], "tea");
    const o = await open(US, { order_type: "takeaway" });
    await add(US, o.body.data.id, ["burger"]);
    const d = await call("POST", `/v1/orders/${o.body.data.id}/adjustments`, { token: US.m.manager.token, body: { application_id: randomUUID(), rule_key: "seed:percent-off-bill", entered_value: 2500, reason: "regular" } });
    expect(d.status, JSON.stringify(d.body).slice(0, 300)).toBe(200);
    await settle(US, o.body.data.id);
    expect((await call("POST", `/v1/orders/${o.body.data.id}/fire`, { token: US.pin, body: {} })).status).toBe(200);
    const burger = (await mix(US)).find((r) => r.name === "burger")!;
    expect(burger.discounts).toBeLessThan(0);
    expect(burger.tax).toBe(0);
    expect(burger.gross + burger.discounts - burger.refunds).toBe(burger.net);
    const tea = (await mix(US)).find((r) => r.name === "tea")!;
    expect(tea.refunds).toBe(299);
    expect(tea.tax).toBe(0);
    expect(tea.gross + tea.discounts - tea.tax - tea.refunds).toBe(tea.net);
  });
  it("EU: VAT inside the price is its own column, so the row adds up there too", async () => {
    await refundOne(EU, ["wine", "wine"], "wine");
    const rows = await mix(EU);
    for (const r of rows) expect(r.gross + r.discounts - r.tax - r.refunds, r.name).toBe(r.net);
    const wine = rows.find((r) => r.name === "wine")!;
    expect(wine.refunds).toBe(621); // €7.45 less its VAT 20% (€1.24)
    expect(wine.tax).toBeGreaterThan(0);
  });
});

describe("N7: the invoice PDF places the euro sign by its own width", () => {
  it("each standard font carries its glyph widths (the euro is 556/1000 em wide), so no viewer draws it over the first digit", async () => {
    const o = await open(EU, { order_type: "takeaway" });
    await add(EU, o.body.data.id, ["wine", "juice"]);
    const s = await snap(EU, o.body.data.id);
    expect((await pay(EU, s.checks[0]!.id, s.balance)).status).toBe(200);
    expect((await call("POST", `/v1/checks/${s.checks[0]!.id}/invoice`, { token: EU.pin, body: {} })).status).toBe(200);
    const res = await app.request(`/v1/checks/${s.checks[0]!.id}/invoice.pdf`, { headers: { authorization: `Bearer ${EU.m.admin.token}` } });
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer()).toString("latin1");
    const fonts = [...body.matchAll(/\/BaseFont \/(Helvetica(?:-Bold)?)\s+\/Encoding \/WinAnsiEncoding\s+\/FirstChar 32\s+\/LastChar 255\s+\/Widths \[([^\]]+)\]/g)];
    expect(fonts.map((f) => f[1]).sort()).toEqual(["Helvetica", "Helvetica-Bold"]);
    for (const f of fonts) {
      const widths = f[2]!.trim().split(/\s+/).map(Number);
      expect(widths).toHaveLength(224);
      expect(widths[0x80 - 32]).toBe(556); // the euro sign
      expect(widths["1".charCodeAt(0) - 32]).toBe(556);
    }
    await call("POST", `/v1/orders/${o.body.data.id}/fire`, { token: EU.pin, body: {} });
  });
});
