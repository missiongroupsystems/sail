import { randomUUID } from "node:crypto";
import "../src/modules.js";
import { buildApp } from "../src/app.js";
import { withTransaction } from "../src/db/client.js";
import { seedRulesForMerchant } from "../src/services/pricing-rules.js";
import { api, freshDb, seedMerchant, sgSeedRules, type SeededMerchant, type TestDb } from "./helpers.js";

export type Call = ReturnType<typeof api>["call"];

/** A seeded merchant with a small menu, tenders, printers and two paired stations at outlet 1, with every role signed in. */
export type World = {
  m: SeededMerchant;
  ids: Record<"laksa" | "kopi" | "wine" | "menu" | "posLink" | "station" | "station2" | "cash" | "card" | "kitchen" | "receipt" | "voidReason" | "openItem", string>;
  stationToken: string;
  station2Token: string;
  /** PIN session tokens on station 1, plus a cashier on station 2. */
  pins: { server: string; cashier: string; manager: string; admin: string; cashierStation2: string };
};

export type Snap = { id: string; version: number; status: string; totals: { total: number }; lines: { id: string; status: string; quantity: number }[]; checks: { id: string; totals: { total: number }; balance: number }[]; balance: number };

export async function bootWorld(template?: string): Promise<{ db: TestDb; call: Call; w: World }> {
  const db = await freshDb({}, template);
  const call = api(buildApp()).call;
  const m = await seedMerchant(db.sql, "Alpha");
  await withTransaction(() => seedRulesForMerchant(m.merchantId, sgSeedRules(m)));
  const t = m.admin.token;
  const ids = Object.fromEntries(["laksa", "kopi", "wine", "menu", "posLink", "station", "station2", "cash", "card", "kitchen", "receipt", "voidReason", "openItem"].map((k) => [k, randomUUID()])) as World["ids"];
  const must = async (method: string, path: string, body: unknown) => {
    const r = await call(method, path, { token: t, body });
    if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r;
  };
  await must("POST", "/v1/products", { id: ids.laksa, name: "Laksa", price: 1600, tags: ["kitchen"] });
  await must("POST", "/v1/products", { id: ids.kopi, name: "Kopi", price: 180, tags: ["kitchen"] });
  await must("POST", "/v1/products", { id: ids.wine, name: "Shiraz bottle", price: 12000, tags: ["kitchen"] });
  await must("POST", "/v1/products", { id: ids.openItem, name: "Open item", price: 0, open_price: true });
  await must("POST", "/v1/menus", { id: ids.menu, brand_id: m.brandId, name: "M", sections: [{ name: "All", items: [{ product_id: ids.laksa }, { product_id: ids.kopi }, { product_id: ids.wine }, { product_id: ids.openItem }] }] });
  await must("POST", "/v1/channel-links", { id: ids.posLink, channel: "pos", outlet_id: m.outletId, brand_id: m.brandId, menu_id: ids.menu });
  await must("POST", "/v1/printers", { id: ids.kitchen, outlet_id: m.outletId, name: "Kitchen", ip: "10.0.0.1", is_default_kitchen: true });
  await must("POST", "/v1/printers", { id: ids.receipt, outlet_id: m.outletId, name: "Receipt", ip: "10.0.0.9", role: "receipt" });
  await must("POST", "/v1/tender-types", { id: ids.cash, name: "Cash", is_cash: true });
  await must("POST", "/v1/tender-types", { id: ids.card, name: "Card", is_terminal: true });
  await must("POST", "/v1/void-reasons", { id: ids.voidReason, name: "Changed mind" });
  await must("POST", "/v1/stations", { id: ids.station, outlet_id: m.outletId, brand_id: m.brandId, name: "Floor", receipt_printer_id: ids.receipt });
  await must("POST", "/v1/stations", { id: ids.station2, outlet_id: m.outletId, brand_id: m.brandId, name: "Bar", receipt_printer_id: ids.receipt });
  const pair = async (stationId: string) => {
    const code = await must("POST", `/v1/stations/${stationId}/pairing-code`, {});
    const r = await call<{ data: { station_token: string } }>("POST", "/v1/stations/pair", { body: { code: (code.body as { data: { code: string } }).data.code, device_label: "iPad" }, idempotencyKey: null });
    return r.body.data.station_token;
  };
  const stationToken = await pair(ids.station);
  const station2Token = await pair(ids.station2);
  const signIn = async (station: string, pin: string) => {
    const r = await call<{ data: { session_token: string } }>("POST", "/v1/stations/sessions", { token: station, body: { pin } });
    if (r.status !== 201) throw new Error(`sign in ${pin}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.data.session_token;
  };
  const pins = { server: await signIn(stationToken, "444444"), cashier: await signIn(stationToken, "333333"), manager: await signIn(stationToken, "222222"), admin: await signIn(stationToken, "111111"), cashierStation2: await signIn(station2Token, "333333") };
  return { db, call, w: { m, ids, stationToken, station2Token, pins } };
}

/** Order helpers over a world. */
export function orderHelpers(call: Call, w: World) {
  const open = (token: string) => call<{ data: Snap }>("POST", "/v1/orders", { token, body: { order_id: randomUUID(), order_type: "takeaway", takeaway_ref: "T", outlet_id: w.m.outletId, brand_id: w.m.brandId } });
  const add = (token: string, orderId: string, lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) => call<{ data: Snap; code?: string }>("POST", `/v1/orders/${orderId}/lines`, { token, body: { lines: lines.map((l) => ({ line_id: randomUUID(), quantity: 1, ...l })), ...extra } });
  const fire = (token: string, orderId: string) => call<{ data: Snap }>("POST", `/v1/orders/${orderId}/fire`, { token, body: {} });
  const pay = (token: string, checkId: string, body: Record<string, unknown>) => call<{ data: Snap; code?: string }>("POST", `/v1/checks/${checkId}/payments`, { token, body: { payment_id: randomUUID(), ...body } });
  /** Open a takeaway with lines and return its snapshot. */
  const orderWith = async (token: string, lines: Record<string, unknown>[]) => {
    const o = await open(token);
    if (o.status !== 201) throw new Error(`open ${o.status} ${JSON.stringify(o.body)}`);
    const a = await add(token, o.body.data.id, lines);
    if (a.status !== 200) throw new Error(`add ${a.status} ${JSON.stringify(a.body)}`);
    return a.body.data;
  };
  /** An order with the given lines, sent to the kitchen and paid in full by card. */
  const paidOrder = async (token: string, lines: Record<string, unknown>[]) => {
    const s = await orderWith(token, lines);
    await fire(token, s.id);
    const paid = await pay(token, s.checks[0]!.id, { tender_type_id: w.ids.card, amount: s.balance });
    if (paid.status !== 200) throw new Error(`pay ${paid.status} ${JSON.stringify(paid.body)}`);
    return paid.body.data;
  };
  return { open, add, fire, pay, orderWith, paidOrder };
}
