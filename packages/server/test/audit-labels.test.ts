import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/modules.js";
import { buildApp, type App } from "../src/app.js";
import { withTransaction } from "../src/db/client.js";
import { seedRulesForMerchant } from "../src/services/pricing-rules.js";
import { api, freshDb, seedMerchant, type SeededMerchant, type TestDb, sgSeedRules } from "./helpers.js";

/** The Changes page reads targets in an owner's words, not id fragments (live-test final2 A P-A3). */
let db: TestDb;
let app: App;
let A: SeededMerchant;
let call: ReturnType<typeof api>["call"];
const ids = { kopi: randomUUID(), menu: randomUUID(), area: randomUUID(), table: randomUUID() };
type Entry = { action: string; target_kind: string; target_id: string | null; target_label: string | null; value_kind: string | null; details: Record<string, unknown> };

beforeAll(async () => {
  db = await freshDb();
  app = buildApp();
  call = api(app).call;
  A = await seedMerchant(db.sql, "Alpha");
  await withTransaction(() => seedRulesForMerchant(A.merchantId, sgSeedRules(A)));
  const t = A.admin.token;
  await call("POST", "/v1/products", { token: t, body: { id: ids.kopi, name: "Kopi", price: 180, tags: ["bar"] } });
  await call("POST", "/v1/menus", { token: t, body: { id: ids.menu, brand_id: A.brandId, name: "Breakfast", sections: [{ name: "All", items: [{ product_id: ids.kopi }] }] } });
  await call("POST", "/v1/channel-links", { token: t, body: { id: randomUUID(), channel: "pos", outlet_id: A.outletId, brand_id: A.brandId, menu_id: ids.menu } });
  await call("POST", "/v1/areas", { token: t, body: { id: ids.area, outlet_id: A.outletId, name: "Main" } });
  await call("POST", "/v1/tables", { token: t, body: { id: ids.table, outlet_id: A.outletId, area_id: ids.area, name: "7" } });
});
afterAll(async () => {
  await db.drop();
});

describe("audit labels", () => {
  it("names orders by number, products, menus, tables and pricing rules by name, says a menu was archived, and how an entered value reads", async () => {
    const t = A.admin.token;
    const o = await call<{ data: { id: string; order_no: string; version: number } }>("POST", "/v1/orders", { token: t, body: { order_id: randomUUID(), order_type: "takeaway", outlet_id: A.outletId, brand_id: A.brandId } });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    const added = await call<{ data: { version: number } }>("POST", `/v1/orders/${o.body.data.id}/lines`, { token: t, body: { lines: [{ line_id: randomUUID(), product_id: ids.kopi, quantity: 2 }] } });
    expect(added.status).toBe(200);
    const disc = await call("POST", `/v1/orders/${o.body.data.id}/adjustments`, { token: t, body: { application_id: randomUUID(), rule_key: "seed:percent-off-bill", entered_value: 1500, expected_version: added.body.data.version } });
    expect(disc.status, JSON.stringify(disc.body)).toBe(200);
    await call("PATCH", `/v1/products/${ids.kopi}`, { token: t, body: { price: 200 } });
    await call("PATCH", `/v1/menus/${ids.menu}`, { token: t, body: { archived: true } });
    await call("POST", `/v1/tables/${ids.table}/qr/rotate`, { token: t, body: {} });

    const audit = (await call<{ data: Entry[] }>("GET", "/v1/audit?limit=50", { token: t })).body.data;
    const find = (action: string) => audit.find((a) => a.action === action)!;
    expect(find("orders.open").target_label).toBe(o.body.data.order_no);
    expect(find("adjustments.apply_manual")).toMatchObject({ target_label: o.body.data.order_no, value_kind: "percent", details: { entered_value: 1500, rule_name: "% off bill" } });
    expect(find("products.update").target_label).toBe("Kopi");
    expect(find("menus.update")).toMatchObject({ target_label: "Breakfast", details: { archived: true } });
    expect(find("tables.rotate_qr_token").target_label).toBe("Table 7");
    // Nothing reads as an id fragment where a name exists.
    for (const a of audit.filter((x) => ["order", "product", "menu", "table"].includes(x.target_kind))) expect(a.target_label, a.action).toBeTruthy();
  });
});
