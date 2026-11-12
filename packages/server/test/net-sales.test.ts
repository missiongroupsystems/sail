import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { presetSeedRules, REGION_PRESETS } from "@sail/shared";
import "../src/modules.js";
import { buildApp, type App } from "../src/app.js";
import { withTransaction } from "../src/db/client.js";
import { seedRulesForMerchant } from "../src/services/pricing-rules.js";
import { api, freshDb, seedMerchant, type SeededMerchant, type TestDb } from "./helpers.js";

/**
 * What "net sales" means in the Z-report, the sales summary and the product
 * mix: item sales after discounts, without tax and fees, less the net of
 * refunds. Fees, tax and refunds are figures of their own, and the collected
 * total stays, so the tenders still add up to it. One dine-in order with a 10%
 * service charge, two units of one item, one unit refunded, in each tax mode.
 */
let db: TestDb;
let app: App;
let call: ReturnType<typeof api>["call"];

type Shop = { m: SeededMerchant; manager: string; orderTotal: number };
const shops: Record<"exclusive" | "inclusive", Shop> = {} as Record<"exclusive" | "inclusive", Shop>;

async function trade(m: SeededMerchant, price: number): Promise<Shop> {
  const t = m.admin.token;
  const ids = { item: randomUUID(), menu: randomUUID(), link: randomUUID(), area: randomUUID(), table: randomUUID(), cash: randomUUID(), station: randomUUID() };
  await call("POST", "/v1/products", { token: t, body: { id: ids.item, name: "Main", price } });
  await call("POST", "/v1/menus", { token: t, body: { id: ids.menu, brand_id: m.brandId, name: "M", sections: [{ name: "All", items: [{ product_id: ids.item }] }] } });
  await call("POST", "/v1/channel-links", { token: t, body: { id: ids.link, channel: "pos", outlet_id: m.outletId, brand_id: m.brandId, menu_id: ids.menu } });
  await call("POST", "/v1/areas", { token: t, body: { id: ids.area, outlet_id: m.outletId, name: "Main" } });
  await call("POST", "/v1/tables", { token: t, body: { id: ids.table, outlet_id: m.outletId, area_id: ids.area, name: "1" } });
  await call("POST", "/v1/tender-types", { token: t, body: { id: ids.cash, name: "Cash", is_cash: true } });
  await call("POST", "/v1/stations", { token: t, body: { id: ids.station, outlet_id: m.outletId, brand_id: m.brandId, name: "Floor" } });
  const code = await call<{ data: { code: string } }>("POST", `/v1/stations/${ids.station}/pairing-code`, { token: t, body: {} });
  const station = (await call<{ data: { station_token: string } }>("POST", "/v1/stations/pair", { body: { code: code.body.data.code, device_label: "iPad" }, idempotencyKey: null })).body.data.station_token;
  const signIn = async (pin: string) => (await call<{ data: { session_token: string } }>("POST", "/v1/stations/sessions", { token: station, body: { pin } })).body.data.session_token;
  const cashier = await signIn("333333");
  const manager = await signIn("222222");
  const orderId = randomUUID();
  const lineId = randomUUID();
  await call("POST", "/v1/orders", { token: cashier, body: { order_id: orderId, order_type: "dine_in", table_id: ids.table, pax: 2 } });
  await call("POST", `/v1/orders/${orderId}/lines`, { token: cashier, body: { lines: [{ line_id: lineId, product_id: ids.item, quantity: 2 }] } });
  await call("POST", `/v1/orders/${orderId}/fire`, { token: cashier, body: {} });
  const snap = (await call<{ data: { checks: { id: string; totals: { total: number } }[] } }>("GET", `/v1/orders/${orderId}`, { token: cashier })).body.data;
  const check = snap.checks[0]!;
  const paid = await call("POST", `/v1/checks/${check.id}/payments`, { token: cashier, body: { payment_id: randomUUID(), tender_type_id: ids.cash, amount: check.totals.total, tendered: check.totals.total } });
  expect(paid.status, JSON.stringify(paid.body)).toBe(200);
  const refund = await call("POST", `/v1/checks/${check.id}/refunds`, { token: manager, body: { refund_id: randomUUID(), request: { kind: "lines", lines: [{ line_id: lineId, quantity: 1 }] }, reason: "Returned", print: false } });
  expect(refund.status, JSON.stringify(refund.body)).toBe(201);
  return { m, manager: m.manager.token, orderTotal: check.totals.total };
}

beforeAll(async () => {
  db = await freshDb();
  app = buildApp();
  call = api(app).call;
  // Exclusive: GST 9% on top of 2 × 10.00, service charge 10% (also taxed).
  const sg = await seedMerchant(db.sql, "Exclusive");
  await withTransaction(() => seedRulesForMerchant(sg.merchantId, presetSeedRules(REGION_PRESETS.sg, sg.taxClassIds)));
  shops.exclusive = await trade(sg, 1000);
  // Inclusive: VAT 20% inside 2 × 12.00, and a taxed 10% service charge.
  const eu = await seedMerchant(db.sql, "Inclusive", { preset: "eu-vat", timeZone: "Europe/Berlin" });
  const euPreset = { ...REGION_PRESETS["eu-vat"], service_charge: { name: "Service 10%", bps: 1000, order_types: ["dine_in" as const], tax_class: "standard" } };
  await withTransaction(() => seedRulesForMerchant(eu.merchantId, presetSeedRules(euPreset, eu.taxClassIds)));
  shops.inclusive = await trade(eu, 1200);
});
afterAll(async () => {
  await db.drop();
});

type Sales = { gross: number; discounts: number; fees: number; tax: number; refunds: number; net: number; total: number };
const expected: Record<"exclusive" | "inclusive", Sales & { refunded: number }> = {
  // 2000 items + 200 fee + 198 GST (180 on items, 18 on the fee) = 2398 collected; the refund of one unit returns 1199, of which 1000 is item net.
  exclusive: { gross: 2000, discounts: 0, fees: 200, tax: 198, refunds: 1000, net: 1000, total: 2398, refunded: 1199 },
  // 2400 items + 240 fee, VAT 440 inside (400 on items, 40 on the fee) = 2640 collected; item net 2000, fee net 200; the refund returns 1320, of which 1000 is item net.
  inclusive: { gross: 2400, discounts: 0, fees: 200, tax: 440, refunds: 1000, net: 1000, total: 2640, refunded: 1320 },
};

describe.each(["exclusive", "inclusive"] as const)("net sales, %s tax", (mode) => {
  it("the Z-report's net sales exclude tax and fees and subtract the refunds' net; the collected total still matches the tenders", async () => {
    const s = shops[mode];
    expect(s.orderTotal).toBe(expected[mode].total);
    const z = await call<{ data: { sales: Sales; refunds: { count: number; amount: number }; tenders_summary: { cash: number; non_cash: number } } }>("GET", `/v1/outlets/${s.m.outletId}/z-report`, { token: s.manager });
    expect(z.status, JSON.stringify(z.body)).toBe(200);
    const { refunded, ...sales } = expected[mode];
    expect(z.body.data.sales).toMatchObject(sales);
    expect(z.body.data.refunds).toEqual({ count: 1, amount: refunded });
    expect(z.body.data.tenders_summary.cash + z.body.data.tenders_summary.non_cash).toBe(z.body.data.sales.total);
    // Before refunds the parts add up to what was collected.
    expect(z.body.data.sales.net + z.body.data.sales.refunds + z.body.data.sales.fees + z.body.data.sales.tax).toBe(z.body.data.sales.total);
  });

  it("the sales summary, its breakdowns and the product mix use the same net", async () => {
    const s = shops[mode];
    type Summary = { totals: Sales & { orders: number }; by_day: { net: number }[]; by_order_type: { order_type: string; net: number }[]; by_source: { net: number }[]; by_category: { net: number }[]; refunds: { amount: number } };
    const r = await call<{ data: Summary }>("GET", `/v1/reports/sales-summary?outlet_id=${s.m.outletId}`, { token: s.manager });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const { refunded, ...sales } = expected[mode];
    expect(r.body.data.totals).toMatchObject(sales);
    expect(r.body.data.refunds.amount).toBe(refunded);
    for (const rows of [r.body.data.by_day, r.body.data.by_order_type, r.body.data.by_source, r.body.data.by_category]) expect(rows.map((x) => x.net)).toEqual([expected[mode].net]);
    const mix = await call<{ data: { net: number; share_bps: number }[] }>("GET", `/v1/reports/product-mix?outlet_id=${s.m.outletId}&group_by=item`, { token: s.manager });
    expect(mix.body.data.map((x) => [x.net, x.share_bps])).toEqual([[expected[mode].net, 10_000]]);
    const daily = await call<{ data: { z_report: { sales: { net: number } }; summary: { totals: { net: number } } } }>("GET", `/v1/outlets/${s.m.outletId}/reports/daily`, { token: s.manager });
    expect(daily.body.data.z_report.sales.net).toBe(daily.body.data.summary.totals.net);
    const csv = await call<string>("GET", `/v1/reports/sales-summary?outlet_id=${s.m.outletId}&format=csv`, { token: s.manager });
    expect(csv.body).toMatch(new RegExp(`,net,${expected[mode].net},`));
    expect(csv.body).toMatch(new RegExp(`,total,${expected[mode].total}`));
  });
});
