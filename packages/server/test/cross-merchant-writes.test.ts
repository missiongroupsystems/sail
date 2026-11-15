import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedMerchant, type SeededMerchant, type TestDb } from "./helpers.js";
import { bootWorld, type Call, type World } from "./world.js";

/**
 * Writes that name another record. Merchant B's Admin sends each one twice: once with merchant A's real id, once with
 * an id nobody has. Both must be refused, with the same status and the same body, so a write can neither point B's
 * records at A's nor tell B that one of A's ids exists. cross-tenant.test.ts covers ids in the path; this covers ids in
 * the body.
 */
let db: TestDb;
let call: Call;
let w: World;
let B: SeededMerchant;
const b: Record<string, string> = {};
const a: Record<string, string> = {};

beforeAll(async () => {
  ({ db, call, w } = await bootWorld());
  B = await seedMerchant(db.sql, "Beta");
  const must = async (method: string, path: string, body: unknown, token = B.admin.token) => {
    const r = await call<{ data: Record<string, unknown> }>(method, path, { token, body });
    if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.data.id as string;
  };
  // Merchant A: one of each record a body can point at.
  const at = w.m.admin.token;
  a.area = await must("POST", "/v1/areas", { outlet_id: w.m.outletId, name: "A area" }, at);
  a.table = await must("POST", "/v1/tables", { outlet_id: w.m.outletId, area_id: a.area, name: "A1" }, at);
  a.category = await must("POST", "/v1/categories", { name: "A food" }, at);
  a.group = await must("POST", "/v1/modifier-groups", { name: "A size", options: [{ product_id: w.ids.kopi }] }, at);
  a.layout = await must("POST", "/v1/layouts", { brand_id: w.m.brandId, name: "A layout" }, at);
  a.destination = await must("POST", "/v1/display-destinations", { outlet_id: w.m.outletId, name: "A screen" }, at);
  a.customerGroup = await must("POST", "/v1/customer-groups", { name: "A regulars" }, at);
  a.customer = await must("PUT", "/v1/customers", { name: "A guest", mobile: "0001" }, at);
  a.section = (await db.sql<{ id: string }[]>`select id from menu_sections where menu_id = ${w.ids.menu}`)[0]!.id;
  // Merchant B: its own records to edit.
  b.area = await must("POST", "/v1/areas", { outlet_id: B.outletId, name: "B area" });
  b.table = await must("POST", "/v1/tables", { outlet_id: B.outletId, area_id: b.area, name: "B1" });
  b.product = await must("POST", "/v1/products", { name: "B coffee", price: 300 });
  b.menu = await must("POST", "/v1/menus", { brand_id: B.brandId, name: "B menu" });
  b.station = await must("POST", "/v1/stations", { outlet_id: B.outletId, brand_id: B.brandId, name: "B till" });
  b.printer = await must("POST", "/v1/printers", { outlet_id: B.outletId, name: "B kitchen", ip: "10.0.0.2" });
  b.link = await must("POST", "/v1/channel-links", { channel: "pos", outlet_id: B.outletId, brand_id: B.brandId, menu_id: b.menu });
  b.staff = await must("POST", "/v1/staff", { name: "B person", role: "server" });
});
afterAll(async () => db.drop());

type Case = [name: string, method: string, path: () => string, body: (x: string) => unknown];
const cases: Case[] = [
  ["table in another merchant's area", "POST", () => "/v1/tables", (x) => ({ outlet_id: B.outletId, area_id: x, name: "T" })],
  ["table moved to another merchant's area", "PATCH", () => `/v1/tables/${b.table}`, (x) => ({ area_id: x })],
  ["area at another merchant's outlet", "POST", () => "/v1/areas", (x) => ({ outlet_id: x, name: "A" })],
  ["menu item of another merchant's product", "PATCH", () => `/v1/menus/${b.menu}`, (x) => ({ sections: [{ name: "S", items: [{ product_id: x }] }] })],
  ["new menu with another merchant's product", "POST", () => "/v1/menus", (x) => ({ brand_id: B.brandId, name: "M", sections: [{ name: "S", items: [{ product_id: x }] }] })],
  ["menu section under another merchant's section", "PATCH", () => `/v1/menus/${b.menu}`, (x) => ({ sections: [{ name: "S", parent_id: x }] })],
  ["menu of another merchant's brand", "POST", () => "/v1/menus", (x) => ({ brand_id: x, name: "M" })],
  ["product in another merchant's category", "POST", () => "/v1/products", (x) => ({ name: "P", price: 100, category_id: x })],
  ["product of another merchant's brand", "PATCH", () => `/v1/products/${b.product}`, (x) => ({ brand_id: x })],
  ["product with another merchant's modifier group", "PATCH", () => `/v1/products/${b.product}`, (x) => ({ modifier_group_ids: [x] })],
  ["product with another merchant's tax class", "PATCH", () => `/v1/products/${b.product}`, (x) => ({ tax_class_id: x })],
  ["bulk price of another merchant's product", "POST", () => "/v1/products/bulk-price", (x) => ({ changes: [{ product_id: x, price: 1 }] })],
  ["modifier option of another merchant's product", "POST", () => "/v1/modifier-groups", (x) => ({ name: "G", options: [{ product_id: x }] })],
  ["modifier option opening another merchant's group", "POST", () => "/v1/modifier-groups", (x) => ({ name: "G", options: [{ product_id: b.product, child_group_id: x }] })],
  ["category under another merchant's category", "POST", () => "/v1/categories", (x) => ({ name: "C", parent_id: x })],
  ["availability of another merchant's product", "POST", () => "/v1/availability-rules", (x) => ({ target_kind: "product", target_id: x, days_of_week: [1] })],
  ["availability of another merchant's section", "POST", () => "/v1/availability-rules", (x) => ({ target_kind: "section", target_id: x, days_of_week: [1] })],
  ["availability at another merchant's outlet", "POST", () => "/v1/availability-rules", (x) => ({ target_kind: "product", target_id: b.product, outlet_ids: [x] })],
  ["station at another merchant's outlet", "POST", () => "/v1/stations", (x) => ({ outlet_id: x, name: "S" })],
  ["station of another merchant's brand", "PATCH", () => `/v1/stations/${b.station}`, (x) => ({ brand_id: x })],
  ["station with another merchant's layout", "PATCH", () => `/v1/stations/${b.station}`, (x) => ({ layout_id: x })],
  ["station printing on another merchant's printer", "PATCH", () => `/v1/stations/${b.station}`, (x) => ({ receipt_printer_id: x })],
  ["staff scoped to another merchant's outlet", "PATCH", () => `/v1/staff/${b.staff}`, (x) => ({ outlet_ids: [x] })],
  ["staff scoped to another merchant's brand", "POST", () => "/v1/staff", (x) => ({ name: "N", role: "server", brand_ids: [x] })],
  ["agent scoped to another merchant's outlet", "POST", () => "/v1/agent-identities", (x) => ({ name: "Ag", role: "server", toolsets: ["pos.read"], outlet_ids: [x] })],
  ["channel link to another merchant's menu", "PATCH", () => `/v1/channel-links/${b.link}`, (x) => ({ menu_id: x })],
  ["channel link printing on another merchant's printer", "PATCH", () => `/v1/channel-links/${b.link}`, (x) => ({ service_request_printer_id: x })],
  ["printer backed up by another merchant's printer", "PATCH", () => `/v1/printers/${b.printer}`, (x) => ({ backup_printer_id: x })],
  ["printer at another merchant's station", "PATCH", () => `/v1/printers/${b.printer}`, (x) => ({ station_id: x })],
  ["display destination at another merchant's outlet", "POST", () => "/v1/display-destinations", (x) => ({ outlet_id: x, name: "D" })],
  ["layout tile of another merchant's product", "POST", () => "/v1/layouts", (x) => ({ brand_id: B.brandId, name: "L", pages: [{ id: "p", name: "P", tiles: [{ id: "t", label: "T", color: "slate", access_level: "everyone", kind: "product", product_id: x }] }] })],
  ["customer in another merchant's group", "PUT", () => "/v1/customers", (x) => ({ name: "C", mobile: "0002", group_ids: [x] })],
  ["tax rate at another merchant's outlet", "PUT", () => `/v1/tax-classes/${B.taxClassIds.standard}/rates`, (x) => ({ outlet_id: x, order_type: null, components: [{ name: "GST", bps: 900 }] })],
  ["sold out at another merchant's product", "POST", () => "/v1/stock/sold-out", (x) => ({ outlet_id: B.outletId, product_id: x, until: "today" })],
  ["pricing rule scoped to another merchant's product", "POST", () => "/v1/pricing-rules", (x) => ({ rule_key: "b-promo", body: { name: "Promo", kind: "discount", calc: "percent", value: { type: "fixed", amount: 1000 }, scope: { type: "products", product_ids: [x] }, priority: 1, application: "auto", report_class: "promo" } })],
  ["pricing rule for another merchant's customer group", "POST", () => "/v1/pricing-rules", (x) => ({ rule_key: "b-members", body: { name: "Members", kind: "discount", calc: "percent", value: { type: "fixed", amount: 1000 }, scope: { type: "all" }, priority: 1, application: "auto", report_class: "promo", conditions: { customer_group_ids: [x] } } })],
  ["order at another merchant's outlet", "POST", () => "/v1/orders", (x) => ({ order_id: randomUUID(), order_type: "takeaway", takeaway_ref: "T", outlet_id: x, brand_id: B.brandId })],
];

/** The id merchant A really has for each case, by what the body points at. */
const aId = (name: string): string => {
  if (/area/.test(name) && !/outlet/.test(name)) return a.area!;
  if (/section/.test(name)) return a.section!;
  if (/outlet/.test(name)) return w.m.outletId;
  if (/brand/.test(name)) return w.m.brandId;
  if (/tax class/.test(name)) return w.m.taxClassIds.standard!;
  if (/category/.test(name)) return a.category!;
  if (/modifier group|opening another merchant's group/.test(name)) return a.group!;
  if (/customer group|merchant's group/.test(name)) return a.customerGroup!;
  if (/layout/.test(name) && !/tile/.test(name)) return a.layout!;
  if (/menu/.test(name) && !/item|product|section/.test(name)) return w.ids.menu;
  if (/printer/.test(name)) return w.ids.kitchen;
  if (/station/.test(name)) return w.ids.station;
  return w.ids.kopi;
};

describe("a write cannot point at another merchant's record, and cannot tell whether it exists", () => {
  it.each(cases)("%s: refused exactly as an unknown id is", async (name, method, path, body) => {
    const foreign = aId(name);
    const unknown = randomUUID();
    const send = (x: string) => call<Record<string, unknown>>(method, path(), { token: B.admin.token, body: body(x) });
    const eventsBefore = (await db.sql<{ n: number }[]>`select count(*)::int as n from events where merchant_id = ${B.merchantId}`)[0]!.n;
    const r1 = await send(foreign);
    const r2 = await send(unknown);
    expect(r1.status, JSON.stringify(r1.body)).toBeGreaterThanOrEqual(400);
    expect(r1.status).toBeLessThan(500);
    const same = (r: { body: unknown }, x: string) => JSON.parse(JSON.stringify(r.body).replaceAll(x, "<id>"));
    expect(same(r1, foreign)).toEqual(same(r2, unknown));
    expect(r1.status).toBe(r2.status);
    // A refused write leaves nothing behind, not even an event.
    expect((await db.sql<{ n: number }[]>`select count(*)::int as n from events where merchant_id = ${B.merchantId}`)[0]!.n).toBe(eventsBefore);
  });

  it("a new record whose id is already taken answers 409 without naming the constraint, whoever holds the id", async () => {
    const own = (await call<{ data: { sections: { id: string }[] } }>("POST", "/v1/menus", { token: B.admin.token, body: { brand_id: B.brandId, name: "Other", sections: [{ name: "Mine" }] } })).body.data.sections[0]!.id;
    const send = (id: string) => call<Record<string, unknown>>("PATCH", `/v1/menus/${b.menu}`, { token: B.admin.token, body: { sections: [{ id, name: "S" }] } });
    const foreign = await send(a.section!);
    const taken = await send(own);
    expect(foreign.status).toBe(409);
    expect(foreign.body).toEqual(taken.body);
    expect(JSON.stringify(foreign.body)).not.toMatch(/pkey|rls|constraint/);
    const area = await call("POST", "/v1/areas", { token: B.admin.token, body: { id: a.area, outlet_id: B.outletId, name: "A" } });
    expect(area.status).toBe(409);
    expect(JSON.stringify(area.body)).not.toMatch(/pkey|rls|constraint/);
  });

  it("an order sent from a station names that station's outlet or none", async () => {
    const send = (outlet: string) => call<{ code: string }>("POST", "/v1/orders", { token: w.pins.cashier, body: { order_id: randomUUID(), order_type: "takeaway", takeaway_ref: "T", outlet_id: outlet } });
    const foreign = await send(B.outletId);
    const unknown = await send(randomUUID());
    expect(foreign.status).toBe(400);
    expect(unknown.status).toBe(400);
    const norm = (r: { body: unknown }) => JSON.stringify(r.body).replace(/[0-9a-f-]{36}/g, "<id>");
    expect(norm(foreign)).toEqual(norm(unknown));
    expect((await send(w.m.outletId)).status).toBe(201);
  });

  it("every foreign key between two tenant tables also matches the merchant, so a new one cannot skip the check", async () => {
    const missing = await db.sql<{ fk: string }[]>`
      select c.conrelid::regclass || '.' || a.attname as fk
      from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      where c.contype = 'f' and cardinality(c.conkey) = 1 and c.connamespace = 'public'::regnamespace and a.attname <> 'merchant_id'
        and exists (select 1 from pg_attribute x where x.attrelid = c.conrelid and x.attname = 'merchant_id')
        and exists (select 1 from pg_attribute x where x.attrelid = c.confrelid and x.attname = 'merchant_id')
        and not exists (select 1 from pg_constraint t where t.contype = 'f' and t.conrelid = c.conrelid and t.confrelid = c.confrelid and t.convalidated
          and t.conkey @> array[c.conkey[1], (select attnum from pg_attribute where attrelid = c.conrelid and attname = 'merchant_id')] and cardinality(t.conkey) = 2)
      order by 1`;
    expect(missing.map((r) => r.fk)).toEqual([]);
  });
});
