import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/modules.js";
import { buildApp } from "../src/app.js";
import { DEMO_MERCHANTS, demoSeed, type SeededDemoMerchant } from "../scripts/demo-seed.js";
import { api, freshDb, type TestDb } from "./helpers.js";

/**
 * The hosted demo's seed (examples/preview). A tester gets in with what it prints: the Admin's email and password in
 * the back office, a pairing code for one of the POS stations or kitchen displays, then the documented staff PINs.
 * It runs against a shared remote database, so a second run must change nothing, least of all the passwords.
 */
let db: TestDb;
let call: ReturnType<typeof api>["call"];
let first: SeededDemoMerchant[];

beforeAll(async () => {
  db = await freshDb();
  call = api(buildApp()).call;
  first = await demoSeed(db.url);
});
afterAll(async () => db.drop());

const signIn = (email: string, password: string) => call<{ data: { token: string } }>("POST", "/v1/auth/sign-in", { body: { email, password }, idempotencyKey: null });

async function pairedStation(adminToken: string, stationId: string, kind: "pos" | "display") {
  const code = await call<{ data: { code: string } }>("POST", `/v1/stations/${stationId}/pairing-code`, { token: adminToken, body: {} });
  expect(code.status, JSON.stringify(code.body)).toBe(201);
  const paired = await call<{ data: { station_token: string } }>("POST", "/v1/stations/pair", { body: { code: code.body.data.code, device_label: "demo tester", kind }, idempotencyKey: null });
  expect(paired.status, JSON.stringify(paired.body)).toBe(200);
  return paired.body.data.station_token;
}

describe("demo seed", () => {
  it("creates a US and an EU VAT merchant, each with a generated Admin password that signs in", async () => {
    expect(first.map((s) => s.key)).toEqual(["us", "eu"]);
    for (const s of first) {
      expect(s.adminPassword).toMatch(/^[\w-]{24}$/);
      const [settings] = await db.sql<{ currency: string; tax_mode: string; tips_enabled: boolean }[]>`select currency, tax_mode, tips_enabled from merchant_settings where merchant_id = ${s.merchantId}`;
      expect(settings).toEqual(s.key === "us" ? { currency: "USD", tax_mode: "exclusive", tips_enabled: true } : { currency: "EUR", tax_mode: "inclusive", tips_enabled: false });
      expect((await signIn(s.adminEmail, s.adminPassword!)).status).toBe(201);
    }
    expect(first[0]!.adminPassword).not.toBe(first[1]!.adminPassword);
  });

  it("gives each merchant a menu with modifiers, tax classes in use, tables, a terminal tender and Scan to Order", async () => {
    for (const s of first) {
      const [counts] = await db.sql<{ items: number; with_modifiers: number; tax_classes: number; tables: number; guest_links: number }[]>`
        select (select count(*)::int from menu_items where merchant_id = ${s.merchantId}) as items,
               (select count(distinct product_id)::int from product_modifier_groups where merchant_id = ${s.merchantId}) as with_modifiers,
               (select count(distinct coalesce(p.tax_class_id::text, 'default'))::int from products p join menu_items i on i.product_id = p.id where p.merchant_id = ${s.merchantId}) as tax_classes,
               (select count(*)::int from tables where merchant_id = ${s.merchantId}) as tables,
               (select count(*)::int from channel_links where merchant_id = ${s.merchantId} and channel = 'scan_to_order' and enabled) as guest_links`;
      expect(counts!.items).toBeGreaterThanOrEqual(10);
      expect(counts!.with_modifiers).toBeGreaterThanOrEqual(3);
      // Two tax classes on the menu, so a mixed bill shows two tax lines in either regime.
      expect(counts!.tax_classes).toBe(2);
      expect(counts!.tables).toBeGreaterThanOrEqual(8);
      expect(counts!.guest_links).toBe(1);
      const terminal = await db.sql`select 1 from tender_types t join payment_provider_accounts a on a.merchant_id = t.merchant_id and a.provider = t.provider where t.merchant_id = ${s.merchantId} and t.provider = 'simulator' and t.terminal_id = 'sim-1'`;
      expect(terminal.length).toBe(1);
      expect(s.posStationIds.length).toBe(3);
      expect(s.kitchenDisplayIds.length).toBe(2);
    }
  });

  it("every documented PIN signs in on a paired POS, with the documented role, and a kitchen display pairs without one", async () => {
    for (const s of first) {
      const spec = DEMO_MERCHANTS.find((d) => d.key === s.key)!;
      const admin = (await signIn(s.adminEmail, s.adminPassword!)).body.data.token;
      const station = await pairedStation(admin, s.posStationIds[1]!, "pos");
      for (const [name, role, pin] of [[spec.admin.name, "admin", spec.admin.pin], ...spec.staff] as const) {
        const res = await call<{ data: { staff: { name: string; role: string } } }>("POST", "/v1/stations/sessions", { token: station, body: { pin } });
        expect(res.status, `${name}: ${JSON.stringify(res.body)}`).toBe(201);
        expect(res.body.data.staff).toMatchObject({ name, role });
      }
      await pairedStation(admin, s.kitchenDisplayIds[0]!, "display");
    }
  });

  it("a second run changes nothing and leaves the first passwords working", async () => {
    const before = await db.sql<{ n: number }[]>`select (select count(*) from merchants) + (select count(*) from products) + (select count(*) from staff) + (select count(*) from stations) + (select count(*) from tables) as n`;
    const again = await demoSeed(db.url);
    expect(again.map((s) => s.adminPassword)).toEqual([null, null]);
    expect(again.map((s) => [s.merchantId, s.outletId, s.posStationIds, s.kitchenDisplayIds])).toEqual(first.map((s) => [s.merchantId, s.outletId, s.posStationIds, s.kitchenDisplayIds]));
    const after = await db.sql<{ n: number }[]>`select (select count(*) from merchants) + (select count(*) from products) + (select count(*) from staff) + (select count(*) from stations) + (select count(*) from tables) as n`;
    expect(after[0]!.n).toBe(before[0]!.n);
    for (const s of first) expect((await signIn(s.adminEmail, s.adminPassword!)).status).toBe(201);
  });
});
