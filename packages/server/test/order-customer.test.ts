import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/modules.js";
import { buildApp, type App } from "../src/app.js";
import { api, freshDb, seedMerchant, type SeededMerchant, type TestDb } from "./helpers.js";

/** A pickup order made from another type attaches or creates its customer, as opening one as pickup does (final review B-P9). */
let db: TestDb;
let app: App;
let A: SeededMerchant;
let call: ReturnType<typeof api>["call"];
const ids = { kopi: randomUUID(), menu: randomUUID(), link: randomUUID(), existing: randomUUID() };
type Snap = { data: { id: string; version: number; order_type: string; customer_id: string | null } };

beforeAll(async () => {
  db = await freshDb();
  app = buildApp();
  call = api(app).call;
  A = await seedMerchant(db.sql, "Alpha");
  const t = A.admin.token;
  await call("POST", "/v1/products", { token: t, body: { id: ids.kopi, name: "Kopi", price: 180 } });
  await call("POST", "/v1/menus", { token: t, body: { id: ids.menu, brand_id: A.brandId, name: "M", sections: [{ name: "All", items: [{ product_id: ids.kopi }] }] } });
  await call("POST", "/v1/channel-links", { token: t, body: { id: ids.link, channel: "pos", outlet_id: A.outletId, brand_id: A.brandId, menu_id: ids.menu } });
  await call("PUT", "/v1/customers", { token: A.manager.token, body: { id: ids.existing, name: "Lim", mobile: "+6500004567" } });
});
afterAll(async () => db.drop());

const takeaway = async () => {
  const o = await call<Snap>("POST", "/v1/orders", { token: A.manager.token, body: { order_id: randomUUID(), order_type: "takeaway", outlet_id: A.outletId, brand_id: A.brandId } });
  expect(o.status, JSON.stringify(o.body)).toBe(201);
  return o.body.data;
};
const customerByMobile = async (mobile: string) => db.sql<{ id: string; name: string }[]>`select id, name from customers where mobile = ${mobile}`;

describe("customer on a pickup order", () => {
  it("changing a takeaway to pickup with a name and a new mobile creates the customer and attaches them", async () => {
    const o = await takeaway();
    const r = await call<Snap>("POST", `/v1/orders/${o.id}/change-type`, { token: A.manager.token, body: { order_type: "pickup", customer_ref: { name: "Ana", mobile: "+65 0000 1111" }, expected_version: o.version } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [cust] = await customerByMobile("+6500001111");
    expect(cust?.name).toBe("Ana");
    expect(r.body.data.customer_id).toBe(cust!.id);
  });

  it("a mobile that belongs to a customer attaches that customer and keeps their name", async () => {
    const o = await takeaway();
    const r = await call<Snap>("POST", `/v1/orders/${o.id}/change-type`, { token: A.manager.token, body: { order_type: "pickup", customer_ref: { name: "Someone else", mobile: "+6500004567" }, expected_version: o.version } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.customer_id).toBe(ids.existing);
    expect((await customerByMobile("+6500004567"))[0]?.name).toBe("Lim");
  });

  it("a pickup given a mobile later attaches the customer too; a takeaway's name alone creates nobody", async () => {
    const o = await takeaway();
    const named = await call<Snap>("PATCH", `/v1/orders/${o.id}`, { token: A.manager.token, body: { customer_ref: { name: "Walk-in" }, expected_version: o.version } });
    expect(named.body.data.customer_id).toBeNull();
    const pickup = await call<Snap>("POST", `/v1/orders/${o.id}/change-type`, { token: A.manager.token, body: { order_type: "pickup", customer_ref: { name: "Bo" }, expected_version: named.body.data.version } });
    expect(pickup.status, JSON.stringify(pickup.body)).toBe(200);
    expect(pickup.body.data.customer_id).toBeNull();
    const later = await call<Snap>("PATCH", `/v1/orders/${o.id}`, { token: A.manager.token, body: { customer_ref: { name: "Bo", mobile: "+6500002222" }, expected_version: pickup.body.data.version } });
    expect(later.status, JSON.stringify(later.body)).toBe(200);
    expect(later.body.data.customer_id).toBe((await customerByMobile("+6500002222"))[0]!.id);
  });
});
