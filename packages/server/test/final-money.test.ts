import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TaxBreakdown } from "@sail/shared";
import "../src/modules.js";
import { buildApp, type App } from "../src/app.js";
import { api, freshDb, seedMerchant, type SeededMerchant, type TestDb } from "./helpers.js";

/** Final review round, money: a US diner (4% state + 4.5% local, rounded per rate). */
let db: TestDb;
let app: App;
let US: SeededMerchant;
let call: ReturnType<typeof api>["call"];
let pin: string;
const ids = { burger: randomUUID(), soda: randomUUID(), menu: randomUUID(), link: randomUUID(), area: randomUUID(), t1: randomUUID(), station: randomUUID(), cash: randomUUID(), card: randomUUID() };

type Snap = { id: string; version: number; status: string; totals: { subtotal: number; tax_total: number; taxes: TaxBreakdown[]; total: number }; lines: { id: string; status: string; amounts: { total: number; tax: number } }[]; checks: { id: string }[]; balance: number; paid_total: number };
type Mut = { data: Snap; code?: string };

beforeAll(async () => {
  db = await freshDb();
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
  await must("/v1/menus", { id: ids.menu, brand_id: US.brandId, name: "M", sections: [{ name: "All", items: [{ product_id: ids.burger }, { product_id: ids.soda }] }] });
  await must("/v1/channel-links", { id: ids.link, channel: "pos", outlet_id: US.outletId, brand_id: US.brandId, menu_id: ids.menu });
  await must("/v1/areas", { id: ids.area, outlet_id: US.outletId, name: "Main" });
  await must("/v1/tables", { id: ids.t1, outlet_id: US.outletId, area_id: ids.area, name: "1" });
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
