import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/modules.js";
import { buildApp, type App } from "../src/app.js";
import { runQueuedImports } from "../src/services/importer.js";
import { api, freshDb, seedMerchant, type SeededMerchant, type TestDb } from "./helpers.js";

/**
 * A re-import updates what the file has and leaves the rest as the app has it: a column the file does not have keeps
 * the stored value; a blank cell in a column it has clears the field or sets its default, as on create.
 */

let db: TestDb;
let app: App;
let call: ReturnType<typeof api>["call"];

beforeAll(async () => {
  db = await freshDb();
  app = buildApp();
  call = api(app).call;
});
afterAll(async () => {
  await db.drop();
});

type Entities = Record<string, { creates: number; updates: number; unchanged: number; rejected: { reason: string }[] }>;
type Job = { id: string; status: string; error: string | null; report: { entities: Entities; warnings: string[] } | null };
type FileMap = { name: string; entity: string; columns: Record<string, string>; defaults?: Record<string, string> };

async function queue(m: SeededMerchant, files: FileMap[], csv: Record<string, string>, dryRun = false) {
  const r = await call<{ data: Job }>("POST", "/v1/imports", { token: m.admin.token, body: { mapping: { files }, files: csv, dry_run: dryRun } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data.id;
}
async function job(m: SeededMerchant, id: string) {
  return (await call<{ data: Job }>("GET", `/v1/imports/${id}`, { token: m.admin.token })).body.data;
}
async function run(m: SeededMerchant, files: FileMap[], csv: Record<string, string>, dryRun = false) {
  const id = await queue(m, files, csv, dryRun);
  await runQueuedImports();
  const j = await job(m, id);
  expect(j.status, j.error ?? "").toBe(dryRun ? "dry_run_complete" : "applied");
  return j.report!.entities;
}
async function must(m: SeededMerchant, method: string, path: string, body: unknown) {
  const r = await call<{ data: { id: string } }>(method, path, { token: m.admin.token, body });
  expect(r.status, `${method} ${path}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
  return r.body.data;
}
const idOf = async (table: string, merchantId: string, legacyId: string) => (await db.sql.unsafe<{ id: string }[]>(`select id from ${table} where merchant_id = $1 and legacy_id = $2`, [merchantId, legacyId]))[0]!.id;
const rowOf = async (table: string, id: string, cols: string) => (await db.sql.unsafe<Record<string, unknown>[]>(`select ${cols} from ${table} where id = $1`, [id]))[0]!;

const floor: FileMap[] = [
  { name: "brands.csv", entity: "brands", columns: { legacy_id: "ID", name: "Name" } },
  { name: "outlets.csv", entity: "outlets", columns: { legacy_id: "ID", name: "Name", brand_legacy_id: "Brand" } },
  { name: "categories.csv", entity: "categories", columns: { legacy_id: "ID", name: "Name" } },
  { name: "groups.csv", entity: "modifier_groups", columns: { legacy_id: "ID", name: "Name" } },
  { name: "menus.csv", entity: "menus", columns: { legacy_id: "ID", name: "Name", brand_legacy_id: "Brand" } },
  { name: "sections.csv", entity: "menu_sections", columns: { legacy_id: "ID", name: "Name", menu_legacy_id: "Menu" } },
  { name: "areas.csv", entity: "areas", columns: { legacy_id: "ID", name: "Name", outlet_legacy_id: "Outlet" } },
  { name: "tables.csv", entity: "tables", columns: { legacy_id: "ID", name: "Name", area_legacy_id: "Area" } },
  { name: "tenders.csv", entity: "tender_types", columns: { legacy_id: "ID", name: "Name", is_cash: "Cash" } },
  { name: "reasons.csv", entity: "void_reasons", columns: { legacy_id: "ID", name: "Name" } },
];
const floorCsv = (suffix: string) => ({
  "brands.csv": `ID,Name\nB1,Harbour${suffix}\n`,
  "outlets.csv": `ID,Name,Brand\nO1,Quay${suffix},B1\nO2,Pier,B1\n`,
  "categories.csv": `ID,Name\nC1,Food\nC2,Noodles${suffix}\n`,
  "groups.csv": `ID,Name\nG1,Sauce${suffix}\n`,
  "menus.csv": `ID,Name,Brand\nM1,All day${suffix},B1\nM2,Late,B1\n`,
  "sections.csv": `ID,Name,Menu\nS1,Mains,M1\nS2,Soups${suffix},M1\n`,
  "areas.csv": `ID,Name,Outlet\nA1,Terrace${suffix},O1\n`,
  "tables.csv": `ID,Name,Area\nT1,Table 1${suffix},A1\n`,
  "tenders.csv": `ID,Name,Cash\nCARD,Card${suffix},N\nCASH,Cash,Y\n`,
  "reasons.csv": `ID,Name\nR1,Wrong item${suffix}\n`,
});

describe("a re-import leaves what the file does not map alone", () => {
  it("brands, outlets, categories, modifier groups, sections, areas, tables, tenders and void reasons keep what was set in the app", async () => {
    const M = await seedMerchant(db.sql, "Keep");
    const created = await run(M, floor, floorCsv(""));
    for (const e of ["brands", "categories", "modifier_groups", "menus", "menu_sections", "areas", "tables", "tender_types", "void_reasons"]) expect(created[e], e).toMatchObject({ rejected: [] });
    const id = (table: string, lid: string) => idOf(table, M.merchantId, lid);
    const [brand, outlet, c1, c2, group, s1, s2, area, table, card, reason] = await Promise.all([id("brands", "B1"), id("outlets", "O1"), id("report_categories", "C1"), id("report_categories", "C2"), id("modifier_groups", "G1"), id("menu_sections", "S1"), id("menu_sections", "S2"), id("areas", "A1"), id("tables", "T1"), id("tender_types", "CARD"), id("void_reasons", "R1")]);

    // Set in the app afterwards.
    await must(M, "PATCH", `/v1/brands/${brand}`, { accent_color: "#336699" });
    await must(M, "PATCH", `/v1/outlets/${outlet}`, { address: "1 Quay Road", phone: "+6561234567", business_registration_no: "201912345K", tax_registration_no: "M90312345X", business_day_cutoff: "05:00" });
    await must(M, "PATCH", `/v1/categories/${c2}`, { parent_id: c1, sort: 5 });
    // A group that asks for a choice needs options first, so these are set as the menu editor would store them.
    await db.sql`update modifier_groups set min_select = 1, max_select = 3, max_per_modifier = 2 where id = ${group}`;
    await db.sql`update menu_sections set parent_id = ${s1}, sort = 9 where id = ${s2}`;
    await must(M, "PATCH", `/v1/areas/${area}`, { sort: 7 });
    await must(M, "PATCH", `/v1/tables/${table}`, { seats: 6, shape: "round", x: 12, y: 8, w: 3, h: 4 });
    await must(M, "PATCH", `/v1/tender-types/${card}`, { is_terminal: true, provider: "simulator", terminal_id: "term-keep", requires_approval: false, opens_drawer: false, sort: 3 });
    await must(M, "PATCH", `/v1/void-reasons/${reason}`, { for_refunds: false, sort: 4 });
    const before = {
      brand: await rowOf("brands", brand, "accent_color"),
      outlet: await rowOf("outlets", outlet, "address, phone, business_registration_no, tax_registration_no, business_day_cutoff"),
      c2: await rowOf("report_categories", c2, "parent_id, sort"),
      group: await rowOf("modifier_groups", group, "min_select, max_select, max_per_modifier"),
      s2: await rowOf("menu_sections", s2, "parent_id, sort"),
      area: await rowOf("areas", area, "sort"),
      table: await rowOf("tables", table, "seats, shape, x, y, w, h"),
      card: await rowOf("tender_types", card, "is_cash, opens_drawer, is_terminal, requires_approval, provider, terminal_id, sort"),
      reason: await rowOf("void_reasons", reason, "for_refunds, sort"),
    };
    expect(before.card).toMatchObject({ is_terminal: true, requires_approval: false, provider: "simulator" });

    // The export comes back with one field changed on each row: the name.
    const updated = await run(M, floor, floorCsv(" (new)"));
    for (const e of ["brands", "categories", "modifier_groups", "menus", "menu_sections", "areas", "tables", "void_reasons"]) expect(updated[e], e).toMatchObject({ creates: 0, updates: 1, rejected: [] });
    expect(updated.outlets).toMatchObject({ creates: 0, updates: 1, unchanged: 1, rejected: [] });
    expect(updated.tender_types).toMatchObject({ creates: 0, updates: 1, unchanged: 1, rejected: [] });
    expect((await rowOf("tables", table, "name")).name).toBe("Table 1 (new)");
    expect({
      brand: await rowOf("brands", brand, "accent_color"),
      outlet: await rowOf("outlets", outlet, "address, phone, business_registration_no, tax_registration_no, business_day_cutoff"),
      c2: await rowOf("report_categories", c2, "parent_id, sort"),
      group: await rowOf("modifier_groups", group, "min_select, max_select, max_per_modifier"),
      s2: await rowOf("menu_sections", s2, "parent_id, sort"),
      area: await rowOf("areas", area, "sort"),
      table: await rowOf("tables", table, "seats, shape, x, y, w, h"),
      card: await rowOf("tender_types", card, "is_cash, opens_drawer, is_terminal, requires_approval, provider, terminal_id, sort"),
      reason: await rowOf("void_reasons", reason, "for_refunds, sort"),
    }).toEqual(before);

    // The same file again changes nothing.
    const again = await run(M, floor, floorCsv(" (new)"));
    for (const [e, counts] of Object.entries(again)) expect(counts.updates + counts.creates, e).toBe(0);
  });

  it("a blank cell in a column the file has clears the field or sets its default; a filled one writes it", async () => {
    const M = await seedMerchant(db.sql, "Blank");
    const files: FileMap[] = [
      { name: "outlets.csv", entity: "outlets", columns: { legacy_id: "ID", name: "Name", address: "Address", phone: "Phone" } },
      { name: "groups.csv", entity: "modifier_groups", columns: { legacy_id: "ID", name: "Name", min_select: "Min", max_select: "Max" } },
      { name: "tables.csv", entity: "tables", columns: { legacy_id: "ID", name: "Name", area_legacy_id: "Area", seats: "Seats", x: "X" } },
      { name: "areas.csv", entity: "areas", columns: { legacy_id: "ID", name: "Name", outlet_legacy_id: "Outlet", sort: "Sort" } },
      { name: "reasons.csv", entity: "void_reasons", columns: { legacy_id: "ID", name: "Name", for_refunds: "Refunds", sort: "Sort" } },
    ];
    await run(M, files, {
      "outlets.csv": "ID,Name,Address,Phone\nO1,Quay,1 Quay Road,+6561234567\n",
      "groups.csv": "ID,Name,Min,Max\nG1,Sauce,1,2\n",
      "areas.csv": "ID,Name,Outlet,Sort\nA1,Terrace,O1,3\n",
      "tables.csv": "ID,Name,Area,Seats,X\nT1,Table 1,A1,6,10\n",
      "reasons.csv": "ID,Name,Refunds,Sort\nR1,Wrong item,N,5\n",
    });
    const updated = await run(M, files, {
      "outlets.csv": "ID,Name,Address,Phone\nO1,Quay,,+6569999999\n",
      "groups.csv": "ID,Name,Min,Max\nG1,Sauce,,4\n",
      "areas.csv": "ID,Name,Outlet,Sort\nA1,Terrace,O1,\n",
      "tables.csv": "ID,Name,Area,Seats,X\nT1,Table 1,A1,,11\n",
      "reasons.csv": "ID,Name,Refunds,Sort\nR1,Wrong item (new),,\n",
    });
    expect(updated.areas).toMatchObject({ updates: 1, unchanged: 0 });
    expect(await rowOf("outlets", await idOf("outlets", M.merchantId, "O1"), "address, phone")).toEqual({ address: null, phone: "+6569999999" });
    expect(await rowOf("modifier_groups", await idOf("modifier_groups", M.merchantId, "G1"), "min_select, max_select")).toEqual({ min_select: 0, max_select: 4 });
    expect(await rowOf("areas", await idOf("areas", M.merchantId, "A1"), "sort")).toEqual({ sort: 0 });
    expect(await rowOf("tables", await idOf("tables", M.merchantId, "T1"), "seats, x")).toEqual({ seats: 4, x: 11 });
    expect(await rowOf("void_reasons", await idOf("void_reasons", M.merchantId, "R1"), "name, for_refunds, sort")).toEqual({ name: "Wrong item (new)", for_refunds: true, sort: 0 });
  });

  it("a new row still takes the defaults", async () => {
    const M = await seedMerchant(db.sql, "Defaults");
    await run(M, floor, floorCsv(""));
    expect(await rowOf("tables", await idOf("tables", M.merchantId, "T1"), "seats, shape, x, y, w, h")).toEqual({ seats: 4, shape: "rect", x: 0, y: 0, w: 2, h: 2 });
    expect(await rowOf("tender_types", await idOf("tender_types", M.merchantId, "CARD"), "is_cash, opens_drawer, is_terminal, requires_approval, sort")).toEqual({ is_cash: false, opens_drawer: false, is_terminal: false, requires_approval: true, sort: 0 });
    expect(await rowOf("tender_types", await idOf("tender_types", M.merchantId, "CASH"), "is_cash, opens_drawer, requires_approval, sort")).toEqual({ is_cash: true, opens_drawer: true, requires_approval: false, sort: 1 });
    expect(await rowOf("void_reasons", await idOf("void_reasons", M.merchantId, "R1"), "for_refunds, sort")).toEqual({ for_refunds: true, sort: 0 });
  });

  it("products and customers keep unmapped fields; a blank tax class is still the default class", async () => {
    const M = await seedMerchant(db.sql, "Products");
    const products: FileMap = { name: "items.csv", entity: "products", columns: { sku: "SKU", name: "Name", price: "Price" } };
    const customers: FileMap = { name: "customers.csv", entity: "customers", columns: { name: "Name", mobile: "Mobile" } };
    await run(M, [products, customers], { "items.csv": "SKU,Name,Price\nP1,Soup,5.00\n", "customers.csv": "Name,Mobile\nAda,+6591234567\n" });
    const [p] = await db.sql<{ id: string }[]>`select id from products where merchant_id = ${M.merchantId} and sku = 'P1'`;
    const [cat] = await db.sql<{ id: string }[]>`insert into report_categories (merchant_id, name) values (${M.merchantId}, 'Soups') returning id`;
    await must(M, "PATCH", `/v1/products/${p!.id}`, { description: "Clear broth", kitchen_name: "SOUP", tags: ["hot"], has_deposit: true, open_price: true, category_id: cat!.id, tax_class_id: M.taxClassIds.standard });
    const [c] = await db.sql<{ id: string }[]>`select id from customers where merchant_id = ${M.merchantId}`;
    await db.sql`update customers set email = 'ada@example.test', marketing_consent = true where id = ${c!.id}`;
    const cols = "name, price, description, kitchen_name, tags, has_deposit, open_price, category_id, tax_class_id, sku";

    const updated = await run(M, [products, customers], { "items.csv": "SKU,Name,Price\nP1,Soup,5.50\n", "customers.csv": "Name,Mobile\nAda L,+6591234567\n" });
    expect(updated.products).toMatchObject({ updates: 1 });
    expect(await rowOf("products", p!.id, cols)).toEqual({ name: "Soup", price: 550, description: "Clear broth", kitchen_name: "SOUP", tags: ["hot"], has_deposit: true, open_price: true, category_id: cat!.id, tax_class_id: M.taxClassIds.standard, sku: "P1" });
    expect(await rowOf("customers", c!.id, "name, email, marketing_consent")).toEqual({ name: "Ada L", email: "ada@example.test", marketing_consent: true });

    // A blank tax class in a mapped column is the merchant's default class, as the mapping says.
    await run(M, [{ ...products, columns: { ...products.columns, tax_class: "Tax" } }], { "items.csv": "SKU,Name,Price,Tax\nP1,Soup,5.50,\n" });
    expect((await rowOf("products", p!.id, "tax_class_id")).tax_class_id).toBeNull();
  });

  it("a blank cell clears a product's description, tags, category, flags and archived mark", async () => {
    const M = await seedMerchant(db.sql, "Clear");
    const full: FileMap = { name: "items.csv", entity: "products", columns: { sku: "SKU", name: "Name", price: "Price", description: "Desc", tags: "Tags", category_legacy_id: "Cat", has_deposit: "Dep", kitchen_name: "Kitchen", archived: "Archived" } };
    const cats: FileMap = { name: "cats.csv", entity: "categories", columns: { legacy_id: "ID", name: "Name" } };
    await run(M, [cats, full], { "cats.csv": "ID,Name\nC1,Soups\n", "items.csv": "SKU,Name,Price,Desc,Tags,Cat,Dep,Kitchen,Archived\nP1,Soup,5.00,Clear broth,hot;veg,C1,Y,SOUP,Y\n" });
    const [p] = await db.sql<{ id: string }[]>`select id from products where merchant_id = ${M.merchantId} and sku = 'P1'`;
    expect(await rowOf("products", p!.id, "description, tags, has_deposit, kitchen_name, archived_at is not null as archived")).toEqual({ description: "Clear broth", tags: ["hot", "veg"], has_deposit: true, kitchen_name: "SOUP", archived: true });
    const cleared = await run(M, [full], { "items.csv": "SKU,Name,Price,Desc,Tags,Cat,Dep,Kitchen,Archived\nP1,Soup,5.00,,,,,,\n" });
    expect(cleared.products).toMatchObject({ updates: 1, rejected: [] });
    expect(await rowOf("products", p!.id, "description, tags, category_id, has_deposit, kitchen_name, archived_at")).toEqual({ description: null, tags: [], category_id: null, has_deposit: false, kitchen_name: null, archived_at: null });
  });

  it("a blank marketing consent on a customer update withdraws consent; a file without the column keeps it", async () => {
    const M = await seedMerchant(db.sql, "Consent");
    const withConsent: FileMap = { name: "customers.csv", entity: "customers", columns: { name: "Name", mobile: "Mobile", email: "Email", marketing_consent: "Consent" } };
    await run(M, [withConsent], { "customers.csv": "Name,Mobile,Email,Consent\nAda,+6591234567,ada@example.test,Y\n" });
    const [c] = await db.sql<{ id: string }[]>`select id from customers where merchant_id = ${M.merchantId}`;
    expect(await rowOf("customers", c!.id, "email, marketing_consent")).toEqual({ email: "ada@example.test", marketing_consent: true });
    // Without the columns: kept.
    await run(M, [{ ...withConsent, columns: { name: "Name", mobile: "Mobile" } }], { "customers.csv": "Name,Mobile\nAda,+6591234567\n" });
    expect(await rowOf("customers", c!.id, "email, marketing_consent")).toEqual({ email: "ada@example.test", marketing_consent: true });
    // With the columns and blank cells: consent withdrawn and email cleared.
    const withdrawn = await run(M, [withConsent], { "customers.csv": "Name,Mobile,Email,Consent\nAda,+6591234567,,\n" });
    expect(withdrawn.customers).toMatchObject({ updates: 1, rejected: [] });
    expect(await rowOf("customers", c!.id, "email, marketing_consent")).toEqual({ email: null, marketing_consent: false });
  });

  it("modifier options and menu items keep their order and child group when the file has no such column", async () => {
    const M = await seedMerchant(db.sql, "Order");
    const items: FileMap = { name: "items.csv", entity: "products", columns: { sku: "SKU", name: "Name", price: "Price" } };
    const groups: FileMap = { name: "groups.csv", entity: "modifier_groups", columns: { legacy_id: "ID", name: "Name" } };
    const options: FileMap = { name: "options.csv", entity: "modifier_options", columns: { group_legacy_id: "Group", product_sku: "SKU", sort: "Sort", child_group_legacy_id: "Child" } };
    const brands: FileMap = { name: "brands.csv", entity: "brands", columns: { legacy_id: "ID", name: "Name" } };
    const menus: FileMap = { name: "menus.csv", entity: "menus", columns: { legacy_id: "ID", name: "Name", brand_legacy_id: "Brand" } };
    const sections: FileMap = { name: "sections.csv", entity: "menu_sections", columns: { legacy_id: "ID", name: "Name", menu_legacy_id: "Menu" } };
    const menuItems: FileMap = { name: "menu_items.csv", entity: "menu_items", columns: { section_legacy_id: "Section", product_sku: "SKU", sort: "Sort" } };
    const base = { "items.csv": "SKU,Name,Price\nP1,Soup,5.00\nX1,Chilli,0.50\n", "groups.csv": "ID,Name\nG1,Sauce\nG2,Heat\n", "brands.csv": "ID,Name\nB1,Harbour\n", "menus.csv": "ID,Name,Brand\nM1,All day,B1\n", "sections.csv": "ID,Name,Menu\nS1,Mains,M1\n" };
    const all = [items, groups, options, brands, menus, sections, menuItems];
    await run(M, all, { ...base, "options.csv": "Group,SKU,Sort,Child\nG1,X1,5,G2\n", "menu_items.csv": "Section,SKU,Sort\nS1,P1,7\n" });
    const opt = async () => (await db.sql<{ sort: number; child: string | null }[]>`select o.sort, g.legacy_id as child from modifier_options o left join modifier_groups g on g.id = o.child_group_id where o.merchant_id = ${M.merchantId}`)[0];
    const item = async () => (await db.sql<{ sort: number }[]>`select sort from menu_items where merchant_id = ${M.merchantId}`)[0];
    expect({ opt: await opt(), item: await item() }).toEqual({ opt: { sort: 5, child: "G2" }, item: { sort: 7 } });

    // Without the sort and child columns: kept, and nothing counts as changed.
    const bare = await run(M, [items, groups, { ...options, columns: { group_legacy_id: "Group", product_sku: "SKU" } }, brands, menus, sections, { ...menuItems, columns: { section_legacy_id: "Section", product_sku: "SKU" } }], { ...base, "options.csv": "Group,SKU\nG1,X1\n", "menu_items.csv": "Section,SKU\nS1,P1\n" });
    expect({ options: bare.modifier_options, items: bare.menu_items }).toMatchObject({ options: { updates: 0, unchanged: 1 }, items: { updates: 0, unchanged: 1 } });
    expect({ opt: await opt(), item: await item() }).toEqual({ opt: { sort: 5, child: "G2" }, item: { sort: 7 } });

    // With the columns and blank cells: the defaults (sort 0, no child group; a menu item's row order).
    await run(M, all, { ...base, "options.csv": "Group,SKU,Sort,Child\nG1,X1,,\n", "menu_items.csv": "Section,SKU,Sort\nS1,P1,\n" });
    expect({ opt: await opt(), item: await item() }).toEqual({ opt: { sort: 0, child: null }, item: { sort: 0 } });
  });

  it("a product matched on its Sail id with a new legacy id and nothing else changed updates the legacy id alone", async () => {
    const M = await seedMerchant(db.sql, "Legacy");
    const products: FileMap = { name: "items.csv", entity: "products", columns: { sail_id: "Sail", legacy_id: "Legacy", name: "Name", price: "Price" } };
    const p = await must(M, "POST", "/v1/products", { name: "Soup", price: 500, description: "Clear broth" });
    const updated = await run(M, [products], { "items.csv": `Sail,Legacy,Name,Price\n${p.id},OLD-7,Soup,5.00\n` });
    expect(updated.products).toMatchObject({ creates: 0, updates: 1, unchanged: 0 });
    expect(await rowOf("products", p.id, "legacy_id, name, price, description")).toEqual({ legacy_id: "OLD-7", name: "Soup", price: 500, description: "Clear broth" });
    const again = await run(M, [products], { "items.csv": `Sail,Legacy,Name,Price\n${p.id},OLD-7,Soup,5.00\n` });
    expect(again.products).toMatchObject({ creates: 0, updates: 0, unchanged: 1 });
  });
});

describe("staff re-imports", () => {
  const staffFile: FileMap = { name: "staff.csv", entity: "staff", columns: { legacy_id: "ID", name: "Name", role: "Role" } };

  it("outlets, active, email and custom initials are kept when the file has no such column; blank cells set the defaults", async () => {
    const M = await seedMerchant(db.sql, "Crew");
    await run(M, [staffFile], { "staff.csv": "ID,Name,Role\nE1,Sam Lee,server\n" });
    const id = await idOf("staff", M.merchantId, "E1");
    await must(M, "PATCH", `/v1/staff/${id}`, { outlet_ids: [M.outletId], initials: "SX", email: "sam@example.test", active: false });

    const updated = await run(M, [staffFile], { "staff.csv": "ID,Name,Role\nE1,Sam Leigh,server\n" });
    expect(updated.staff).toMatchObject({ updates: 1, rejected: [] });
    expect(await rowOf("staff", id, "name, outlet_ids, initials, email, active")).toEqual({ name: "Sam Leigh", outlet_ids: [M.outletId], initials: "SX", email: "sam@example.test", active: false });

    // With the columns and blank cells: every outlet, no email, active, as on create. Initials stay the Team page's.
    const withCols: FileMap = { ...staffFile, columns: { ...staffFile.columns, outlet_legacy_ids: "Outlets", email: "Email", active: "Active" } };
    await run(M, [withCols], { "staff.csv": "ID,Name,Role,Outlets,Email,Active\nE1,Sam Leigh,server,,,\n" });
    expect(await rowOf("staff", id, "outlet_ids, email, active, initials")).toEqual({ outlet_ids: [], email: null, active: true, initials: "SX" });
  });

  it("an Admin cannot lower their own role by import, and an import cannot leave the business without an active Admin", async () => {
    const M = await seedMerchant(db.sql, "Guards");
    await must(M, "PATCH", `/v1/staff/${M.admin.id}`, { legacy_id: "BOSS" });
    const withActive: FileMap = { ...staffFile, columns: { ...staffFile.columns, active: "Active" } };
    const demote = await run(M, [withActive], { "staff.csv": "ID,Name,Role,Active\nBOSS,Guards Admin,manager,Y\n" });
    expect(demote.staff!.rejected.map((r) => r.reason)).toEqual(["You cannot lower your own role: ask another Admin to change it"]);
    const off = await run(M, [withActive], { "staff.csv": "ID,Name,Role,Active\nBOSS,Guards Admin,admin,N\n" });
    expect(off.staff!.rejected.map((r) => r.reason)).toEqual(["This would leave the business with no active Admin"]);
    expect(await rowOf("staff", M.admin.id, "role, active")).toEqual({ role: "admin", active: true });
  });

  it("a row refused after its write is not counted as updated or listed in the audit entry", async () => {
    const M = await seedMerchant(db.sql, "Late");
    await must(M, "PATCH", `/v1/staff/${M.admin.id}`, { legacy_id: "BOSS" });
    await must(M, "PATCH", `/v1/staff/${M.manager.id}`, { legacy_id: "MGR" });
    const withActive: FileMap = { ...staffFile, columns: { ...staffFile.columns, active: "Active" } };
    // BOSS is written, then refused by the last-Admin check; MGR is a real update.
    const r = await run(M, [withActive], { "staff.csv": "ID,Name,Role,Active\nBOSS,Late Admin,admin,N\nMGR,Mia Manager (new),manager,Y\n" });
    expect(r.staff).toMatchObject({ creates: 0, updates: 1, unchanged: 0 });
    expect(r.staff!.rejected.map((x) => x.reason)).toEqual(["This would leave the business with no active Admin"]);
    const [entry] = await db.sql<{ details: { entities: { staff: { updates: number; updated_ids: string[] } } } }[]>`select details from audit_log where merchant_id = ${M.merchantId} and action = 'imports.applied'`;
    expect(entry!.details.entities.staff).toMatchObject({ updates: 1, updated_ids: [M.manager.id] });
  });

  it("a dry run gives the same answer whether or not a PIN is someone's current PIN", async () => {
    const M = await seedMerchant(db.sql, "Oracle");
    const withPin: FileMap = { ...staffFile, columns: { ...staffFile.columns, pin: "PIN" } };
    await run(M, [withPin], { "staff.csv": "ID,Name,Role,PIN\nE1,Sam Lee,server,246810\nE2,Kim Tan,server,135791\n" });
    const answer = async (pin: string) => {
      const r = await run(M, [withPin], { "staff.csv": `ID,Name,Role,PIN\nE1,Sam Lee,server,${pin}\n` }, true);
      return { ...r.staff, rejected: r.staff!.rejected.map((x) => x.reason) };
    };
    const own = await answer("246810");
    const colleagues = await answer("135791");
    const nobodys = await answer("975310");
    expect(own).toEqual(nobodys);
    expect(colleagues).toEqual(nobodys);
    expect(nobodys).toMatchObject({ updates: 1, rejected: [] });
    // A new person with a colleague's PIN: the same as with a free one.
    const fresh = async (pin: string) => (await run(M, [withPin], { "staff.csv": `ID,Name,Role,PIN\nE3,Lee Ng,server,${pin}\n` }, true)).staff;
    expect(await fresh("135791")).toEqual(await fresh("975310"));
    // The applied import still refuses a PIN someone else uses.
    const applied = await run(M, [withPin], { "staff.csv": "ID,Name,Role,PIN\nE1,Sam Lee,server,135791\n" });
    expect(applied.staff!.rejected.map((x) => x.reason)).toEqual(["Someone at this business already uses that PIN"]);
  });

  it("deactivating someone ends their back-office sessions and sign-in links, as the Team page does", async () => {
    const M = await seedMerchant(db.sql, "Leaver");
    await must(M, "PATCH", `/v1/staff/${M.manager.id}`, { legacy_id: "MGR" });
    await db.sql`insert into backoffice_sessions (merchant_id, staff_id, expires_at) values (${M.merchantId}, ${M.manager.id}, now() + interval '1 day')`;
    await db.sql`insert into backoffice_links (merchant_id, staff_id, kind, token_hash, created_by, expires_at) values (${M.merchantId}, ${M.manager.id}, 'invite', ${"leaver-" + M.merchantId}, ${M.admin.id}, now() + interval '1 day')`;
    await run(M, [{ ...staffFile, columns: { ...staffFile.columns, active: "Active" } }], { "staff.csv": "ID,Name,Role,Active\nMGR,Mia Manager,manager,N\n" });
    expect((await rowOf("staff", M.manager.id, "active")).active).toBe(false);
    const [open] = await db.sql<{ n: number }[]>`select count(*)::int as n from backoffice_sessions where staff_id = ${M.manager.id} and ended_at is null`;
    const [links] = await db.sql<{ n: number }[]>`select count(*)::int as n from backoffice_links where staff_id = ${M.manager.id} and revoked_at is null`;
    expect({ open: open!.n, links: links!.n }).toEqual({ open: 0, links: 0 });
  });

  it("a new PIN clears the failed attempts and lock; the same PIN again is unchanged", async () => {
    const M = await seedMerchant(db.sql, "Pins");
    const withPin: FileMap = { ...staffFile, columns: { ...staffFile.columns, pin: "PIN" } };
    await run(M, [withPin], { "staff.csv": "ID,Name,Role,PIN\nE1,Sam Lee,server,246810\n" });
    const id = await idOf("staff", M.merchantId, "E1");
    await db.sql`update staff set pin_failed_attempts = 5, pin_locked_until = now() + interval '1 hour' where id = ${id}`;
    const same = await run(M, [withPin], { "staff.csv": "ID,Name,Role,PIN\nE1,Sam Lee,server,246810\n" });
    expect(same.staff).toMatchObject({ updates: 0, unchanged: 1 });
    await run(M, [withPin], { "staff.csv": "ID,Name,Role,PIN\nE1,Sam Lee,server,135791\n" });
    expect(await rowOf("staff", id, "pin_failed_attempts, pin_locked_until")).toEqual({ pin_failed_attempts: 0, pin_locked_until: null });
  });
});

describe("moves and cycles an import refuses", () => {
  it("an area does not move outlet, a section does not move menu and a menu does not change brand", async () => {
    const M = await seedMerchant(db.sql, "Moves");
    await run(M, floor, floorCsv(""));
    const moved = await run(M, floor, { ...floorCsv(""), "areas.csv": "ID,Name,Outlet\nA1,Terrace,O2\n", "sections.csv": "ID,Name,Menu\nS1,Mains,M1\nS2,Soups,M2\n", "brands.csv": "ID,Name\nB1,Harbour\nB2,Second brand\n", "menus.csv": "ID,Name,Brand\nM1,All day,B1\nM2,Late,B2\n" });
    expect(moved.areas!.rejected.map((r) => r.reason)).toEqual(["an area's outlet cannot be changed by an import"]);
    expect(moved.menu_sections!.rejected.map((r) => r.reason)).toEqual(["a section's menu cannot be changed by an import"]);
    expect(moved.menus!.rejected.map((r) => r.reason)).toEqual(["a menu's brand cannot be changed by an import"]);
    expect((await rowOf("areas", await idOf("areas", M.merchantId, "A1"), "outlet_id")).outlet_id).toBe(await idOf("outlets", M.merchantId, "O1"));
  });

  it("a table does not move to another outlet through its area, but moves between areas of its outlet", async () => {
    const M = await seedMerchant(db.sql, "TableMove");
    const csv = (areas: string, tables: string) => ({ ...floorCsv(""), "areas.csv": `ID,Name,Outlet\n${areas}`, "tables.csv": `ID,Name,Area\n${tables}` });
    await run(M, floor, csv("A1,Terrace,O1\nA2,Bar,O1\nA3,Pier deck,O2\n", "T1,Table 1,A1\n"));
    const table = await idOf("tables", M.merchantId, "T1");
    const moved = await run(M, floor, csv("A1,Terrace,O1\nA2,Bar,O1\nA3,Pier deck,O2\n", "T1,Table 1,A3\n"));
    expect(moved.tables!.rejected.map((r) => r.reason)).toEqual(["a table's outlet cannot be changed by an import"]);
    expect(await rowOf("tables", table, "outlet_id, area_id")).toEqual({ outlet_id: await idOf("outlets", M.merchantId, "O1"), area_id: await idOf("areas", M.merchantId, "A1") });
    const within = await run(M, floor, csv("A1,Terrace,O1\nA2,Bar,O1\nA3,Pier deck,O2\n", "T1,Table 1,A2\n"));
    expect(within.tables).toMatchObject({ updates: 1, rejected: [] });
    expect((await rowOf("tables", table, "area_id")).area_id).toBe(await idOf("areas", M.merchantId, "A2"));
  });

  it("a category or section under itself, or two under each other, is refused", async () => {
    const M = await seedMerchant(db.sql, "Cycles");
    const files: FileMap[] = [
      { name: "brands.csv", entity: "brands", columns: { legacy_id: "ID", name: "Name" } },
      { name: "categories.csv", entity: "categories", columns: { legacy_id: "ID", name: "Name", parent_legacy_id: "Parent" } },
      { name: "menus.csv", entity: "menus", columns: { legacy_id: "ID", name: "Name", brand_legacy_id: "Brand" } },
      { name: "sections.csv", entity: "menu_sections", columns: { legacy_id: "ID", name: "Name", menu_legacy_id: "Menu", parent_legacy_id: "Parent" } },
    ];
    const csv = (cats: string, secs: string) => ({ "brands.csv": "ID,Name\nB1,Harbour\n", "categories.csv": `ID,Name,Parent\n${cats}`, "menus.csv": "ID,Name,Brand\nM1,All day,B1\n", "sections.csv": `ID,Name,Menu,Parent\n${secs}` });
    await run(M, files, csv("A,Alpha,\nB,Beta,\n", "S1,One,M1,\nS2,Two,M1,\n"));
    const self = await run(M, files, csv("A,Alpha,A\nB,Beta,\n", "S1,One,M1,S1\nS2,Two,M1,\n"));
    // Categories: the database's own refusal (0052) in its words. Sections: the importer's, the same rule.
    expect(self.categories!.rejected.map((r) => r.reason)).toEqual(["A category cannot sit under itself"]);
    expect(self.menu_sections!.rejected.map((r) => r.reason)).toEqual(["A section cannot sit under itself"]);
    const loop = await run(M, files, csv("A,Alpha,B\nB,Beta,A\n", "S1,One,M1,S2\nS2,Two,M1,S1\n"));
    expect(loop.categories!.rejected.map((r) => r.reason)).toEqual(["A category can only sit under a top-level category"]);
    expect(loop.menu_sections!.rejected.map((r) => r.reason)).toEqual(["A section can only sit under a top-level section"]);
    const parents = await db.sql<{ legacy_id: string; parent_id: string | null }[]>`select legacy_id, parent_id from report_categories where merchant_id = ${M.merchantId} and legacy_id in ('A', 'B') order by legacy_id`;
    // A goes under B (the first row is fine); B under A would close the loop and is refused.
    expect(parents.map((r) => [r.legacy_id, r.parent_id != null])).toEqual([
      ["A", true],
      ["B", false],
    ]);
    const sections = await db.sql<{ legacy_id: string; parent_id: string | null }[]>`select legacy_id, parent_id from menu_sections where merchant_id = ${M.merchantId} order by legacy_id`;
    expect(sections.map((r) => [r.legacy_id, r.parent_id != null])).toEqual([
      ["S1", true],
      ["S2", false],
    ]);
  });
});

describe("what an import records", () => {
  it("an applied import writes one audit entry with its counts and the ids it updated, and a floor event per changed table", async () => {
    const M = await seedMerchant(db.sql, "Audit");
    const dry = await run(M, floor, floorCsv(""), true);
    expect(dry.tables!.creates).toBe(1);
    const [none] = await db.sql<{ n: number }[]>`select count(*)::int as n from audit_log where merchant_id = ${M.merchantId} and action = 'imports.applied'`;
    expect(none!.n).toBe(0);
    await run(M, floor, floorCsv(""));
    const id = await queue(M, floor, floorCsv(" (new)"));
    await runQueuedImports();
    const entries = await db.sql<{ actor_id: string; target_id: string; details: { entities: Record<string, { creates: number; updates: number; updated_ids: string[] }> } }[]>`select actor_id, target_id, details from audit_log where merchant_id = ${M.merchantId} and action = 'imports.applied' order by occurred_at`;
    expect(entries).toHaveLength(2);
    const last = entries[1]!;
    expect(last).toMatchObject({ actor_id: M.admin.id, target_id: id });
    expect(last.details.entities.tables).toMatchObject({ creates: 0, updates: 1, updated_ids: [await idOf("tables", M.merchantId, "T1")] });
    expect(last.details.entities.outlets!.updated_ids).toEqual([await idOf("outlets", M.merchantId, "O1")]);
    const outlet = await idOf("outlets", M.merchantId, "O1");
    const events = await db.sql<{ type: string; aggregate_id: string }[]>`select type, aggregate_id from events where merchant_id = ${M.merchantId} and outlet_id = ${outlet} and operation_id = 'imports.apply' order by seq`;
    expect(events.map((e) => e.type)).toEqual(["area.created", "table.created", "area.updated", "table.updated"]);
  });

  it("the audit entry lists at most 100 updated ids per entity, with the total", async () => {
    const M = await seedMerchant(db.sql, "AuditCap");
    const reasons: FileMap = { name: "reasons.csv", entity: "void_reasons", columns: { legacy_id: "ID", name: "Name" } };
    const csv = (suffix: string) => ({ "reasons.csv": `ID,Name\n${Array.from({ length: 101 }, (_, i) => `R${i},Reason ${i}${suffix}`).join("\n")}\n` });
    await run(M, [reasons], csv(""));
    expect((await run(M, [reasons], csv(" (new)"))).void_reasons).toMatchObject({ updates: 101 });
    const [entry] = await db.sql<{ details: { entities: { void_reasons: { updates: number; updated_ids: string[]; updated_ids_total: number } } } }[]>`select details from audit_log where merchant_id = ${M.merchantId} and action = 'imports.applied' order by occurred_at desc limit 1`;
    const v = entry!.details.entities.void_reasons;
    expect({ listed: v.updated_ids.length, total: v.updated_ids_total, updates: v.updates }).toEqual({ listed: 100, total: 101, updates: 101 });
  });
});

describe("tender re-imports", () => {
  const tenders = (columns: Record<string, string>): FileMap[] => [{ name: "tenders.csv", entity: "tender_types", columns: { legacy_id: "ID", name: "Name", ...columns } }];
  const tender = async (m: SeededMerchant, lid: string) => rowOf("tender_types", await idOf("tender_types", m.merchantId, lid), "is_cash, is_terminal, opens_drawer, requires_approval");

  it("a tender the file turns into a house account needs approval; one already a house account keeps what Settings set", async () => {
    const M = await seedMerchant(db.sql, "House");
    await run(M, tenders({ is_cash: "Cash", is_terminal: "Terminal" }), { "tenders.csv": "ID,Name,Cash,Terminal\nCARD,Card,N,Y\nTAB,Tab,N,N\n" });
    expect(await tender(M, "CARD")).toMatchObject({ requires_approval: false });
    expect(await tender(M, "TAB")).toMatchObject({ requires_approval: true });
    await db.sql`update tender_types set requires_approval = false where merchant_id = ${M.merchantId} and legacy_id = 'TAB'`;
    await run(M, tenders({ is_terminal: "Terminal" }), { "tenders.csv": "ID,Name,Terminal\nCARD,Card,N\nTAB,Tab,N\n" });
    expect(await tender(M, "CARD")).toMatchObject({ is_terminal: false, requires_approval: true });
    expect(await tender(M, "TAB")).toMatchObject({ requires_approval: false });
    // Without the cash and terminal columns, approval is left as stored.
    await db.sql`update tender_types set requires_approval = false where merchant_id = ${M.merchantId} and legacy_id = 'CARD'`;
    await run(M, tenders({}), { "tenders.csv": "ID,Name\nCARD,Card\n" });
    expect(await tender(M, "CARD")).toMatchObject({ requires_approval: false });
  });

  it("a file that marks a tender as cash opens its drawer unless the file has a drawer column", async () => {
    const M = await seedMerchant(db.sql, "Drawer");
    await run(M, tenders({ is_cash: "Cash", opens_drawer: "Drawer" }), { "tenders.csv": "ID,Name,Cash,Drawer\nT1,Till,N,N\nT2,Float,N,N\n" });
    await run(M, tenders({ is_cash: "Cash" }), { "tenders.csv": "ID,Name,Cash\nT1,Till,Y\nT2,Float,N\n" });
    expect(await tender(M, "T1")).toMatchObject({ is_cash: true, opens_drawer: true });
    expect(await tender(M, "T2")).toMatchObject({ is_cash: false, opens_drawer: false });
    // With the drawer column, it decides as on main: a cash tender always opens it.
    await run(M, tenders({ is_cash: "Cash", opens_drawer: "Drawer" }), { "tenders.csv": "ID,Name,Cash,Drawer\nT1,Till,Y,N\nT2,Float,N,Y\n" });
    expect(await tender(M, "T1")).toMatchObject({ opens_drawer: true });
    expect(await tender(M, "T2")).toMatchObject({ opens_drawer: true });
    await run(M, tenders({ is_cash: "Cash", opens_drawer: "Drawer" }), { "tenders.csv": "ID,Name,Cash,Drawer\nT2,Float,N,N\n" });
    expect(await tender(M, "T2")).toMatchObject({ opens_drawer: false });
  });
});

describe("the audit entry of a re-import", () => {
  it("lists the modifier options, menu items and layouts it updated", async () => {
    const M = await seedMerchant(db.sql, "AuditIds");
    const files: FileMap[] = [
      { name: "items.csv", entity: "products", columns: { sku: "SKU", name: "Name", price: "Price" } },
      { name: "groups.csv", entity: "modifier_groups", columns: { legacy_id: "ID", name: "Name" } },
      { name: "options.csv", entity: "modifier_options", columns: { group_legacy_id: "Group", product_sku: "SKU", sort: "Sort" } },
      { name: "brands.csv", entity: "brands", columns: { legacy_id: "ID", name: "Name" } },
      { name: "menus.csv", entity: "menus", columns: { legacy_id: "ID", name: "Name", brand_legacy_id: "Brand" } },
      { name: "sections.csv", entity: "menu_sections", columns: { legacy_id: "ID", name: "Name", menu_legacy_id: "Menu" } },
      { name: "menu_items.csv", entity: "menu_items", columns: { section_legacy_id: "Section", product_sku: "SKU", sort: "Sort" } },
      { name: "layout.csv", entity: "layouts", columns: { layout_legacy_id: "Layout", brand_legacy_id: "Brand", label: "Label", product_sku: "SKU" } },
    ];
    const csv = (sort: number, label: string) => ({ "items.csv": "SKU,Name,Price\nP1,Soup,5.00\nX1,Chilli,0.50\n", "groups.csv": "ID,Name\nG1,Sauce\n", "options.csv": `Group,SKU,Sort\nG1,X1,${sort}\n`, "brands.csv": "ID,Name\nB1,Harbour\n", "menus.csv": "ID,Name,Brand\nM1,All day,B1\n", "sections.csv": "ID,Name,Menu\nS1,Mains,M1\n", "menu_items.csv": `Section,SKU,Sort\nS1,P1,${sort}\n`, "layout.csv": `Layout,Brand,Label,SKU\nL1,B1,${label},P1\n` });
    await run(M, files, csv(1, "Soup"));
    const e = await run(M, files, csv(2, "Hot soup"));
    expect({ options: e.modifier_options, items: e.menu_items, layouts: e.layouts }).toMatchObject({ options: { updates: 1 }, items: { updates: 1 }, layouts: { updates: 1 } });
    const [entry] = await db.sql<{ details: { entities: Record<string, { updates: number; updated_ids: string[] }> } }[]>`select details from audit_log where merchant_id = ${M.merchantId} and action = 'imports.applied' order by occurred_at desc limit 1`;
    const [option] = await db.sql<{ id: string }[]>`select id from modifier_options where merchant_id = ${M.merchantId}`;
    const [item] = await db.sql<{ section_id: string; product_id: string }[]>`select section_id, product_id from menu_items where merchant_id = ${M.merchantId}`;
    const d = entry!.details.entities;
    expect({ options: d.modifier_options!.updated_ids, items: d.menu_items!.updated_ids, layouts: d.layouts!.updated_ids }).toEqual({ options: [option!.id], items: [`${item!.section_id}/${item!.product_id}`], layouts: [await idOf("pos_layouts", M.merchantId, "L1")] });
  });
});

describe("a failed import", () => {
  it("says so in plain words, reports nothing applied, and does not stop the queue", async () => {
    const M = await seedMerchant(db.sql, "Failing");
    // A database fault the importer cannot blame on the row (a syntax error) on void reasons only.
    await db.sql.unsafe(`create function fail_import() returns trigger language plpgsql as $$ begin raise exception 'syntax error at or near "legacy_id"' using errcode = '42601'; end $$`);
    await db.sql.unsafe(`create trigger fail_import before insert on void_reasons for each row execute function fail_import()`);
    try {
      const failing = await queue(M, floor, floorCsv(""));
      const next = await queue(M, [floor[0]!], { "brands.csv": "ID,Name\nB9,Next brand\n" });
      expect(await runQueuedImports()).toBe(2);
      const j = await job(M, failing);
      expect(j.status).toBe("failed");
      expect(j.error).toBe("The import stopped on an unexpected error. Nothing was changed.");
      // Everything it wrote was rolled back, so no entity reports a create or an update.
      for (const [e, counts] of Object.entries(j.report!.entities)) expect({ e, creates: counts.creates, updates: counts.updates }).toEqual({ e, creates: 0, updates: 0 });
      expect(j.report!.entities.tender_types).toBeDefined();
      expect((await job(M, next)).status).toBe("applied");
      const [n] = await db.sql<{ n: number }[]>`select count(*)::int as n from tender_types where merchant_id = ${M.merchantId}`;
      expect(n!.n).toBe(0);
    } finally {
      await db.sql.unsafe(`drop trigger fail_import on void_reasons; drop function fail_import()`);
    }
  });

  it("tiles from a failed layout import do not reach the next import", async () => {
    const M = await seedMerchant(db.sql, "Tiles");
    const layout: FileMap = { name: "layout.csv", entity: "layouts", columns: { layout_legacy_id: "Layout", brand_legacy_id: "Brand", folder: "Folder", label: "Label" } };
    const brands: FileMap = { name: "brands.csv", entity: "brands", columns: { legacy_id: "ID", name: "Name" } };
    await run(M, [brands], { "brands.csv": "ID,Name\nB1,Harbour\n" });
    await db.sql.unsafe(`create function fail_layout() returns trigger language plpgsql as $$ begin raise exception 'boom' using errcode = '42601'; end $$`);
    await db.sql.unsafe(`create trigger fail_layout before insert on pos_layouts for each row execute function fail_layout()`);
    let failing: string;
    try {
      failing = await queue(M, [layout], { "layout.csv": "Layout,Brand,Folder,Label\nL1,B1,Drinks,Drinks\n" });
      await runQueuedImports();
    } finally {
      await db.sql.unsafe(`drop trigger fail_layout on pos_layouts; drop function fail_layout()`);
    }
    expect((await job(M, failing)).status).toBe("failed");
    const done = await run(M, [layout], { "layout.csv": "Layout,Brand,Folder,Label\nL2,B1,Mains,Mains\n" });
    expect(done.layouts).toMatchObject({ creates: 1 });
    const keys = await db.sql<{ legacy_id: string }[]>`select legacy_id from pos_layouts where merchant_id = ${M.merchantId}`;
    expect(keys.map((k) => k.legacy_id)).toEqual(["L2"]);
  });
});
