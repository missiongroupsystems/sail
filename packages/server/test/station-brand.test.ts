import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/modules.js";
import { buildApp, type App } from "../src/app.js";
import { api, freshDb, seedMerchant, type SeededMerchant, type TestDb } from "./helpers.js";

/**
 * A POS station sells one brand's menu, so the register refuses one without a brand; a kitchen display has none. A
 * station saved without a brand before the rule keeps working for everything but orders, and can still be changed.
 */
let db: TestDb;
let app: App;
let A: SeededMerchant;
let call: ReturnType<typeof api>["call"];
type Refusal = { code: string; message: string; remedy?: string; details?: { field?: string } };

beforeAll(async () => {
  db = await freshDb();
  app = buildApp();
  call = api(app).call;
  A = await seedMerchant(db.sql, "Alpha");
});
afterAll(async () => db.drop());

describe("a POS station needs a brand", () => {
  it("create without a brand, or with a null brand, is refused with the field and a remedy", async () => {
    for (const body of [{ outlet_id: A.outletId, name: "No brand" }, { outlet_id: A.outletId, name: "Null brand", brand_id: null }, { outlet_id: A.outletId, name: "Named pos", kind: "pos" }]) {
      const r = await call<Refusal>("POST", "/v1/stations", { token: A.admin.token, body });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.code).toBe("validation");
      expect(r.body.message).toBe("A POS station needs a brand");
      expect(r.body.remedy).toMatch(/brand_id/);
      expect(r.body.details?.field).toBe("brand_id");
    }
    const left = await db.sql<{ n: number }[]>`select count(*)::int as n from stations where name in ('No brand', 'Null brand', 'Named pos')`;
    expect(left[0]!.n).toBe(0);
  });

  it("a kitchen display still saves without one", async () => {
    const r = await call<{ data: { id: string; brand_id: string | null; kind: string } }>("POST", "/v1/stations", { token: A.admin.token, body: { outlet_id: A.outletId, name: "Pass screen", kind: "display" } });
    expect(r.status).toBe(201);
    expect(r.body.data.brand_id).toBeNull();
    const cleared = await call("PATCH", `/v1/stations/${r.body.data.id}`, { token: A.admin.token, body: { brand_id: null } });
    expect(cleared.status).toBe(200);
  });

  it("the brand cannot be taken off a POS station; another brand of the merchant is accepted", async () => {
    const st = await call<{ data: { id: string } }>("POST", "/v1/stations", { token: A.admin.token, body: { outlet_id: A.outletId, brand_id: A.brandId, name: "Counter" } });
    expect(st.status).toBe(201);
    const off = await call<Refusal>("PATCH", `/v1/stations/${st.body.data.id}`, { token: A.admin.token, body: { brand_id: null } });
    expect(off.status).toBe(400);
    expect(off.body.details?.field).toBe("brand_id");
    const brand = await call<{ data: { id: string } }>("POST", "/v1/brands", { token: A.admin.token, body: { name: "Second brand" } });
    const moved = await call<{ data: { brand_id: string } }>("PATCH", `/v1/stations/${st.body.data.id}`, { token: A.admin.token, body: { brand_id: brand.body.data.id } });
    expect(moved.status).toBe(200);
    expect(moved.body.data.brand_id).toBe(brand.body.data.id);
  });

  it("a station saved without a brand before the rule can be renamed, given a brand and archived, and says why it takes no orders", async () => {
    const id = randomUUID();
    await db.sql`insert into stations (id, merchant_id, outlet_id, name) values (${id}, ${A.merchantId}, ${A.outletId}, 'Old till')`;
    const renamed = await call<{ data: { name: string; brand_id: string | null } }>("PATCH", `/v1/stations/${id}`, { token: A.admin.token, body: { name: "Old till 2" } });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.brand_id).toBeNull();

    const code = await call<{ data: { code: string } }>("POST", `/v1/stations/${id}/pairing-code`, { token: A.admin.token, body: {} });
    const paired = await call<{ data: { station_token: string } }>("POST", "/v1/stations/pair", { body: { code: code.body.data.code, device_label: "iPad" }, idempotencyKey: null });
    const pin = await call<{ data: { session_token: string } }>("POST", "/v1/stations/sessions", { token: paired.body.data.station_token, body: { pin: "333333" } });
    const order = await call<Refusal>("POST", "/v1/orders", { token: pin.body.data.session_token, body: { order_id: randomUUID(), order_type: "takeaway" } });
    expect(order.status).toBe(400);
    expect(order.body.message).toMatch(/no brand/);

    const branded = await call<{ data: { brand_id: string } }>("PATCH", `/v1/stations/${id}`, { token: A.admin.token, body: { brand_id: A.brandId } });
    expect(branded.status).toBe(200);
    expect(branded.body.data.brand_id).toBe(A.brandId);
    const archived = await call<{ data: { archived: boolean } }>("PATCH", `/v1/stations/${id}`, { token: A.admin.token, body: { archived: true } });
    expect(archived.body.data.archived).toBe(true);
  });
});
