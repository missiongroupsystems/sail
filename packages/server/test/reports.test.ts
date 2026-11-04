import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SEED_RULE_IDS } from "@sail/shared";
import "../src/modules.js";
import { buildApp, type App } from "../src/app.js";
import { withTransaction } from "../src/db/client.js";
import { seedRulesForMerchant } from "../src/services/pricing-rules.js";
import { api, freshDb, seedMerchant, type SeededMerchant, type TestDb } from "./helpers.js";

let db: TestDb;
let app: App;
let A: SeededMerchant;
let call: ReturnType<typeof api>["call"];
let cashierPin: string;
let managerPin: string;
const ids = { food: randomUUID(), drinks: randomUUID(), laksa: randomUUID(), kopi: randomUUID(), menu: randomUUID(), link: randomUUID(), area: randomUUID(), table: randomUUID(), station: randomUUID(), cash: randomUUID(), card: randomUUID(), printer: randomUUID(), reason: randomUUID() };
type Snap = { id: string; totals: { total: number; subtotal: number; discount_total: number; fee_total: number; gst_total: number }; checks: { id: string; totals: { total: number } }[]; lines: { id: string }[] };

beforeAll(async () => {
  db = await freshDb();
  app = buildApp();
  call = api(app).call;
  A = await seedMerchant(db.sql, "Alpha");
  await withTransaction(() => seedRulesForMerchant(A.merchantId));
  const t = A.admin.token;
  await call("PATCH", "/v1/merchant/settings", { token: t, body: { cash_rounding_increment: 5 } });
  await call("POST", "/v1/categories", { token: t, body: { id: ids.food, name: "Food" } });
  await call("POST", "/v1/categories", { token: t, body: { id: ids.drinks, name: "Drinks" } });
  await call("POST", "/v1/products", { token: t, body: { id: ids.laksa, name: "Laksa", price: 1600, category_id: ids.food, tags: ["kitchen"] } });
  await call("POST", "/v1/products", { token: t, body: { id: ids.kopi, name: "Kopi", price: 180, category_id: ids.drinks, tags: ["bar"] } });
  await call("POST", "/v1/menus", { token: t, body: { id: ids.menu, brand_id: A.brandId, name: "M", sections: [{ name: "All", items: [{ product_id: ids.laksa }, { product_id: ids.kopi }] }] } });
  await call("POST", "/v1/channel-links", { token: t, body: { id: ids.link, channel: "pos", outlet_id: A.outletId, brand_id: A.brandId, menu_id: ids.menu } });
  await call("POST", "/v1/areas", { token: t, body: { id: ids.area, outlet_id: A.outletId, name: "Main" } });
  await call("POST", "/v1/tables", { token: t, body: { id: ids.table, outlet_id: A.outletId, area_id: ids.area, name: "1" } });
  await call("POST", "/v1/tender-types", { token: t, body: { id: ids.cash, name: "Cash", is_cash: true } });
  await call("POST", "/v1/tender-types", { token: t, body: { id: ids.card, name: "Card", is_terminal: true } });
  await call("POST", "/v1/printers", { token: t, body: { id: ids.printer, outlet_id: A.outletId, name: "Kitchen", ip: "10.0.0.1", is_default_kitchen: true, backup_printer_id: null } });
  await call("POST", "/v1/void-reasons", { token: t, body: { id: ids.reason, name: "Mistake" } });
  await call("POST", "/v1/stations", { token: t, body: { id: ids.station, outlet_id: A.outletId, brand_id: A.brandId, name: "Floor" } });
  const code = await call<{ data: { code: string } }>("POST", `/v1/stations/${ids.station}/pairing-code`, { token: t, body: {} });
  const paired = await call<{ data: { station_token: string } }>("POST", "/v1/stations/pair", { body: { code: code.body.data.code, device_label: "iPad" }, idempotencyKey: null });
  const signIn = async (pin: string) => (await call<{ data: { session_token: string } }>("POST", "/v1/stations/sessions", { token: paired.body.data.station_token, body: { pin } })).body.data.session_token;
  cashierPin = await signIn("333333");
  managerPin = await signIn("222222");

  // A day of trade: 3 completed orders (one with a staff-meal discount, one refunded partly), 1 void, 1 open order.
  const open = (body: Record<string, unknown>) => call<{ data: Snap }>("POST", "/v1/orders", { token: cashierPin, body: { order_id: randomUUID(), ...body } });
  const complete = async (o: Snap, tender: string, lines: Record<string, unknown>[], extra?: () => Promise<void>) => {
    const added = await call<{ data: Snap }>("POST", `/v1/orders/${o.id}/lines`, { token: cashierPin, body: { lines } });
    if (extra) await extra();
    await call("POST", `/v1/orders/${o.id}/fire`, { token: cashierPin, body: {} });
    const snap = (await call<{ data: Snap }>("GET", `/v1/orders/${o.id}`, { token: cashierPin })).body.data;
    const paid = await call<{ data: Snap; code?: string }>("POST", `/v1/checks/${snap.checks[0]!.id}/payments`, { token: cashierPin, body: { payment_id: randomUUID(), tender_type_id: tender, amount: snap.checks[0]!.totals.total, tendered: tender === ids.cash ? 10_000 : undefined } });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    return { snap: paid.body.data, added: added.body.data };
  };
  const o1 = await open({ order_type: "dine_in", table_id: ids.table, pax: 2 });
  await complete(o1.body.data, ids.cash, [{ line_id: randomUUID(), product_id: ids.laksa, quantity: 2 }, { line_id: randomUUID(), product_id: ids.kopi, quantity: 2 }]);
  const o2 = await open({ order_type: "takeaway" });
  await complete(o2.body.data, ids.card, [{ line_id: randomUUID(), product_id: ids.laksa, quantity: 1 }], async () => {
    await call("POST", `/v1/orders/${o2.body.data.id}/adjustments`, { token: cashierPin, body: { application_id: randomUUID(), rule_key: SEED_RULE_IDS.staffMeal, reason: "Staff lunch" } });
  });
  const o3 = await open({ order_type: "takeaway" });
  const lineToVoid = randomUUID();
  const r3 = await complete(o3.body.data, ids.card, [{ line_id: randomUUID(), product_id: ids.kopi, quantity: 3 }, { line_id: lineToVoid, product_id: ids.kopi, quantity: 1 }], async () => {
    await call("POST", `/v1/orders/${o3.body.data.id}/lines/${lineToVoid}/void`, { token: cashierPin, body: { reason_id: ids.reason } });
  });
  await call("POST", `/v1/checks/${r3.snap.checks[0]!.id}/refunds`, { token: managerPin, body: { refund_id: randomUUID(), request: { kind: "amount", amount: 100 }, reason: "Spilled", print: false } });
  await open({ order_type: "takeaway" }); // left open: not a sale yet
});
afterAll(async () => {
  await db.drop();
});

describe("reports", () => {
  it("sales summary: totals equal the sum of completed orders; breakdowns by tender, category, rule and class; voids and refunds; a server cannot run it", async () => {
    expect((await call("GET", `/v1/reports/sales-summary?outlet_id=${A.outletId}`, { token: A.server.token })).status).toBe(403);
    const r = await call<{ data: { totals: Record<string, number>; by_tender: { tender: string; amount: number; rounding: number }[]; by_category: { category: string; quantity: number; net: number }[]; adjustments_by_rule: { rule_key: string; total: number }[]; adjustments_by_class: { report_class: string; total: number }[]; by_order_type: { order_type: string; orders: number }[]; by_source: { source: string; orders: number }[]; voids: { count: number; quantity: number; value: number }; refunds: { count: number; amount: number; by_kind: { kind: string }[] } } }>("GET", `/v1/reports/sales-summary?outlet_id=${A.outletId}`, { token: A.manager.token });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const d = r.body.data;
    const [db1] = await db.sql`select count(*)::int as orders, sum(total)::int as net, sum(subtotal)::int as gross, sum(discount_total)::int as discounts, sum(fee_total)::int as fees, sum(gst_total)::int as gst from orders where outlet_id = ${A.outletId} and status = 'completed'`;
    expect(d.totals.orders).toBe(3);
    expect(d.totals).toMatchObject({ net: db1!.net, gross: db1!.gross, discounts: db1!.discounts, fees: db1!.fees, gst: db1!.gst, refunds: 100, net_after_refunds: db1!.net - 100 });
    expect(d.totals.items).toBe(2 + 2 + 1 + 3);
    expect(d.by_order_type.map((x) => [x.order_type, x.orders]).sort()).toEqual([["dine_in", 1], ["takeaway", 2]]);
    expect(d.by_source).toEqual([{ source: "pos", orders: 3, net: db1!.net }]);
    const cash = d.by_tender.find((t) => t.tender === "Cash")!;
    const card = d.by_tender.find((t) => t.tender === "Card")!;
    const [pay] = await db.sql`select sum(amount) filter (where is_cash)::int as cash, sum(rounding_cents) filter (where is_cash)::int as rounding, sum(amount) filter (where not is_cash)::int as card from payments where outlet_id = ${A.outletId} and status = 'recorded'`;
    expect(cash.amount).toBe(pay!.cash);
    expect(cash.rounding).toBe(pay!.rounding);
    expect(card.amount).toBe(pay!.card);
    expect(d.totals.rounding).toBe(pay!.rounding);
    expect(d.by_category.map((c) => [c.category, c.quantity])).toEqual(expect.arrayContaining([["Food", 3], ["Drinks", 5]]));
    expect(d.adjustments_by_rule.find((a) => a.rule_key === SEED_RULE_IDS.staffMeal)!.total).toBe(-800);
    expect(d.adjustments_by_rule.find((a) => a.rule_key === SEED_RULE_IDS.serviceCharge)).toBeDefined(); // dine-in order
    expect(d.adjustments_by_class.map((a) => a.report_class).sort()).toEqual(["service_charge", "staff_meal"]);
    expect(d.voids).toEqual({ count: 1, quantity: 1, value: 180 });
    expect(d.refunds).toMatchObject({ count: 1, amount: 100 });
    expect(d.refunds.by_kind[0]!.kind).toBe("amount");
  });

  it("filters narrow the figures; CSV export works", async () => {
    const take = await call<{ data: { totals: { orders: number } } }>("GET", `/v1/reports/sales-summary?outlet_id=${A.outletId}&order_type=takeaway`, { token: A.manager.token });
    expect(take.body.data.totals.orders).toBe(2);
    const food = await call<{ data: { totals: { items: number }; by_category: { category: string }[] } }>("GET", `/v1/reports/sales-summary?outlet_id=${A.outletId}&category_id=${ids.food}`, { token: A.manager.token });
    expect(food.body.data.totals.items).toBe(3);
    expect(food.body.data.by_category.map((c) => c.category)).toEqual(["Food"]);
    const none = await call<{ data: { totals: { orders: number } } }>("GET", `/v1/reports/sales-summary?outlet_id=${A.outletId}&from=2020-01-01&to=2020-01-02`, { token: A.manager.token });
    expect(none.body.data.totals.orders).toBe(0);
    const other = await call<{ data: { totals: { orders: number } } }>("GET", `/v1/reports/sales-summary?outlet_id=${A.outlet2Id}`, { token: A.manager.token });
    expect(other.body.data.totals.orders).toBe(0);
    const csv = await call<string>("GET", `/v1/reports/sales-summary?outlet_id=${A.outletId}&format=csv`, { token: A.manager.token });
    expect(csv.headers.get("content-type")).toMatch(/text\/csv/);
    expect(csv.body).toMatch(/^section,/);
    expect(csv.body).toMatch(/by_tender,Cash,true/);
    expect(csv.body).toMatch(/adjustment,seed:staff-meal/);
  });

  it("product mix by item, category and staff with shares adding up; exceptions report shows who, approver and reason; print health lists late jobs", async () => {
    const items = await call<{ data: { name: string; quantity: number; net: number; share_bps: number }[] }>("GET", `/v1/reports/product-mix?outlet_id=${A.outletId}&group_by=item`, { token: A.manager.token });
    expect(items.body.data.map((r) => r.name).sort()).toEqual(["Kopi", "Laksa"]);
    expect(items.body.data.reduce((s, r) => s + r.share_bps, 0)).toBeGreaterThanOrEqual(9999);
    const cats = await call<{ data: { name: string; quantity: number }[] }>("GET", `/v1/reports/product-mix?outlet_id=${A.outletId}&group_by=category`, { token: A.manager.token });
    expect(cats.body.data.find((r) => r.name === "Drinks")!.quantity).toBe(5);
    const staff = await call<{ data: { name: string }[] }>("GET", `/v1/reports/product-mix?outlet_id=${A.outletId}&group_by=staff&format=csv`, { token: A.manager.token });
    expect(staff.body as unknown as string).toMatch(/Cal Cashier/);

    const ex = await call<{ data: { voids: { product_name: string; reason: string; voided_by: string; after_firing: boolean }[]; discounts: { rule_key: string; applied_by: string; reason: string }[]; refunds: { kind: string; refunded_by: string; reason: string; refund_receipt_no: string }[] } }>("GET", `/v1/reports/exceptions?outlet_id=${A.outletId}`, { token: A.manager.token });
    expect(ex.body.data.voids[0]).toMatchObject({ product_name: "Kopi", reason: "Mistake", voided_by: "Cal Cashier", after_firing: false });
    expect(ex.body.data.discounts[0]).toMatchObject({ rule_key: SEED_RULE_IDS.staffMeal, applied_by: "Cal Cashier", reason: "Staff lunch" });
    expect(ex.body.data.refunds[0]).toMatchObject({ kind: "amount", refunded_by: "Mia Manager", reason: "Spilled", refund_receipt_no: "RR-000001" });

    await db.sql`update print_jobs set created_at = created_at - interval '30 seconds' where outlet_id = ${A.outletId}`;
    const ph = await call<{ data: { printer_name: string; jobs: number; printed: number; late: number }[] }>("GET", `/v1/reports/print-health?outlet_id=${A.outletId}`, { token: A.manager.token });
    expect(ph.status, JSON.stringify(ph.body)).toBe(200);
    expect(ph.body.data[0]).toMatchObject({ printer_name: "Kitchen", printed: 0 });
    expect(ph.body.data[0]!.late).toBe(ph.body.data[0]!.jobs);
  });

  it("the daily outlet report combines the Z-report and the summary; the PDF renders", async () => {
    const r = await call<{ data: { business_date: string; z_report: { sales: { net: number }; orders: { count: number } }; summary: { totals: { net: number } } } }>("GET", `/v1/outlets/${A.outletId}/reports/daily`, { token: A.manager.token });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.z_report.orders.count).toBe(3);
    expect(r.body.data.z_report.sales.net).toBe(r.body.data.summary.totals.net);
    const pdf = await app.request(`/v1/outlets/${A.outletId}/reports/daily?format=pdf`, { headers: { authorization: `Bearer ${A.manager.token}` } });
    expect(pdf.status).toBe(200);
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString()).toBe("%PDF");
    expect((await call("GET", `/v1/outlets/${A.outletId}/reports/daily`, { token: A.outlet2Cashier.token })).status).toBe(403); // Cashier: no reports permission
    expect((await call("GET", `/v1/outlets/${randomUUID()}/reports/daily`, { token: A.manager.token })).status).toBe(404); // unknown outlet
  });
});
