import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/modules.js";
import { buildApp, type App } from "../src/app.js";
import { api, freshDb, seedMerchant, type SeededMerchant, type TestDb } from "./helpers.js";

let db: TestDb;
let app: App;
let A: SeededMerchant;
let B: SeededMerchant;
let call: ReturnType<typeof api>["call"];

beforeAll(async () => {
  db = await freshDb();
  app = buildApp();
  call = api(app).call;
  A = await seedMerchant(db.sql, "Alpha");
  B = await seedMerchant(db.sql, "Bravo");
});
afterAll(async () => {
  await db.drop();
});

type Created<T> = { status: number; body: { data: T; events: { type: string }[]; warnings: string[] } };

describe("catalogue", () => {
  const ids = { food: randomUUID(), noodles: randomUUID(), laksa: randomUUID(), prawn: randomUUID(), chicken: randomUUID(), protein: randomUUID(), menu: randomUUID(), section: randomUUID(), link: randomUUID() };

  it("admin builds a two-level category tree, products with order-type prices, modifier groups, a menu and a channel link", async () => {
    expect((await call("POST", "/v1/categories", { token: A.admin.token, body: { id: ids.food, name: "Food" } })).status).toBe(201);
    expect((await call("POST", "/v1/categories", { token: A.admin.token, body: { id: ids.noodles, name: "Noodles", parent_id: ids.food } })).status).toBe(201);

    for (const [id, name, price] of [
      [ids.prawn, "Prawn", 200],
      [ids.chicken, "Chicken", 0],
    ] as const) {
      expect((await call("POST", "/v1/products", { token: A.admin.token, body: { id, name, price, kind: "component" } })).status).toBe(201);
    }
    const group = (await call("POST", "/v1/modifier-groups", { token: A.admin.token, body: { id: ids.protein, name: "Protein", min_select: 1, max_select: 1, options: [{ product_id: ids.prawn }, { product_id: ids.chicken, is_default: true, price_override: 50 }] } })) as Created<{ options: { price_override: number | null }[] }>;
    expect(group.status).toBe(201);
    expect(group.body.data.options[1]!.price_override).toBe(50);

    const laksa = (await call("POST", "/v1/products", {
      token: A.admin.token,
      body: { id: ids.laksa, name: "Laksa", sku: "LAK-001", price: 1600, category_id: ids.noodles, tags: ["kitchen", "spicy"], prices_by_order_type: { delivery: 1800 }, modifier_group_ids: [ids.protein] },
    })) as Created<{ prices_by_order_type: Record<string, number>; modifier_group_ids: string[] }>;
    expect(laksa.status).toBe(201);
    expect(laksa.body.data.prices_by_order_type).toEqual({ delivery: 1800 });
    expect(laksa.body.data.modifier_group_ids).toEqual([ids.protein]);

    const menu = (await call("POST", "/v1/menus", { token: A.admin.token, body: { id: ids.menu, brand_id: A.brandId, name: "All day", sections: [{ id: ids.section, name: "Noodles", items: [{ product_id: ids.laksa }] }] } })) as Created<{ sections: { items: { product_id: string }[] }[] }>;
    expect(menu.status).toBe(201);
    expect(menu.body.data.sections[0]!.items).toEqual([{ product_id: ids.laksa, sort: 0 }]);

    const link = await call("POST", "/v1/channel-links", { token: A.admin.token, body: { id: ids.link, channel: "pos", outlet_id: A.outletId, brand_id: A.brandId, menu_id: ids.menu } });
    expect(link.status).toBe(201);
  });

  it("search is paginated and filters by tag; a server can read but not write", async () => {
    const r = await call<{ data: { name: string }[]; total: number }>("GET", "/v1/products?q=lak&tag=spicy", { token: A.server.token });
    expect(r.status).toBe(200);
    expect(r.body.data.map((p) => p.name)).toEqual(["Laksa"]);
    expect(r.body.total).toBe(1);
    expect((await call("POST", "/v1/products", { token: A.server.token, body: { name: "x", price: 1 } })).status).toBe(403);
    expect((await call("GET", "/v1/products", { token: B.admin.token })).body).toMatchObject({ data: [] });
  });

  it("duplicate SKUs are refused and the request rolls back", async () => {
    const r = await call<{ code: string }>("POST", "/v1/products", { token: A.admin.token, body: { name: "Dup", sku: "LAK-001", price: 1 } });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("state_conflict");
  });

  it("compiles the channel link's menu with resolved modifier prices, parent categories, availability and stock", async () => {
    const m = await call<{ data: { products: Record<string, { parent_category_id: string; modifier_groups: string[]; available_now: boolean; sold_out: boolean; prices_by_order_type: Record<string, number> }>; modifier_groups: Record<string, { options: { price: number; name: string }[] }>; menu: { sections: { items: { product_id: string }[] }[] } } }>("GET", `/v1/channel-links/${ids.link}/menu`, { token: A.server.token });
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    const laksa = m.body.data.products[ids.laksa]!;
    expect(laksa.parent_category_id).toBe(ids.food);
    expect(laksa.modifier_groups).toEqual([ids.protein]);
    expect(laksa.available_now).toBe(true);
    expect(laksa.prices_by_order_type.delivery).toBe(1800);
    expect(m.body.data.modifier_groups[ids.protein]!.options.map((o) => [o.name, o.price])).toEqual([
      ["Prawn", 200],
      ["Chicken", 50],
    ]);

    // Sold out today → menu says so.
    const so = await call("POST", "/v1/stock/sold-out", { token: A.cashier.token, body: { outlet_id: A.outletId, product_id: ids.laksa, until: "today" } });
    expect(so.status).toBe(200);
    const m2 = await call<{ data: { products: Record<string, { sold_out: boolean; unavailable_reason: string }> } }>("GET", `/v1/channel-links/${ids.link}/menu`, { token: A.server.token });
    expect(m2.body.data.products[ids.laksa]!.sold_out).toBe(true);
    expect(m2.body.data.products[ids.laksa]!.unavailable_reason).toBe("Sold out");
    expect((await call("POST", "/v1/stock/restore", { token: A.cashier.token, body: { outlet_id: A.outletId, product_id: ids.laksa } })).status).toBe(200);

    // Availability window that excludes right now → unavailable with a reason; a server cannot mark sold out.
    expect((await call("POST", "/v1/stock/sold-out", { token: A.server.token, body: { outlet_id: A.outletId, product_id: ids.laksa, until: "today" } })).status).toBe(403);
    const rule = await call("POST", "/v1/availability-rules", { token: A.admin.token, body: { target_kind: "product", target_id: ids.laksa, days_of_week: [], start_time: "00:00", end_time: "00:01" } });
    expect(rule.status).toBe(201);
    const m3 = await call<{ data: { products: Record<string, { available_now: boolean; unavailable_reason: string }> } }>("GET", `/v1/channel-links/${ids.link}/menu`, { token: A.server.token });
    expect(m3.body.data.products[ids.laksa]!.available_now).toBe(false);
    expect(m3.body.data.products[ids.laksa]!.unavailable_reason).toBe("Not available at this time");
  });

  it("daily caps are set by Manager+ and count down atomically", async () => {
    expect((await call("POST", "/v1/stock/daily-cap", { token: A.cashier.token, body: { outlet_id: A.outletId, product_id: ids.laksa, quantity: 2 } })).status).toBe(403);
    const cap = await call<{ data: { cap_remaining: number } }>("POST", "/v1/stock/daily-cap", { token: A.manager.token, body: { outlet_id: A.outletId, product_id: ids.laksa, quantity: 2 } });
    expect(cap.body.data.cap_remaining).toBe(2);
    const { consumeDailyCap } = await import("../src/routes/catalogue.js");
    const { withTransaction } = await import("../src/db/client.js");
    const today = new Date().toISOString().slice(0, 10);
    const results = await Promise.all([1, 1, 1].map(() => withTransaction(() => consumeDailyCap(A.outletId, ids.laksa, 1, today))));
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.find((r) => !r.ok)!.remaining).toBe(0);
    const [row] = await db.sql`select cap_remaining from stock_status where product_id = ${ids.laksa}`;
    expect(row!.cap_remaining).toBe(0);
    expect((await call("POST", "/v1/stock/daily-cap", { token: A.manager.token, body: { outlet_id: A.outletId, product_id: ids.laksa, quantity: null } })).status).toBe(200);
  });

  it("modifier groups refuse a third nesting level in the database", async () => {
    const g1 = randomUUID();
    const g2 = randomUUID();
    const g3 = randomUUID();
    const p = randomUUID();
    await call("POST", "/v1/products", { token: A.admin.token, body: { id: p, name: "Opt", price: 0, kind: "component" } });
    expect((await call("POST", "/v1/modifier-groups", { token: A.admin.token, body: { id: g3, name: "L3", options: [{ product_id: p }] } })).status).toBe(201);
    expect((await call("POST", "/v1/modifier-groups", { token: A.admin.token, body: { id: g2, name: "L2", options: [{ product_id: p, child_group_id: g3 }] } })).status).toBe(201);
    const r = await call<{ code: string; message: string }>("POST", "/v1/modifier-groups", { token: A.admin.token, body: { id: g1, name: "L1", options: [{ product_id: p, child_group_id: g2 }] } });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/2 levels/);
  });

  it("layouts validate folder depth and bump their version", async () => {
    const bad = await call<{ code: string }>("POST", "/v1/layouts", { token: A.admin.token, body: { brand_id: A.brandId, name: "Bad", pages: [{ id: "p1", name: "Mains", tiles: [{ id: "f", kind: "folder", label: "F", color: "sage", access_level: "everyone", tiles: [{ id: "f2", kind: "folder", label: "F2", color: "sage", access_level: "everyone", tiles: [] }] }] }] } });
    expect(bad.status).toBe(400);
    const ok = await call<{ data: { id: string; version: number } }>("POST", "/v1/layouts", { token: A.admin.token, body: { brand_id: A.brandId, name: "Main", pages: [{ id: "p1", name: "Mains", tiles: [{ id: "t1", kind: "product", product_id: ids.laksa, label: "Laksa", color: "amber", access_level: "everyone" }] }] } });
    expect(ok.status).toBe(201);
    const upd = await call<{ data: { version: number } }>("PATCH", `/v1/layouts/${ok.body.data.id}`, { token: A.admin.token, body: { name: "Main v2" } });
    expect(upd.body.data.version).toBe(2);
  });

  it("floor: areas and tables are outlet-scoped; an outlet-limited cashier cannot see another outlet's tables", async () => {
    const area = await call<{ data: { id: string } }>("POST", "/v1/areas", { token: A.admin.token, body: { outlet_id: A.outletId, name: "Main dining" } });
    expect(area.status).toBe(201);
    const t = await call("POST", "/v1/tables", { token: A.admin.token, body: { outlet_id: A.outletId, area_id: area.body.data.id, name: "12", seats: 4, shape: "round", x: 3, y: 2 } });
    expect(t.status).toBe(201);
    const mine = await call<{ data: unknown[] }>("GET", `/v1/tables?outlet_id=${A.outletId}`, { token: A.admin.token });
    expect(mine.body.data).toHaveLength(1);
    const theirs = await call<{ data: unknown[] }>("GET", `/v1/tables?outlet_id=${A.outletId}`, { token: A.outlet2Cashier.token });
    // An outlet outside the person's scope is refused outright, not answered with an empty list.
    expect(theirs.status).toBe(404);
  });

  it("reference lists and customers", async () => {
    expect((await call("POST", "/v1/tender-types", { token: A.admin.token, body: { name: "Cash", is_cash: true } })).status).toBe(201);
    expect((await call("POST", "/v1/tender-types", { token: A.admin.token, body: { name: "Card", is_terminal: true } })).status).toBe(201);
    expect((await call("POST", "/v1/void-reasons", { token: A.admin.token, body: { name: "Customer changed mind" } })).status).toBe(201);
    const group = await call<{ data: { id: string } }>("POST", "/v1/customer-groups", { token: A.manager.token, body: { name: "VIP" } });
    expect(group.status).toBe(201);
    const cust = await call<{ data: { id: string; mobile: string; group_ids: string[] } }>("PUT", "/v1/customers", { token: A.manager.token, body: { name: "Lim Wei", mobile: "+65 0000 4567", group_ids: [group.body.data.id] } });
    expect(cust.status).toBe(200);
    expect(cust.body.data.mobile).toBe("+6500004567");
    expect(cust.body.data.group_ids).toEqual([group.body.data.id]);
    // Same mobile again updates the same customer.
    const again = await call<{ data: { id: string } }>("PUT", "/v1/customers", { token: A.cashier.token, body: { name: "Lim Wei Ling", mobile: "+6500004567" } });
    expect(again.body.data.id).toBe(cust.body.data.id);
    const found = await call<{ data: { name: string }[] }>("GET", "/v1/customers?mobile=0000", { token: A.server.token });
    expect(found.body.data.map((c) => c.name)).toEqual([]);
    const found2 = await call<{ data: { name: string }[] }>("GET", "/v1/customers?mobile=%2B6500", { token: A.server.token });
    expect(found2.body.data.map((c) => c.name)).toEqual(["Lim Wei Ling"]);
    const members = await call<{ data: { member_count: number } }>("POST", `/v1/customer-groups/${group.body.data.id}/members`, { token: A.manager.token, body: { remove: [cust.body.data.id] } });
    expect(members.body.data.member_count).toBe(0);
  });

  it("CSV export lists products in the importer's format", async () => {
    const r = await call<string>("GET", "/v1/exports/products.csv", { token: A.manager.token });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/csv/);
    expect(r.body).toMatch(/^legacy_id,sku,name,kind,price/);
    expect(r.body).toMatch(/LAK-001,Laksa,product,16\.00/);
  });
});
