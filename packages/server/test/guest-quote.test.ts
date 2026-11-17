import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/modules.js";
import { buildApp, type App } from "../src/app.js";
import { withTransaction } from "../src/db/client.js";
import { seedRulesForMerchant } from "../src/services/pricing-rules.js";
import { resetGuestRateLimitsForTests } from "../src/services/guest.js";
import { api, freshDb, seedMerchant, sgSeedRules, type SeededMerchant, type TestDb } from "./helpers.js";

/** The guest's phone prices a round before sending it, and says from the first scan whether tax is in the prices (final review C-6, C-7). */
let db: TestDb;
let app: App;
let A: SeededMerchant;
let E: SeededMerchant;
let call: ReturnType<typeof api>["call"];
const ids = { laksa: randomUUID(), kopi: randomUUID(), prawn: randomUUID(), protein: randomUUID(), menu: randomUUID(), qrLink: randomUUID(), area: randomUUID(), table: randomUUID(), kitchen: randomUUID() };
const eu = { coffee: randomUUID(), menu: randomUUID(), qrLink: randomUUID(), area: randomUUID(), table: randomUUID() };
const qr: Record<string, string> = {};
const tokenFrom = (url: string) => url.split("/t/")[1]!;

type Quote = { data: { lines: { line_id: string; quantity: number; amount: number }[]; total: number } };
type View = { data: { tax: { mode: string; names: string[] }; lines: { id: string; amount: number }[] } };

beforeAll(async () => {
  db = await freshDb({ GUEST_APP_URL: "https://order.example.test" });
  app = buildApp();
  call = api(app).call;
  A = await seedMerchant(db.sql, "Alpha");
  E = await seedMerchant(db.sql, "Euro", { preset: "eu-vat", timeZone: "Europe/Berlin" });
  await withTransaction(() => seedRulesForMerchant(A.merchantId, sgSeedRules(A)));
  const must = async (token: string, path: string, body: unknown) => {
    const r = await call<{ data: { url?: string } }>("POST", path, { token, body });
    expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBeLessThan(300);
    return r.body.data;
  };
  const t = A.admin.token;
  await must(t, "/v1/products", { id: ids.prawn, name: "Prawn", price: 200, kind: "component" });
  await must(t, "/v1/modifier-groups", { id: ids.protein, name: "Protein", min_select: 1, max_select: 1, options: [{ product_id: ids.prawn }] });
  await must(t, "/v1/products", { id: ids.laksa, name: "Laksa", price: 1600, tags: ["kitchen"], modifier_group_ids: [ids.protein] });
  await must(t, "/v1/products", { id: ids.kopi, name: "Kopi", price: 180, tags: ["kitchen"] });
  await must(t, "/v1/menus", { id: ids.menu, brand_id: A.brandId, name: "M", sections: [{ name: "All", items: [{ product_id: ids.laksa }, { product_id: ids.kopi }] }] });
  await must(t, "/v1/printers", { id: ids.kitchen, outlet_id: A.outletId, name: "Kitchen", ip: "10.0.0.1", is_default_kitchen: true });
  await must(t, "/v1/channel-links", { id: ids.qrLink, channel: "scan_to_order", outlet_id: A.outletId, brand_id: A.brandId, menu_id: ids.menu, hold_orders: true, open_on_first_scan: true });
  await must(t, "/v1/areas", { id: ids.area, outlet_id: A.outletId, name: "Main" });
  await must(t, "/v1/tables", { id: ids.table, outlet_id: A.outletId, area_id: ids.area, name: "1" });
  qr.sg = (await must(t, `/v1/tables/${ids.table}/qr/rotate`, {})).url!;
  const e = E.admin.token;
  await must(e, "/v1/products", { id: eu.coffee, name: "Kaffee", price: 350 });
  await must(e, "/v1/menus", { id: eu.menu, brand_id: E.brandId, name: "M", sections: [{ name: "All", items: [{ product_id: eu.coffee }] }] });
  await must(e, "/v1/channel-links", { id: eu.qrLink, channel: "scan_to_order", outlet_id: E.outletId, brand_id: E.brandId, menu_id: eu.menu, hold_orders: true, open_on_first_scan: true });
  await must(e, "/v1/areas", { id: eu.area, outlet_id: E.outletId, name: "Main" });
  await must(e, "/v1/tables", { id: eu.table, outlet_id: E.outletId, area_id: eu.area, name: "1" });
  qr.eu = (await must(e, `/v1/tables/${eu.table}/qr/rotate`, {})).url!;
});
afterAll(async () => db.drop());

const phone = async (table: string, device: string) => {
  await resetGuestRateLimitsForTests();
  const s = await call<{ data: { guest_token: string } }>("POST", "/v1/guest/sessions", { body: { token: tokenFrom(qr[table]!), device_id: device }, idempotencyKey: null });
  expect(s.status, JSON.stringify(s.body)).toBe(201);
  return s.body.data.guest_token;
};

describe("rounds.quote", () => {
  it("prices each line and the round as the register stores them, writes nothing, and matches what the table then shows", async () => {
    const g = await phone("sg", "device-quote-0001");
    const laksa = { line_id: randomUUID(), product_id: ids.laksa, quantity: 2, modifiers: [{ group_id: ids.protein, product_id: ids.prawn }] };
    const kopi = { line_id: randomUUID(), product_id: ids.kopi, quantity: 3 };
    const before = (await db.sql<{ n: number }[]>`select count(*)::int as n from order_lines`)[0]!.n;
    const q = await call<Quote>("POST", "/v1/guest/rounds/quote", { token: g, body: { lines: [laksa, kopi] } });
    expect(q.status, JSON.stringify(q.body)).toBe(200);
    // (16.00 + 2.00) × 2 and 1.80 × 3, before any rule.
    expect(q.body.data.lines).toEqual([
      { line_id: laksa.line_id, quantity: 2, amount: 3600 },
      { line_id: kopi.line_id, quantity: 3, amount: 540 },
    ]);
    expect(q.body.data.total).toBe(4140);
    // Pure: no order, no line, no table opened.
    expect((await db.sql<{ n: number }[]>`select count(*)::int as n from order_lines`)[0]!.n).toBe(before);
    expect((await db.sql<{ n: number }[]>`select count(*)::int as n from orders where table_id = ${ids.table}`)[0]!.n).toBe(0);

    const sent = await call("POST", "/v1/guest/rounds", { token: g, body: { round_id: randomUUID(), lines: [laksa, kopi] } });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const view = await call<View>("GET", "/v1/guest/order", { token: g });
    expect(view.body.data.lines.map((l) => [l.id, l.amount])).toEqual([
      [laksa.line_id, 3600],
      [kopi.line_id, 540],
    ]);
  });

  it("refuses a line the menu does not have, as a send would", async () => {
    const g = await phone("sg", "device-quote-0002");
    const q = await call<{ code: string }>("POST", "/v1/guest/rounds/quote", { token: g, body: { lines: [{ line_id: randomUUID(), product_id: randomUUID(), quantity: 1 }] } });
    expect(q.status).toBe(404);
  });

  it("is for guests only", async () => {
    const q = await call("POST", "/v1/guest/rounds/quote", { token: A.admin.token, body: { lines: [{ line_id: randomUUID(), product_id: ids.kopi, quantity: 1 }] } });
    expect(q.status).toBeGreaterThanOrEqual(400);
  });
});

describe("rounds.quote reserves nothing and is rate-limited", () => {
  it("leaves the day's cap as it was", async () => {
    await call("POST", "/v1/stock/daily-cap", { token: A.admin.token, body: { outlet_id: A.outletId, product_id: ids.kopi, quantity: 5 } });
    const g = await phone("sg", "device-quote-cap1");
    const capLeft = async () => (await call<{ data: { products: Record<string, { cap_remaining: number | null }> } }>("GET", `/v1/channel-links/${ids.qrLink}/menu`, { token: g })).body.data.products[ids.kopi]!.cap_remaining;
    const before = await capLeft();
    const q = await call<Quote>("POST", "/v1/guest/rounds/quote", { token: g, body: { lines: [{ line_id: randomUUID(), product_id: ids.kopi, quantity: 3 }] } });
    expect(q.status, JSON.stringify(q.body)).toBe(200);
    expect(await capLeft()).toBe(before);
    // Asking for more than is left is refused, as a send would be, and still reserves nothing.
    expect((await call("POST", "/v1/guest/rounds/quote", { token: g, body: { lines: [{ line_id: randomUUID(), product_id: ids.kopi, quantity: 6 }] } })).status).toBe(422);
    expect(await capLeft()).toBe(before);
    await call("POST", "/v1/stock/daily-cap", { token: A.admin.token, body: { outlet_id: A.outletId, product_id: ids.kopi, quantity: null } });
  });

  it("answers 429 past 120 quotes a minute from one phone", async () => {
    const g = await phone("sg", "device-quote-rate1");
    const line = () => ({ lines: [{ line_id: randomUUID(), product_id: ids.kopi, quantity: 1 }] });
    for (let i = 0; i < 120; i++) expect((await call("POST", "/v1/guest/rounds/quote", { token: g, body: line() })).status).toBe(200);
    expect((await call("POST", "/v1/guest/rounds/quote", { token: g, body: line() })).status).toBe(429);
  });
});

describe("the price note from the first scan", () => {
  it("names the merchant's tax and whether prices include it, before the table has an order", async () => {
    const sg = await call<View>("GET", "/v1/guest/order", { token: await phone("eu", "device-note-0001") });
    expect(sg.status).toBe(200);
    expect(sg.body.data.tax).toEqual({ mode: "inclusive", names: ["VAT"] });
    const ex = await call<View>("GET", "/v1/guest/order", { token: await phone("sg", "device-note-0002") });
    expect(ex.body.data.tax).toEqual({ mode: "exclusive", names: ["GST"] });
  });
});
