import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SEED_RULE_IDS } from "@sail/shared";
import { ALL_CASES } from "@sail/shared/reference";
import "../src/modules.js";
import { buildApp, type App } from "../src/app.js";
import { withTransaction } from "../src/db/client.js";
import { seedRulesForMerchant } from "../src/services/pricing-rules.js";
import { api, freshDb, readSse, seedMerchant, type SeededMerchant, type TestDb, sgSeedRules } from "./helpers.js";
import { startListener, stopListener } from "../src/sse/listener.js";

let db: TestDb;
let app: App;
let A: SeededMerchant;
let call: ReturnType<typeof api>["call"];

/** Catalogue for the order tests. */
const cat = {
  food: randomUUID(),
  noodles: randomUUID(),
  alcohol: randomUUID(),
  laksa: randomUUID(),
  wine: randomUUID(),
  kopi: randomUUID(),
  can: randomUUID(),
  openItem: randomUUID(),
  prawn: randomUUID(),
  chicken: randomUUID(),
  protein: randomUUID(),
  menu: randomUUID(),
  section: randomUUID(),
  link: randomUUID(),
  area: randomUUID(),
  table12: randomUUID(),
  table13: randomUUID(),
  station: randomUUID(),
  voidReason: randomUUID(),
  vipGroup: randomUUID(),
  customer: randomUUID(),
};
let stationToken: string;
let serverPin: string; // PIN session token for Sam Server on the station
let cashierPin: string;
let managerPin: string;

type Snap = { id: string; order_no: string; version: number; status: string; totals: { subtotal: number; discount_total: number; fee_total: number; tax_total: number; total: number }; lines: { id: string; status: string; quantity: number; amounts: { total: number; net: number; fee: number }; unit_price: number }[]; adjustments: { rule_key: string; total: number; manual_application_id: string | null }[] };
type Mut = { status: number; body: { data: Snap; events: { type: string; seq: number }[]; warnings: string[]; code?: string; message?: string; remedy?: string; details?: Record<string, unknown> } };

beforeAll(async () => {
  db = await freshDb();
  app = buildApp();
  call = api(app).call;
  A = await seedMerchant(db.sql, "Alpha");
  await withTransaction(() => seedRulesForMerchant(A.merchantId, sgSeedRules(A)));
  const t = A.admin.token;
  await call("POST", "/v1/categories", { token: t, body: { id: cat.food, name: "Food" } });
  await call("POST", "/v1/categories", { token: t, body: { id: cat.noodles, name: "Noodles", parent_id: cat.food } });
  await call("POST", "/v1/categories", { token: t, body: { id: cat.alcohol, name: "Alcohol" } });
  await call("POST", "/v1/products", { token: t, body: { id: cat.prawn, name: "Prawn", price: 200, kind: "component" } });
  await call("POST", "/v1/products", { token: t, body: { id: cat.chicken, name: "Chicken", price: 0, kind: "component" } });
  await call("POST", "/v1/modifier-groups", { token: t, body: { id: cat.protein, name: "Protein", min_select: 1, max_select: 1, options: [{ product_id: cat.prawn }, { product_id: cat.chicken }] } });
  await call("POST", "/v1/products", { token: t, body: { id: cat.laksa, name: "Laksa", sku: "LAK", price: 1600, category_id: cat.noodles, tags: ["kitchen"], prices_by_order_type: { delivery: 1800 }, modifier_group_ids: [cat.protein] } });
  await call("POST", "/v1/products", { token: t, body: { id: cat.wine, name: "House wine", price: 6000, category_id: cat.alcohol, tags: ["bar", "alcohol"] } });
  await call("POST", "/v1/products", { token: t, body: { id: cat.kopi, name: "Kopi", price: 180, tags: ["bar"] } });
  await call("POST", "/v1/products", { token: t, body: { id: cat.can, name: "Can", price: 250, has_deposit: true, tags: ["bar"] } });
  await call("POST", "/v1/products", { token: t, body: { id: cat.openItem, name: "Open item", price: 0, open_price: true } });
  await call("POST", "/v1/menus", { token: t, body: { id: cat.menu, brand_id: A.brandId, name: "All day", sections: [{ id: cat.section, name: "All", items: [cat.laksa, cat.wine, cat.kopi, cat.can, cat.openItem].map((product_id) => ({ product_id })) }] } });
  await call("POST", "/v1/channel-links", { token: t, body: { id: cat.link, channel: "pos", outlet_id: A.outletId, brand_id: A.brandId, menu_id: cat.menu } });
  await call("POST", "/v1/areas", { token: t, body: { id: cat.area, outlet_id: A.outletId, name: "Main" } });
  await call("POST", "/v1/tables", { token: t, body: { id: cat.table12, outlet_id: A.outletId, area_id: cat.area, name: "12", seats: 4 } });
  await call("POST", "/v1/tables", { token: t, body: { id: cat.table13, outlet_id: A.outletId, area_id: cat.area, name: "13", seats: 2 } });
  await call("POST", "/v1/void-reasons", { token: t, body: { id: cat.voidReason, name: "Changed mind" } });
  await call("POST", "/v1/customer-groups", { token: A.manager.token, body: { id: cat.vipGroup, name: "VIP" } });
  await call("PUT", "/v1/customers", { token: A.cashier.token, body: { id: cat.customer, name: "Lim", mobile: "+6591234567", group_ids: [cat.vipGroup] } });
  await call("POST", "/v1/pricing-rules", { token: t, body: { rule_key: "promo:food25", body: { kind: "discount", name: "25% off food", calc: "percent", value: { type: "fixed", amount: 2500 }, scope: { type: "categories", category_ids: [cat.food] }, priority: 10, application: "auto", report_class: "promo" }, effective_from: "2026-01-01T00:00:00Z" } });
  await call("POST", "/v1/pricing-rules", { token: t, body: { rule_key: "promo:vip-alcohol", body: { kind: "discount", name: "10% off alcohol above $100 (VIP)", calc: "percent", value: { type: "fixed", amount: 1000 }, scope: { type: "tags", tags: ["alcohol"] }, conditions: { min_spend: { amount: 10_000, basis: "scoped" }, customer_group_ids: [cat.vipGroup] }, priority: 20, application: "auto", report_class: "promo" }, effective_from: "2026-01-01T00:00:00Z" } });
  await call("POST", "/v1/stations", { token: t, body: { id: cat.station, outlet_id: A.outletId, brand_id: A.brandId, name: "Station 1", seats_enabled: true } });

  // Pair the station and sign in three staff members.
  const code = await call<{ data: { code: string } }>("POST", `/v1/stations/${cat.station}/pairing-code`, { token: t, body: {} });
  const paired = await call<{ data: { station_token: string } }>("POST", "/v1/stations/pair", { body: { code: code.body.data.code, device_label: "iPad 1" }, idempotencyKey: null });
  stationToken = paired.body.data.station_token;
  const signIn = async (pin: string) => (await call<{ data: { session_token: string } }>("POST", "/v1/stations/sessions", { token: stationToken, body: { pin } })).body.data.session_token;
  serverPin = await signIn("444444");
  cashierPin = await signIn("333333");
  managerPin = await signIn("222222");
  await startListener();
});
afterAll(async () => {
  await stopListener();
  await db.drop();
});

const open = (token: string, body: Record<string, unknown>) => call<Mut["body"]>("POST", "/v1/orders", { token, body: { order_id: randomUUID(), ...body } });
const laksaLine = (overrides: Record<string, unknown> = {}) => ({ line_id: randomUUID(), product_id: cat.laksa, quantity: 1, modifiers: [{ group_id: cat.protein, product_id: cat.prawn }], ...overrides });

describe("stations, PIN sessions and pairing", () => {
  it("a used pairing code cannot be reused; a station token alone cannot open orders", async () => {
    const r = await call<{ code: string }>("POST", "/v1/stations/pair", { body: { code: "000000", device_label: "x" }, idempotencyKey: null });
    expect(r.status).toBe(401);
    const me = await call<{ data: { type: string; outlet_id: string } }>("GET", "/v1/me", { token: stationToken });
    expect(me.body.data).toMatchObject({ type: "station", outlet_id: A.outletId });
    const denied = await open(stationToken, { order_type: "takeaway" });
    expect(denied.status).toBe(403);
    expect(denied.body.remedy).toMatch(/PIN/);
  });
  it("a station token alone reads its POS channel link, so the lock screen can warm the menu", async () => {
    const list = await call<{ data: { id: string }[] }>("GET", `/v1/channel-links?channel=pos&outlet_id=${A.outletId}&brand_id=${A.brandId}`, { token: stationToken });
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.data.map((l) => l.id)).toEqual([cat.link]);
    expect((await call("GET", `/v1/channel-links/${cat.link}`, { token: stationToken })).status).toBe(200);
    expect((await call("PATCH", `/v1/channel-links/${cat.link}`, { token: stationToken, body: { enabled: false } })).status).toBe(403);
  });
  it("a station token alone reads the merchant's settings, so the lock screen shows the outlet's time; it cannot change them", async () => {
    const m = await call<{ data: { settings: { timezone: string; locale: string; currency: string } } }>("GET", "/v1/merchant", { token: stationToken });
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    expect(m.body.data.settings).toMatchObject({ timezone: "Asia/Singapore", locale: "en-SG", currency: "SGD" });
    expect((await call("PATCH", "/v1/merchant/settings", { token: stationToken, body: { locale: "en-GB" } })).status).toBe(403);
  });
  it("a wrong PIN is rejected; a signed-in server has role server on the station", async () => {
    expect((await call("POST", "/v1/stations/sessions", { token: stationToken, body: { pin: "999999" } })).status).toBe(401);
    const me = await call<{ data: { type: string; role: string; station_id: string; via: string } }>("GET", "/v1/me", { token: serverPin });
    expect(me.body.data).toMatchObject({ type: "staff", role: "server", station_id: cat.station, via: "pin" });
  });
});

describe("orders of every type with server-authoritative pricing", () => {
  it("dine-in: open on a table, add lines, auto rules apply, totals match the pricing engine", async () => {
    const o = await open(serverPin, { order_type: "dine_in", table_id: cat.table12, pax: 3 });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    expect(o.body.data.order_no).toMatch(/^P-\d{4}$/);
    expect(o.body.data.totals.total).toBe(0);
    const added = await call<Mut["body"]>("POST", `/v1/orders/${o.body.data.id}/lines`, { token: serverPin, body: { expected_version: o.body.data.version, lines: [laksaLine({ seat_no: 1 }), { line_id: randomUUID(), product_id: cat.kopi, quantity: 2, seat_no: 2 }] } });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    const s = added.body.data;
    // Laksa with prawn: (1600+200) = 1800, 25% off food = 450 → net 1350. Kopi 2 × 180 = 360 (not food).
    // Service charge 10% on 1710 = 171 (135 + 36). GST 9% exclusive: 121.5→122 on laksa, 32.4→32 on kopi, 12.15→12 + 3.24→3 on SC.
    expect(s.totals.subtotal).toBe(1800 + 360);
    expect(s.totals.discount_total).toBe(-450);
    expect(s.totals.fee_total).toBe(171);
    expect(s.totals.tax_total).toBe(122 + 32 + 12 + 3);
    expect(s.totals.total).toBe(1350 + 360 + 171 + 122 + 32 + 12 + 3);
    expect(s.adjustments.map((a) => a.rule_key).sort()).toEqual(["promo:food25", SEED_RULE_IDS.serviceCharge].sort());
    expect(added.body.events.map((e) => e.type)).toEqual(["line.added", "line.added", "order.repriced"]);
    const [dbOrder] = await db.sql`select total from orders where id = ${s.id}`;
    expect(dbOrder!.total).toBe(s.totals.total);
  });

  it("a second order on the same table is refused; takeaway, pickup and delivery validate their fields", async () => {
    const dup = await open(serverPin, { order_type: "dine_in", table_id: cat.table12, pax: 2 });
    expect(dup.status).toBe(409);
    expect((await open(serverPin, { order_type: "pickup" })).status).toBe(400);
    expect((await open(serverPin, { order_type: "delivery", customer_ref: { name: "Raj", mobile: "91112222" } })).status).toBe(400);
    const pickup = await open(serverPin, { order_type: "pickup", customer_ref: { name: "Raj", mobile: "9111 2222" }, ready_by: new Date(Date.now() + 1800_000).toISOString() });
    expect(pickup.status).toBe(201);
    const [cust] = await db.sql`select name from customers where mobile = '91112222'`;
    expect(cust!.name).toBe("Raj"); // pickup orders create or match a customer
    const take = await open(cashierPin, { order_type: "takeaway", takeaway_ref: "Tan" });
    expect(take.status).toBe(201);
    const del = await open(cashierPin, { order_type: "delivery", customer_ref: { name: "Dee", mobile: "93334444" }, delivery_address: "1 Marina Way" });
    expect(del.status).toBe(201);
    const withLine = await call<Mut["body"]>("POST", `/v1/orders/${del.body.data.id}/lines`, { token: cashierPin, body: { lines: [laksaLine()] } });
    expect(withLine.body.data.lines[0]!.unit_price).toBe(1800); // delivery price
    expect(withLine.body.data.adjustments.find((a) => a.rule_key === SEED_RULE_IDS.serviceCharge)).toBeUndefined(); // dine-in only
  });

  it("changing the order type re-prices with the new type's prices and fees", async () => {
    const o = await open(serverPin, { order_type: "takeaway" });
    const a = await call<Mut["body"]>("POST", `/v1/orders/${o.body.data.id}/lines`, { token: serverPin, body: { lines: [laksaLine()] } });
    expect(a.body.data.lines[0]!.unit_price).toBe(1600);
    expect(a.body.data.totals.fee_total).toBe(0);
    const ch = await call<Mut["body"]>("POST", `/v1/orders/${o.body.data.id}/change-type`, { token: serverPin, body: { order_type: "delivery", customer_ref: { name: "Z" }, delivery_address: "2 Bay St", expected_version: a.body.data.version } });
    expect(ch.status, JSON.stringify(ch.body)).toBe(200);
    expect(ch.body.data.lines[0]!.unit_price).toBe(1800);
    const back = await call<Mut["body"]>("POST", `/v1/orders/${o.body.data.id}/change-type`, { token: serverPin, body: { order_type: "dine_in", table_id: cat.table13, pax: 2 } });
    expect(back.body.data.totals.fee_total).toBeGreaterThan(0); // service charge
    expect(back.body.data.lines[0]!.unit_price).toBe(1600);
    expect((await call("POST", `/v1/orders/${o.body.data.id}/cancel`, { token: serverPin, body: { reason: "test done" } })).status).toBe(200); // free table 13
  });

  it("attaching a VIP customer switches on the minimum-spend group discount; detaching removes it", async () => {
    const o = await open(serverPin, { order_type: "takeaway" });
    await call("POST", `/v1/orders/${o.body.data.id}/lines`, { token: serverPin, body: { lines: [{ line_id: randomUUID(), product_id: cat.wine, quantity: 2 }] } });
    const att = await call<Mut["body"]>("POST", `/v1/orders/${o.body.data.id}/customer`, { token: serverPin, body: { customer_id: cat.customer } });
    expect(att.body.data.adjustments.find((a) => a.rule_key === "promo:vip-alcohol")!.total).toBe(-1200);
    const det = await call<Mut["body"]>("DELETE", `/v1/orders/${o.body.data.id}/customer`, { token: serverPin, body: {} });
    expect(det.body.data.adjustments.find((a) => a.rule_key === "promo:vip-alcohol")).toBeUndefined();
  });

  it("modifier rules are enforced: a required choice, unknown options and too many selections are refused", async () => {
    const o = await open(serverPin, { order_type: "takeaway" });
    const missing = await call<Mut["body"]>("POST", `/v1/orders/${o.body.data.id}/lines`, { token: serverPin, body: { lines: [{ line_id: randomUUID(), product_id: cat.laksa, quantity: 1 }] } });
    expect(missing.status).toBe(400);
    expect(missing.body.message).toMatch(/Choose 1 more: Protein/);
    const tooMany = await call<Mut["body"]>("POST", `/v1/orders/${o.body.data.id}/lines`, { token: serverPin, body: { lines: [{ line_id: randomUUID(), product_id: cat.laksa, quantity: 1, modifiers: [{ group_id: cat.protein, product_id: cat.prawn }, { group_id: cat.protein, product_id: cat.chicken }] }] } });
    expect(tooMany.body.message).toMatch(/Choose up to 1/);
    const wrong = await call<Mut["body"]>("POST", `/v1/orders/${o.body.data.id}/lines`, { token: serverPin, body: { lines: [{ line_id: randomUUID(), product_id: cat.kopi, quantity: 1, modifiers: [{ group_id: cat.protein, product_id: cat.prawn }] }] } });
    expect(wrong.status).toBe(400);
    const [n] = await db.sql`select count(*)::int as n from order_lines where order_id = ${o.body.data.id}`;
    expect(n!.n).toBe(0); // all-or-nothing
  });

  it("open prices need Manager+ or an override; the override is single-use and bound to the order", async () => {
    const o = await open(serverPin, { order_type: "takeaway" });
    const denied = await call<Mut["body"]>("POST", `/v1/orders/${o.body.data.id}/lines`, { token: serverPin, body: { lines: [{ line_id: randomUUID(), product_id: cat.openItem, quantity: 1, open_price: 2500 }] } });
    expect(denied.status).toBe(403);
    expect(denied.body.details).toMatchObject({ required_role: "manager", override_allowed: true });
    const openLine = { line_id: randomUUID(), product_id: cat.openItem, quantity: 1, open_price: 2500 };
    const wrongPin = await call("POST", "/v1/overrides", { token: serverPin, body: { action: "lines.add_open_price", target_kind: "order", target_id: o.body.data.id, approver_pin: "444444", args: { lines: [openLine] } } });
    expect(wrongPin.status).toBe(403); // a server's own PIN is not a manager's
    const grant = await call<{ data: { override_id: string; approver: { name: string } } }>("POST", "/v1/overrides", { token: serverPin, body: { action: "lines.add_open_price", target_kind: "order", target_id: o.body.data.id, approver_pin: "222222", args: { lines: [openLine] } } });
    expect(grant.status).toBe(201);
    expect(grant.body.data.approver.name).toBe("Mia Manager");
    const ok = await call<Mut["body"]>("POST", `/v1/orders/${o.body.data.id}/lines`, { token: serverPin, body: { override_id: grant.body.data.override_id, lines: [openLine] } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.lines[0]!.unit_price).toBe(2500);
    const reuse = await call<Mut["body"]>("POST", `/v1/orders/${o.body.data.id}/lines`, { token: serverPin, body: { override_id: grant.body.data.override_id, lines: [openLine] } });
    expect(reuse.status).toBe(403);
    expect(reuse.body).toMatchObject({ message: "Manager approval is missing, used or expired" });
    const audit = await call<{ data: { action: string; approver_name: string }[] }>("GET", `/v1/audit?action=lines.add_open_price`, { token: A.admin.token });
    expect(audit.body.data[0]!.approver_name).toBe("Mia Manager");
  });

  it("fire, hold, void before and after sending (void after sending needs Manager+), cancel", async () => {
    const o = await open(serverPin, { order_type: "dine_in", table_id: cat.table13, pax: 2 });
    const lines = [laksaLine(), { line_id: randomUUID(), product_id: cat.kopi, quantity: 1, hold: true }];
    const added = await call<Mut["body"]>("POST", `/v1/orders/${o.body.data.id}/lines`, { token: serverPin, body: { lines } });
    expect(added.body.data.lines.map((l) => l.status)).toEqual(["pending", "held"]);
    const fired = await call<Mut["body"]>("POST", `/v1/orders/${o.body.data.id}/fire`, { token: serverPin, body: {} });
    expect(fired.status).toBe(200);
    expect(fired.body.data.status).toBe("fired");
    expect(fired.body.data.lines.map((l) => l.status)).toEqual(["fired", "held"]); // held lines wait
    const release = await call<Mut["body"]>("PATCH", `/v1/orders/${o.body.data.id}/lines/${lines[1]!.line_id}`, { token: serverPin, body: { hold: false } });
    expect(release.body.data.lines[1]!.status).toBe("pending");
    const noReason = await call<Mut["body"]>("POST", `/v1/orders/${o.body.data.id}/lines/${lines[1]!.line_id}/void`, { token: serverPin, body: {} });
    expect(noReason.status).toBe(400);
    const removed = await call<Mut["body"]>("POST", `/v1/orders/${o.body.data.id}/lines/${lines[1]!.line_id}/void`, { token: serverPin, body: { reason_id: cat.voidReason } });
    expect(removed.status).toBe(200);
    expect(removed.body.data.lines[1]!.status).toBe("voided");
    const deniedVoid = await call<Mut["body"]>("POST", `/v1/orders/${o.body.data.id}/lines/${lines[0]!.line_id}/void`, { token: serverPin, body: { reason_id: cat.voidReason } });
    expect(deniedVoid.status).toBe(403);
    const cancelBlocked = await call<Mut["body"]>("POST", `/v1/orders/${o.body.data.id}/cancel`, { token: serverPin, body: { reason: "test" } });
    expect(cancelBlocked.status).toBe(422);
    const managerVoid = await call<Mut["body"]>("POST", `/v1/orders/${o.body.data.id}/lines/${lines[0]!.line_id}/void`, { token: managerPin, body: { reason_id: cat.voidReason, reason_text: "Guest left" } });
    expect(managerVoid.status).toBe(200);
    expect(managerVoid.body.data.totals.total).toBe(0);
    const cancelled = await call<Mut["body"]>("POST", `/v1/orders/${o.body.data.id}/cancel`, { token: serverPin, body: { reason: "Guest left" } });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe("cancelled");
    const floor = await call<{ data: { business_date: string; tables: { id: string; status: string }[] } }>("GET", `/v1/outlets/${A.outletId}/floor`, { token: serverPin });
    expect(floor.body.data.tables.find((t) => t.id === cat.table13)!.status).toBe("free");
    expect(floor.body.data.tables.find((t) => t.id === cat.table12)!.status).toBe("seated");
    // The floor names the register's business day (after the cutoff), the one today's orders are filed under.
    const [filed] = await db.sql<{ business_date: string }[]>`select business_date from orders where id = ${o.body.data.id}`;
    expect(floor.body.data.business_date).toBe(filed!.business_date);
  });

  it("manual rules: a cashier applies staff meal with a reason; % off bill needs a manager; the waiver removes the service charge", async () => {
    const o = await open(cashierPin, { order_type: "dine_in", table_id: cat.table13, pax: 1 });
    const added = await call<Mut["body"]>("POST", `/v1/orders/${o.body.data.id}/lines`, { token: cashierPin, body: { lines: [{ line_id: randomUUID(), product_id: cat.kopi, quantity: 10 }] } });
    expect(added.body.data.totals.fee_total).toBe(180); // SC on 1800
    const noReason = await call<Mut["body"]>("POST", `/v1/orders/${o.body.data.id}/adjustments`, { token: cashierPin, body: { application_id: randomUUID(), rule_key: SEED_RULE_IDS.staffMeal } });
    expect(noReason.status).toBe(400);
    const staffMeal = await call<Mut["body"]>("POST", `/v1/orders/${o.body.data.id}/adjustments`, { token: cashierPin, body: { application_id: randomUUID(), rule_key: SEED_RULE_IDS.staffMeal, reason: "Staff lunch" } });
    expect(staffMeal.status, JSON.stringify(staffMeal.body)).toBe(200);
    expect(staffMeal.body.data.totals.discount_total).toBe(-900);
    expect(staffMeal.body.data.totals.fee_total).toBe(90); // SC on the discounted amount, never compounding
    const denied = await call<Mut["body"]>("POST", `/v1/orders/${o.body.data.id}/adjustments`, { token: cashierPin, body: { application_id: randomUUID(), rule_key: SEED_RULE_IDS.percentOffBill, entered_value: 1000 } });
    expect(denied.status).toBe(403);
    const outOfRange = await call<Mut["body"]>("POST", `/v1/orders/${o.body.data.id}/adjustments`, { token: managerPin, body: { application_id: randomUUID(), rule_key: SEED_RULE_IDS.percentOffItem, entered_value: 9000 } });
    expect(outOfRange.status).toBe(400);
    const waiverId = randomUUID();
    const waiver = await call<Mut["body"]>("POST", `/v1/orders/${o.body.data.id}/adjustments`, { token: managerPin, body: { application_id: waiverId, rule_key: SEED_RULE_IDS.serviceChargeWaiver, reason: "Kitchen 40 min late" } });
    expect(waiver.status).toBe(200);
    expect(waiver.body.data.totals.fee_total).toBe(0);
    expect(waiver.body.data.adjustments.find((a) => a.manual_application_id === waiverId)!.total).toBe(0);
    const removed = await call<Mut["body"]>("DELETE", `/v1/orders/${o.body.data.id}/adjustments/${waiverId}`, { token: managerPin, body: {} });
    expect(removed.body.data.totals.fee_total).toBe(90);
  });

  it("the back-office admin can read orders, the list and the floor; a server limited to another outlet cannot", async () => {
    const list = await call<{ data: Snap[] }>("GET", `/v1/outlets/${A.outletId}/orders?open_only=true`, { token: A.admin.token });
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBeGreaterThan(3);
    const other = await call("GET", `/v1/outlets/${A.outletId}/orders`, { token: A.outlet2Cashier.token });
    expect(other.status).toBe(404);
    const one = await call<{ data: Snap }>("GET", `/v1/orders/${list.body.data[0]!.id}`, { token: A.admin.token });
    expect(one.status).toBe(200);
    expect(one.headers.get("etag")).toBe(`"${one.body.data.version}"`);
  });
});

describe("concurrency, caps, dry runs and live updates", () => {
  it("a stale expected_version is rejected cleanly with the current version; appends without a version rebase", async () => {
    const o = await open(serverPin, { order_type: "takeaway" });
    const v1 = o.body.data.version;
    const a = await call<Mut["body"]>("POST", `/v1/orders/${o.body.data.id}/lines`, { token: serverPin, body: { expected_version: v1, lines: [{ line_id: randomUUID(), product_id: cat.kopi, quantity: 1 }] } });
    expect(a.status).toBe(200);
    const stale = await call<Mut["body"]>("PATCH", `/v1/orders/${o.body.data.id}`, { token: cashierPin, body: { expected_version: v1, notes: "stale" } });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("version_conflict");
    expect(stale.body.details).toMatchObject({ current_version: a.body.data.version, expected_version: v1 });
    const rebase = await call<Mut["body"]>("POST", `/v1/orders/${o.body.data.id}/lines`, { token: cashierPin, body: { lines: [{ line_id: randomUUID(), product_id: cat.kopi, quantity: 1 }] } });
    expect(rebase.status).toBe(200);
    expect(rebase.body.data.lines).toHaveLength(2);
  });

  it("two stations selling the last unit of a capped item: exactly one succeeds", async () => {
    await call("POST", "/v1/stock/daily-cap", { token: A.manager.token, body: { outlet_id: A.outletId, product_id: cat.can, quantity: 1 } });
    const o1 = await open(serverPin, { order_type: "takeaway" });
    const o2 = await open(cashierPin, { order_type: "takeaway" });
    const [r1, r2] = await Promise.all([
      call<Mut["body"]>("POST", `/v1/orders/${o1.body.data.id}/lines`, { token: serverPin, body: { lines: [{ line_id: randomUUID(), product_id: cat.can, quantity: 1 }] } }),
      call<Mut["body"]>("POST", `/v1/orders/${o2.body.data.id}/lines`, { token: cashierPin, body: { lines: [{ line_id: randomUUID(), product_id: cat.can, quantity: 1 }] } }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 422]);
    const failed = r1.status === 422 ? r1 : r2;
    expect(failed.body.code).toBe("unavailable");
    // Voiding the sold unit before firing releases the cap.
    const winner = r1.status === 200 ? { r: r1, o: o1 } : { r: r2, o: o2 };
    const voided = await call<Mut["body"]>("POST", `/v1/orders/${winner.o.body.data.id}/lines/${winner.r.body.data.lines[0]!.id}/void`, { token: serverPin, body: { reason_id: cat.voidReason } });
    expect(voided.status).toBe(200);
    const again = await call<Mut["body"]>("POST", `/v1/orders/${o1.body.data.id}/lines`, { token: serverPin, body: { lines: [{ line_id: randomUUID(), product_id: cat.can, quantity: 1 }] } });
    expect(again.status).toBe(200);
    await call("POST", "/v1/stock/daily-cap", { token: A.manager.token, body: { outlet_id: A.outletId, product_id: cat.can, quantity: null } });
  });

  it("a dry run returns the priced result but commits nothing and emits no events", async () => {
    const o = await open(serverPin, { order_type: "takeaway" });
    const before = await call<{ latest_seq: number }>("GET", `/v1/outlets/${A.outletId}/events?after=999999`, { token: A.admin.token });
    const dry = await call<Mut["body"]>("POST", `/v1/orders/${o.body.data.id}/lines`, { token: serverPin, body: { dry_run: true, lines: [laksaLine()] } });
    expect(dry.status).toBe(200);
    expect(dry.headers.get("x-dry-run")).toBe("true");
    expect(dry.body.data.totals.total).toBeGreaterThan(0);
    expect(dry.body.events.every((e) => e.seq === -1)).toBe(true);
    const after = await call<{ latest_seq: number }>("GET", `/v1/outlets/${A.outletId}/events?after=999999`, { token: A.admin.token });
    expect(after.body.latest_seq).toBe(before.body.latest_seq);
    const real = await call<{ data: Snap }>("GET", `/v1/orders/${o.body.data.id}`, { token: serverPin });
    expect(real.body.data.lines).toHaveLength(0);
    expect(real.body.data.version).toBe(o.body.data.version);
  });

  it("another station sees changes through the outlet stream and catches up from the event log", async () => {
    const res = await app.request(`/v1/outlets/${A.outletId}/stream`, { headers: { authorization: `Bearer ${cashierPin}` } });
    const pending = readSse(res, 3, 5000);
    await new Promise((r) => setTimeout(r, 100));
    const o = await open(serverPin, { order_type: "takeaway" });
    const got = await pending;
    expect(got[0]!.event).toBe("hello");
    expect(got.slice(1).map((e) => (e.data as { type: string }).type)).toEqual(["order.opened", "order.repriced"]);
    const hello = got[0]!.data as { seq: number };
    const catchUp = await call<{ data: { type: string; aggregate: { id: string } }[] }>("GET", `/v1/outlets/${A.outletId}/events?after=${hello.seq}`, { token: cashierPin });
    expect(catchUp.body.data.map((e) => e.type)).toEqual(["order.opened", "order.repriced"]);
    expect(catchUp.body.data[0]!.aggregate.id).toBe(o.body.data.id);
  });

  it("the reference set replayed through the API gives stored totals that match to the cent", async () => {
    // Cases that use only base prices and the seed rules can be replayed as real orders.
    const replayable = ALL_CASES.filter((c) => c.rules.length === 8 && c.rules.every((r) => r.id.startsWith("seed:")) && !c.context.frozen && c.context.tax_mode === "exclusive" && (c.order.manual_applications ?? []).length === 0 && c.order.lines.every((l) => !l.open_price && (l.modifiers ?? []).length === 0 && l.quantity > 0));
    expect(replayable.length).toBeGreaterThanOrEqual(2);
    // Archive the demo discounts so only the seed rules apply, as in the cases.
    await call("POST", `/v1/pricing-rules/promo:food25/archive`, { token: A.admin.token, body: {} });
    await call("POST", `/v1/pricing-rules/promo:vip-alcohol/archive`, { token: A.admin.token, body: {} });
    for (const c of replayable) {
      // Create products matching the case's lines on the fly.
      const lines: { line_id: string; product_id: string; quantity: number }[] = [];
      for (const l of c.order.lines) {
        const pid = randomUUID();
        await call("POST", "/v1/products", { token: A.admin.token, body: { id: pid, name: l.name ?? l.line_id, price: l.prices.base, has_deposit: l.has_deposit ?? false, tags: l.tags ?? [], prices_by_order_type: l.prices.by_order_type ?? {} } });
        lines.push({ line_id: randomUUID(), product_id: pid, quantity: l.quantity });
      }
      const menu = await call<{ data: { sections: { id: string; items: { product_id: string }[] }[] } }>("GET", `/v1/menus/${cat.menu}`, { token: A.admin.token });
      const section = menu.body.data.sections[0]!;
      await call("PATCH", `/v1/menus/${cat.menu}`, { token: A.admin.token, body: { sections: [{ id: section.id, name: "All", items: [...section.items, ...lines.map((l) => ({ product_id: l.product_id }))] }] } });
      const freshTable = randomUUID();
      await call("POST", "/v1/tables", { token: A.admin.token, body: { id: freshTable, outlet_id: A.outletId, area_id: cat.area, name: `R-${c.id}`, seats: 2 } });
      const o = await open(serverPin, c.order.order_type === "dine_in" ? { order_type: "dine_in", table_id: freshTable, pax: 2 } : c.order.order_type === "delivery" ? { order_type: "delivery", customer_ref: { name: "R" }, delivery_address: "x" } : c.order.order_type === "pickup" ? { order_type: "pickup", customer_ref: { name: "R" } } : { order_type: "takeaway" });
      expect(o.status, `${c.id} open`).toBe(201);
      const r = await call<Mut["body"]>("POST", `/v1/orders/${o.body.data.id}/lines`, { token: serverPin, body: { lines } });
      expect(r.status, `${c.id} ${JSON.stringify(r.body).slice(0, 200)}`).toBe(200);
      expect(r.body.data.totals.total, `${c.id} total`).toBe(c.expect.total);
      if (c.expect.tax_total != null) expect(r.body.data.totals.tax_total, `${c.id} tax`).toBe(c.expect.tax_total);
      await call("POST", `/v1/orders/${o.body.data.id}/cancel`, { token: serverPin, body: { reason: "replay" } });
    }
  });
});
