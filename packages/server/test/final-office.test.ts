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

describe("import report (A P13)", () => {
  it("a product row lists every problem it has, a bad kind among them, and a good row with a legacy kind is accepted", async () => {
    const token = await adminToken(seeded[0]!);
    const csv = "sku,name,price,kind,tax_class\r\nX-1,,abc,widget,Luxury\r\nX-2,Thing,1.00,Item,\r\nX-3,Extra,0.50,Modifier,\r\n";
    const job = await importProducts(token, csv);
    const products = job.report!.entities.products!;
    expect(products.creates).toBe(2);
    expect(products.rejected).toHaveLength(1);
    const reason = products.rejected[0]!.reason;
    for (const part of ["name is required", 'price "abc" is not an amount', 'kind "widget" is not product or component', 'tax class "Luxury" not found']) expect(reason).toContain(part);
  });
});

describe("forgotten password, without email (A P11)", () => {
  it("the operator's reset link sets a new password once, ends the old sessions, and is in the audit log", async () => {
    const { operatorResetLink } = await import("../src/services/operator-reset.js");
    const s = seeded[0]!;
    const before = await adminToken(s);
    await expect(operatorResetLink(db.sql, "nobody@example.com", "https://office.example.com")).rejects.toThrow(/No back-office login/);
    const link = await operatorResetLink(db.sql, s.adminEmail.toUpperCase(), "https://office.example.com/");
    expect(link.url).toMatch(/^https:\/\/office\.example\.com\/set-password#token=/);
    const token = new URL(link.url).hash.replace(/^#token=/, "");
    const inspect = await call<{ data: { kind: string } }>("POST", "/v1/auth/links/inspect", { body: { token }, idempotencyKey: null });
    expect(inspect.status).toBe(200);
    expect(inspect.body.data.kind).toBe("reset");
    const password = "a new long password for the owner";
    const accepted = await call("POST", "/v1/auth/links/accept", { body: { token, password } });
    expect(accepted.status, JSON.stringify(accepted.body)).toBeLessThan(300);
    expect((await call("POST", "/v1/auth/links/accept", { body: { token, password } })).status).toBeGreaterThanOrEqual(400);
    expect((await call("GET", "/v1/me", { token: before })).status).toBe(401);
    const signIn = await call("POST", "/v1/auth/sign-in", { body: { email: s.adminEmail, password }, idempotencyKey: null });
    expect(signIn.status).toBe(201);
    const audit = await db.sql<{ actor_name: string }[]>`select actor_name from audit_log where merchant_id = ${s.merchantId} and action = 'staff.reset_password'`;
    expect(audit.map((a) => a.actor_name)).toContain("Server operator");
    // Later tests sign in with the seeded password.
    s.adminPassword = password;
  });
});

describe("QR sheet order (A P18)", () => {
  it("compares tables 1, 2, 10, as people count them", async () => {
    const { TABLE_ORDER } = await import("../src/services/guest.js");
    expect(["Table 10", "Table 2", "Table 1", "Bar 3", "table 11"].sort((a, b) => TABLE_ORDER.compare(a, b))).toEqual(["Bar 3", "Table 1", "Table 2", "Table 10", "table 11"]);
    expect(["10", "2", "1"].sort((a, b) => TABLE_ORDER.compare(a, b))).toEqual(["1", "2", "10"]);
  });
});
