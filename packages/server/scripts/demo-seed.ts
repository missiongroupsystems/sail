/**
 * Demo data for a deployed instance (examples/preview): two merchants in different tax regimes, each with a small menu,
 * modifiers, a floor plan, POS stations, kitchen displays, tenders (one sent to the card-terminal simulator), staff
 * with PINs and one back-office Admin with a generated password.
 *
 *   DATABASE_URL=postgres://... STATION_TOKEN_SECRET=<the API's value> pnpm --filter @sail/server demo:seed
 *
 * DATABASE_URL may go through a transaction pooler: each merchant is written in one transaction, with no session
 * state and no prepared statements. It is safe to run again: a merchant whose Admin email already has a login is left
 * as it is, so nothing is duplicated and no password changes. Each new Admin's password is printed once, here only.
 * STATION_TOKEN_SECRET must be the API's, because staff PINs are stored with a lookup keyed by it.
 */
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import postgres, { type TransactionSql } from "postgres";
import type { RegionPresetKey, Role } from "@sail/shared";
import { createMerchant, type BootstrapResult } from "../src/bootstrap.js";
import { demoWriter } from "./dev-seed.js";

type Item = { name: string; price: number; taxClass?: string; tags?: string[]; modifiers?: string[] };
type Group = { name: string; min: number; max: number; options: [string, number][] };

/** One demo merchant, as data. Prices are in minor units; `taxClass` is a preset class code (the default class when absent). */
export type DemoMerchant = {
  key: string;
  merchantName: string;
  outletName: string;
  preset: RegionPresetKey;
  timeZone: string;
  admin: { name: string; email: string; pin: string };
  staff: [name: string, role: Role, pin: string][];
  groups: Group[];
  sections: { name: string; items: Item[] }[];
  areas: { name: string; tables: [name: string, seats: number][] }[];
  guestRequests: string[];
};

const STAFF: DemoMerchant["staff"] = [
  ["Morgan Manager", "manager", "222222"],
  ["Casey Cashier", "cashier", "333333"],
  ["Sam Server", "server", "444444"],
  ["Frankie Finance", "finance", "555555"],
];

export const DEMO_MERCHANTS: DemoMerchant[] = [
  {
    key: "us",
    merchantName: "Sample Diner",
    outletName: "Sample Diner · Main Street",
    preset: "us",
    timeZone: "America/New_York",
    admin: { name: "Alex Admin", email: "admin.us@example.com", pin: "123456" },
    staff: STAFF,
    groups: [
      { name: "Cook", min: 1, max: 1, options: [["Medium", 0], ["Medium rare", 0], ["Well done", 0]] },
      { name: "Add-ons", min: 0, max: 3, options: [["Bacon", 150], ["Extra cheese", 100], ["Avocado", 200]] },
      { name: "Size", min: 1, max: 1, options: [["Regular", 0], ["Large", 150]] },
    ],
    sections: [
      {
        name: "Burgers",
        items: [
          { name: "Classic burger", price: 1299, tags: ["kitchen"], modifiers: ["Cook", "Add-ons"] },
          { name: "Cheeseburger", price: 1399, tags: ["kitchen"], modifiers: ["Cook", "Add-ons"] },
          { name: "Veggie burger", price: 1249, tags: ["kitchen"], modifiers: ["Add-ons"] },
        ],
      },
      {
        name: "Sides",
        items: [
          { name: "Fries", price: 449, tags: ["kitchen"], modifiers: ["Size"] },
          { name: "Onion rings", price: 549, tags: ["kitchen"] },
          { name: "Garden salad", price: 899, tags: ["kitchen"] },
        ],
      },
      {
        name: "Drinks",
        items: [
          { name: "Soda", price: 249, tags: ["bar"], modifiers: ["Size"] },
          { name: "Iced tea", price: 299, tags: ["bar"] },
          { name: "Coffee", price: 279, tags: ["bar"] },
          { name: "Draft beer", price: 699, tags: ["bar", "alcohol"] },
          { name: "Bottled water to go", price: 199, taxClass: "exempt", tags: ["bar"] },
        ],
      },
    ],
    areas: [
      { name: "Dining room", tables: [["1", 2], ["2", 2], ["3", 4], ["4", 4], ["5", 6], ["6", 4]] },
      { name: "Patio", tables: [["10", 4], ["11", 4], ["12", 2]] },
    ],
    guestRequests: ["Water", "Napkins", "Ketchup"],
  },
  {
    key: "eu",
    merchantName: "Sample Café",
    outletName: "Sample Café · Riverside",
    preset: "eu-vat",
    timeZone: "Europe/Dublin",
    admin: { name: "Robin Admin", email: "admin.eu@example.com", pin: "123456" },
    staff: STAFF,
    groups: [
      { name: "Milk", min: 1, max: 1, options: [["Whole milk", 0], ["Oat milk", 40], ["No milk", 0]] },
      { name: "Bread", min: 1, max: 1, options: [["White", 0], ["Brown", 0], ["Gluten-free", 100]] },
      { name: "Extras", min: 0, max: 3, options: [["Butter", 0], ["Jam", 0], ["Cream", 50]] },
    ],
    sections: [
      {
        name: "Food",
        items: [
          { name: "Soup of the day", price: 650, taxClass: "reduced", tags: ["kitchen"] },
          { name: "Toasted sandwich", price: 850, taxClass: "reduced", tags: ["kitchen"], modifiers: ["Bread"] },
          { name: "Quiche with salad", price: 1150, taxClass: "reduced", tags: ["kitchen"] },
          { name: "Scone", price: 350, taxClass: "reduced", tags: ["kitchen"], modifiers: ["Extras"] },
          { name: "Chocolate cake", price: 495, taxClass: "reduced", tags: ["kitchen"] },
        ],
      },
      {
        name: "Drinks",
        items: [
          { name: "Flat white", price: 380, tags: ["bar"], modifiers: ["Milk"] },
          { name: "Tea", price: 300, tags: ["bar"], modifiers: ["Milk"] },
          { name: "Orange juice", price: 400, tags: ["bar"] },
          { name: "Sparkling water", price: 300, tags: ["bar"] },
          { name: "Glass of wine", price: 750, tags: ["bar", "alcohol"] },
        ],
      },
    ],
    areas: [
      { name: "Café", tables: [["1", 2], ["2", 2], ["3", 4], ["4", 4], ["5", 4], ["6", 6]] },
      { name: "Terrace", tables: [["7", 4], ["8", 4]] },
    ],
    guestRequests: ["Water", "Cutlery", "Napkins"],
  },
];

export type SeededDemoMerchant = {
  key: string;
  merchantName: string;
  adminEmail: string;
  /** Only when this run created the merchant: the Admin's back-office password, never stored anywhere in clear. */
  adminPassword: string | null;
  merchantId: string;
  outletId: string;
  posStationIds: string[];
  kitchenDisplayIds: string[];
};

/** Write one demo merchant inside the caller's transaction, as the connection owner. */
export async function writeDemoMerchant(tx: TransactionSql, spec: DemoMerchant, adminPassword: string): Promise<{ boot: BootstrapResult; posStationIds: string[]; kitchenDisplayIds: string[] }> {
  const boot = await createMerchant(tx, { merchantName: spec.merchantName, outletName: spec.outletName, preset: spec.preset, timeZone: spec.timeZone, admin: { ...spec.admin, password: adminPassword } });
  const m = boot.merchantId;
  const w = demoWriter(tx, m);
  const taxClass = (code: string | undefined) => {
    if (code === undefined) return null;
    const id = boot.taxClassIds[code];
    if (!id) throw new Error(`The ${spec.preset} preset has no tax class ${code}`);
    return id;
  };

  const groupIds = new Map<string, string>();
  for (const g of spec.groups) {
    const options: [string, number | null][] = [];
    for (const [name, price] of g.options) options.push([await w.product(name, price, { kind: "component" }), null]);
    groupIds.set(g.name, await w.modifierGroup(g.name, g.min, g.max, options));
  }
  const group = (name: string) => {
    const id = groupIds.get(name);
    if (!id) throw new Error(`${spec.merchantName} has no modifier group ${name}`);
    return id;
  };
  const menuId = await w.menu(boot.brandId, "All day");
  for (const [sort, section] of spec.sections.entries()) {
    const category = await w.category(section.name);
    const items: string[] = [];
    for (const item of section.items) {
      const id = await w.product(item.name, item.price, { category, tags: item.tags, taxClassId: taxClass(item.taxClass) });
      await w.attach(id, (item.modifiers ?? []).map(group));
      items.push(id);
    }
    await w.section(menuId, section.name, items, sort + 1);
  }
  await tx`insert into channel_links (merchant_id, channel, outlet_id, brand_id, menu_id) values (${m}, 'pos', ${boot.outletId}, ${boot.brandId}, ${menuId})`;
  // Guests' rounds wait for staff to accept them; the first scan opens the table's order, so a tester needs no POS for it.
  await tx`insert into channel_links (merchant_id, channel, outlet_id, brand_id, menu_id, hold_orders, open_on_first_scan, service_requests) values (${m}, 'scan_to_order', ${boot.outletId}, ${boot.brandId}, ${menuId}, true, true, ${tx.json(spec.guestRequests)})`;

  for (const [sort, area] of spec.areas.entries()) {
    const areaId = await w.area(boot.outletId, area.name, sort + 1);
    for (const [i, [name, seats]] of area.tables.entries()) await w.table(boot.outletId, areaId, name, seats, seats > 4 ? "rect" : "square", (i % 4) * 3, Math.floor(i / 4) * 3, seats > 4 ? 3 : 2, 2);
  }

  await w.terminalTender(5);
  await w.voidReasons(["Customer changed mind", "Wrong item keyed", "Kitchen error", "Other"]);
  for (const [name, role, pin] of spec.staff) await w.staff(name, role, pin);

  // Pairing a station again signs out the device paired before, so testers each get a station of their own.
  const posStationIds = [boot.stationId];
  for (const name of ["Station 2", "Station 3"]) {
    const [row] = await tx<{ id: string }[]>`insert into stations (merchant_id, outlet_id, brand_id, name, seats_enabled) values (${m}, ${boot.outletId}, ${boot.brandId}, ${name}, true) returning id`;
    posStationIds.push(row!.id);
  }
  const kitchenDisplayIds = await w.kitchenDisplays(boot.outletId, ["Kitchen display 1", "Kitchen display 2"]);
  return { boot, posStationIds, kitchenDisplayIds };
}

/** Create every demo merchant that is not there yet, each in its own transaction. */
export async function demoSeed(url: string, merchants: DemoMerchant[] = DEMO_MERCHANTS): Promise<SeededDemoMerchant[]> {
  const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 30, onnotice: () => {} });
  const out: SeededDemoMerchant[] = [];
  try {
    for (const spec of merchants) {
      const row = (await sql.begin(async (tx) => {
        // Two runs at once: the second waits here, then finds the first one's merchant.
        await tx`select pg_advisory_xact_lock(hashtext('sail.demo-seed'))`;
        const [existing] = await tx<{ merchant_id: string }[]>`select merchant_id from backoffice_logins where email = ${spec.admin.email.toLowerCase()}`;
        if (existing) {
          const [outlet] = await tx<{ id: string }[]>`select id from outlets where merchant_id = ${existing.merchant_id} order by created_at limit 1`;
          const stations = await tx<{ id: string; kind: string }[]>`select id, kind from stations where merchant_id = ${existing.merchant_id} and archived_at is null order by created_at, name`;
          return { merchantId: existing.merchant_id, outletId: outlet!.id, adminPassword: null, posStationIds: stations.filter((s) => s.kind === "pos").map((s) => s.id), kitchenDisplayIds: stations.filter((s) => s.kind === "display").map((s) => s.id) };
        }
        const adminPassword = randomBytes(18).toString("base64url");
        const r = await writeDemoMerchant(tx, spec, adminPassword);
        return { merchantId: r.boot.merchantId, outletId: r.boot.outletId, adminPassword, posStationIds: r.posStationIds, kitchenDisplayIds: r.kitchenDisplayIds };
      })) as Omit<SeededDemoMerchant, "key" | "merchantName" | "adminEmail">;
      out.push({ key: spec.key, merchantName: spec.merchantName, adminEmail: spec.admin.email, ...row });
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
  return out;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const url = process.env.DATABASE_URL;
  if (!url || !process.env.STATION_TOKEN_SECRET) {
    console.error("usage: DATABASE_URL=postgres://... STATION_TOKEN_SECRET=<the API's value> demo:seed");
    process.exit(1);
  }
  const seeded = await demoSeed(url);
  for (const s of seeded) {
    const spec = DEMO_MERCHANTS.find((d) => d.key === s.key)!;
    console.log(`\n${s.merchantName} (${spec.preset}, ${spec.timeZone})${s.adminPassword ? "" : ": already there, left as it was"}`);
    console.log(`  merchant ${s.merchantId}, outlet ${s.outletId}`);
    console.log(`  POS stations ${s.posStationIds.join(", ")}`);
    console.log(`  kitchen displays ${s.kitchenDisplayIds.join(", ")}`);
    console.log(`  back office: ${s.adminEmail}, password ${s.adminPassword ?? "(set when it was first seeded; not shown again)"}`);
    console.log(`  PINs: ${spec.admin.name} (admin) ${spec.admin.pin}, ${spec.staff.map(([name, role, pin]) => `${name} (${role}) ${pin}`).join(", ")}`);
  }
  if (seeded.some((s) => s.adminPassword)) console.log("\nEach password above is shown this once. Keep it in the Keychain now.");
}
