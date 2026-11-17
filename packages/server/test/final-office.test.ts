import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/modules.js";
import { buildApp } from "../src/app.js";
import { demoSeed, type SeededDemoMerchant } from "../scripts/demo-seed.js";
import { runQueuedImports } from "../src/services/importer.js";
import { parseCsv } from "../src/services/csv.js";
import { api, freshDb, type TestDb } from "./helpers.js";

/** The final office round's server checks: the products CSV round trip (A P4). */
let db: TestDb;
let call: ReturnType<typeof api>["call"];
let seeded: SeededDemoMerchant[];

beforeAll(async () => {
  db = await freshDb();
  call = api(buildApp()).call;
  seeded = await demoSeed(db.url);
});
afterAll(async () => db.drop());

type Job = { id: string; status: string; report: { entities: Record<string, { creates: number; updates: number; unchanged: number; rejected: { row: number; reason: string }[] }>; warnings: string[] } | null };

async function adminToken(s: SeededDemoMerchant) {
  const r = await call<{ data: { token: string } }>("POST", "/v1/auth/sign-in", { body: { email: s.adminEmail, password: s.adminPassword }, idempotencyKey: null });
  expect(r.status).toBe(201);
  return r.body.data.token;
}

/** Import `csv` as products with every column mapped to the field of the same name, as the import page maps an export. */
async function importProducts(token: string, csv: string, dryRun = true) {
  const { headers } = parseCsv(csv);
  const columns = Object.fromEntries(headers.map((h) => [h, h]));
  const created = await call<{ data: Job }>("POST", "/v1/imports", { token, body: { mapping: { files: [{ name: "products.csv", entity: "products", columns }] }, files: { "products.csv": csv }, dry_run: dryRun } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  await runQueuedImports();
  const job = await call<{ data: Job }>("GET", `/v1/imports/${created.body.data.id}`, { token });
  return job.body.data;
}

describe("products CSV export and import round-trip (A P4)", () => {
  it("re-importing the export with no edits is 0 changes, on both demo merchants", async () => {
    for (const s of seeded) {
      const token = await adminToken(s);
      const exported = await call<string>("GET", "/v1/exports/products.csv", { token });
      expect(exported.status).toBe(200);
      const { rows } = parseCsv(exported.body);
      expect(rows.length).toBeGreaterThan(5);
      const job = await importProducts(token, exported.body);
      expect(job.status).toBe("dry_run_complete");
      const products = job.report!.entities.products!;
      expect(products.rejected, s.key).toEqual([]);
      expect({ creates: products.creates, updates: products.updates }).toEqual({ creates: 0, updates: 0 });
      expect(products.unchanged).toBe(rows.length);
    }
  });

  it("the export names each product's category, brand and per-order-type prices so they survive the trip", async () => {
    const s = seeded[0]!;
    const token = await adminToken(s);
    const [p] = await db.sql<{ id: string; name: string }[]>`select id, name from products where merchant_id = ${s.merchantId} and archived_at is null and sku is null order by name limit 1`;
    expect(p, "a demo product without a SKU").toBeTruthy();
    await db.sql`insert into product_prices (merchant_id, product_id, order_type, price) values (${s.merchantId}, ${p!.id}, 'takeaway', 123) on conflict (product_id, order_type) do update set price = excluded.price`;
    const exported = await call<string>("GET", "/v1/exports/products.csv", { token });
    const { headers, rows } = parseCsv(exported.body);
    expect(headers).toEqual(expect.arrayContaining(["sail_id", "category_legacy_id", "brand_legacy_id", "price_dine_in", "price_takeaway", "price_pickup", "price_delivery"]));
    const row = rows.find((r) => r.sail_id === p!.id)!;
    expect(row.price_takeaway).toBe("1.23");
    expect(row.sku).toBe("");

    // An edit to one price is one update, and the override itself counts as a change.
    const edited = exported.body.replace(`${p!.id},`, `${p!.id},`).split("\r\n").map((line) => (line.includes(p!.id) ? line.replace(",1.23,", ",1.50,") : line)).join("\r\n");
    const job = await importProducts(token, edited, false);
    expect(job.status).toBe("applied");
    expect(job.report!.entities.products).toMatchObject({ creates: 0, updates: 1, rejected: [] });
    const [price] = await db.sql<{ price: number }[]>`select price from product_prices where product_id = ${p!.id} and order_type = 'takeaway'`;
    expect(price!.price).toBe(150);
    // A blank per-order-type price in a file that has the column removes the override.
    const cleared = edited.split("\r\n").map((line) => (line.includes(p!.id) ? line.replace(",1.50,", ",,") : line)).join("\r\n");
    const again = await importProducts(token, cleared, false);
    expect(again.report!.entities.products).toMatchObject({ creates: 0, updates: 1, rejected: [] });
    expect(await db.sql`select 1 from product_prices where product_id = ${p!.id} and order_type = 'takeaway'`).toHaveLength(0);
    const [still] = await db.sql<{ legacy_id: string | null; n: number }[]>`select legacy_id, (select count(*)::int from products where merchant_id = ${s.merchantId} and name = ${p!.name}) as n from products where id = ${p!.id}`;
    expect(still).toEqual({ legacy_id: null, n: 1 });
  });
});
