import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/modules.js";
import { buildApp, type App } from "../src/app.js";
import { runQueuedImports } from "../src/services/importer.js";
import { minorUnits, mapColour } from "../src/services/importer.js";
import { parseCsv, toCsv } from "../src/services/csv.js";
import { api, freshDb, seedMerchant, type SeededMerchant, type TestDb } from "./helpers.js";

let db: TestDb;
let app: App;
let A: SeededMerchant;
let call: ReturnType<typeof api>["call"];

beforeAll(async () => {
  db = await freshDb();
  app = buildApp();
  call = api(app).call;
  A = await seedMerchant(db.sql, "Alpha");
});
afterAll(async () => {
  await db.drop();
});

const files = {
  "brands.csv": 'Brand ID,Brand Name\nB1,Sample Kitchen\n',
  "categories.csv": 'Cat ID,Cat Name,Parent\nFOOD,Food,\nNOOD,Noodles,FOOD\nDRK,Drinks,\n',
  "items.csv": 'SKU,Item Name,Price,Category,Tags,Type,Deposit,Tax class\nLAK-001,Laksa,"16.00",NOOD,kitchen;spicy,Item,,standard-rated\nKOPI-01,Kopi,3.80,DRK,bar,Item,,\nCAN-01,Canned drink,2.50,DRK,bar,Item,Y,\nPRAWN,Extra prawn,2.00,,,Modifier,,\nBADPRICE,Broken,abc,DRK,,Item,,\nBADCLASS,Caviar,99.00,FOOD,,Item,,Luxury\n',
  "modgroups.csv": 'Group ID,Group Name,Min,Max\nPROT,Protein,1,1\n',
  "modopts.csv": 'Group,Modifier SKU,Parent SKU,Price\nPROT,PRAWN,LAK-001,2.50\nPROT,MISSING,LAK-001,\n',
  "menus.csv": 'Menu ID,Menu Name,Brand\nMAIN,All day,B1\n',
  "sections.csv": 'Section ID,Menu,Section Name,Sort\nS-NOOD,MAIN,Noodles,1\nS-DRK,MAIN,Drinks,2\n',
  "menuitems.csv": 'Section,SKU\nS-NOOD,LAK-001\nS-DRK,KOPI-01\nS-DRK,CAN-01\n',
  "tenders.csv": 'Tender,Cash\nCash,Y\nVisa,N\nPayNow,N\n',
  "layout.csv": 'Page,Folder,Label,SKU,Colour,Access\nMains,,Laksa,LAK-001,#D08A2E,Everyone\nDrinks,Hot,Kopi,KOPI-01,blue,Everyone\nDrinks,,,,,\n',
};

const mapping = {
  files: [
    { name: "brands.csv", entity: "brands", columns: { legacy_id: "Brand ID", name: "Brand Name" } },
    { name: "categories.csv", entity: "categories", columns: { legacy_id: "Cat ID", name: "Cat Name", parent_legacy_id: "Parent" } },
    { name: "items.csv", entity: "products", columns: { sku: "SKU", name: "Item Name", price: "Price", category_legacy_id: "Category", tags: "Tags", kind: "Type", has_deposit: "Deposit", tax_class: "Tax class" }, defaults: {} },
    { name: "modgroups.csv", entity: "modifier_groups", columns: { legacy_id: "Group ID", name: "Group Name", min_select: "Min", max_select: "Max" } },
    { name: "modopts.csv", entity: "modifier_options", columns: { group_legacy_id: "Group", product_sku: "Modifier SKU", parent_product_sku: "Parent SKU", price_override: "Price" } },
    { name: "menus.csv", entity: "menus", columns: { legacy_id: "Menu ID", name: "Menu Name", brand_legacy_id: "Brand" } },
    { name: "sections.csv", entity: "menu_sections", columns: { legacy_id: "Section ID", menu_legacy_id: "Menu", name: "Section Name", sort: "Sort" } },
    { name: "menuitems.csv", entity: "menu_items", columns: { section_legacy_id: "Section", product_sku: "SKU" } },
    { name: "tenders.csv", entity: "tender_types", columns: { name: "Tender", is_cash: "Cash" } },
    { name: "layout.csv", entity: "layouts", columns: { page: "Page", folder: "Folder", label: "Label", product_sku: "SKU", colour: "Colour", access_level: "Access" }, defaults: { layout_name: "Main layout" } },
  ],
  options: { brand_legacy_id: "B1" },
};

type Job = { id: string; status: string; report: { entities: Record<string, { creates: number; updates: number; unchanged: number; rejected: { reason: string }[] }>; warnings: string[] } | null };

describe("CSV helpers", () => {
  it("parses quotes, CRLF and a BOM; writes escaped output", () => {
    const { headers, rows } = parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\r\n1,2\r\n');
    expect(headers).toEqual(["a", "b"]);
    expect(rows).toEqual([
      { a: "x, y", b: 'he said "hi"' },
      { a: "1", b: "2" },
    ]);
    expect(toCsv(["a"], [["x,y"], ['q"q']])).toBe('a\r\n"x,y"\r\n"q""q"\r\n');
  });
  it("parses prices and maps colours", () => {
    expect(minorUnits("16.00", 2)).toBe(1600);
    expect(minorUnits("$1,234.5", 2)).toBe(123_450);
    expect(minorUnits("€16", 2)).toBe(1600);
    expect(minorUnits("1600c", 2)).toBe(1600);
    expect(minorUnits("abc", 2)).toBeNull();
    // The currency's own decimals: yen have none, dinars have three.
    expect(minorUnits("1,600", 0)).toBe(1600);
    expect(minorUnits("16.5", 0)).toBeNull();
    expect(minorUnits("1.234", 3)).toBe(1234);
    expect(minorUnits("1.2345", 3)).toBeNull();
    // A comma groups thousands and is never a decimal mark: a European "16,50" is refused rather than read as 1650.
    expect(minorUnits("16,50", 2)).toBeNull();
    expect(minorUnits("1,5", 2)).toBeNull();
    expect(minorUnits("1,234,567.89", 2)).toBe(123_456_789);
    expect(mapColour("#D08A2E")).toBe("amber");
    expect(mapColour("blue")).toBe("sky");
    expect(mapColour("")).toBe("stone");
    expect(mapColour("weird", { weird: "plum" })).toBe("plum");
  });
});

describe("legacy importer", () => {
  let dryRunId: string;

  it("a dry run reports creates and rejected rows without changing data", async () => {
    const r = await call<{ data: Job }>("POST", "/v1/imports", { token: A.admin.token, body: { mapping, files, dry_run: true } });
    expect(r.status).toBe(201);
    dryRunId = r.body.data.id;
    expect(await runQueuedImports()).toBe(1);
    const job = await call<{ data: Job }>("GET", `/v1/imports/${dryRunId}`, { token: A.admin.token });
    expect(job.body.data.status).toBe("dry_run_complete");
    const e = job.body.data.report!.entities;
    expect(e.brands).toMatchObject({ creates: 1, rejected: [] });
    expect(e.categories).toMatchObject({ creates: 3 });
    expect(e.products!.creates).toBe(4);
    expect(e.products!.rejected.map((x) => x.reason)).toEqual(['price "abc" is not an amount: write it like 4.50', 'tax class "Luxury" not found']);
    expect(e.modifier_options!.creates).toBe(1);
    expect(e.modifier_options!.rejected[0]!.reason).toMatch(/MISSING not found/);
    expect(e.menu_items!.creates).toBe(3);
    expect(e.tender_types!.creates).toBe(3);
    expect(e.layouts!.creates).toBe(1);
    expect(e.layouts!.rejected[0]!.reason).toMatch(/needs a product sku or a folder name/);
    const [n] = await db.sql`select count(*)::int as n from products where merchant_id = ${A.merchantId}`;
    expect(n!.n).toBe(0);
  });

  it("applying the dry run creates the catalogue; a re-run is all unchanged", async () => {
    const apply = await call<{ data: Job }>("POST", `/v1/imports/${dryRunId}/apply`, { token: A.admin.token, body: {} });
    expect(apply.status).toBe(201);
    await runQueuedImports();
    const job = await call<{ data: Job }>("GET", `/v1/imports/${apply.body.data.id}`, { token: A.admin.token });
    expect(job.body.data.status).toBe("applied");

    const products = await call<{ data: { name: string; sku: string; price: number; tags: string[]; has_deposit: boolean; tax_class_id: string | null; kind: string; modifier_group_ids: string[] }[] }>("GET", "/v1/products?include_archived=true", { token: A.admin.token });
    const laksa = products.body.data.find((p) => p.sku === "LAK-001")!;
    expect(laksa).toMatchObject({ price: 1600, tags: ["kitchen", "spicy"], kind: "product" });
    expect(laksa.modifier_group_ids).toHaveLength(1);
    // The class is named, in any case; a blank class is the merchant's default (null).
    expect(laksa.tax_class_id).toBe(A.taxClassIds.standard);
    expect(products.body.data.find((p) => p.sku === "KOPI-01")!.tax_class_id).toBeNull();
    expect(products.body.data.find((p) => p.sku === "CAN-01")!.has_deposit).toBe(true);
    expect(products.body.data.find((p) => p.sku === "PRAWN")!.kind).toBe("component");

    const menus = await call<{ data: { id: string }[] }>("GET", "/v1/menus", { token: A.admin.token });
    const menu = await call<{ data: { sections: { name: string; items: unknown[] }[] } }>("GET", `/v1/menus/${menus.body.data[0]!.id}`, { token: A.admin.token });
    expect(menu.body.data.sections.map((s) => [s.name, s.items.length])).toEqual([
      ["Noodles", 1],
      ["Drinks", 2],
    ]);
    const layouts = await call<{ data: { id: string }[] }>("GET", "/v1/layouts", { token: A.admin.token });
    const layout = await call<{ data: { pages: { name: string; tiles: { kind: string; label: string; color: string; tiles?: unknown[] }[] }[] } }>("GET", `/v1/layouts/${layouts.body.data[0]!.id}`, { token: A.admin.token });
    expect(layout.body.data.pages.map((p) => p.name)).toEqual(["Mains", "Drinks"]);
    expect(layout.body.data.pages[0]!.tiles[0]).toMatchObject({ kind: "product", label: "Laksa", color: "amber" });
    expect(layout.body.data.pages[1]!.tiles[0]).toMatchObject({ kind: "folder", label: "Hot" });
    expect(layout.body.data.pages[1]!.tiles[0]!.tiles).toHaveLength(1);

    // Re-run: nothing changes.
    const again = await call<{ data: Job }>("POST", "/v1/imports", { token: A.admin.token, body: { mapping, files, dry_run: false } });
    await runQueuedImports();
    const rep = (await call<{ data: Job }>("GET", `/v1/imports/${again.body.data.id}`, { token: A.admin.token })).body.data.report!;
    for (const [entity, counts] of Object.entries(rep.entities)) {
      expect(counts.creates, `${entity} creates`).toBe(0);
      expect(counts.updates, `${entity} updates`).toBe(0);
    }
  });

  it("an edited export updates rows in place", async () => {
    const edited = { ...files, "items.csv": files["items.csv"].replace('LAK-001,Laksa,"16.00"', 'LAK-001,Laksa,"17.50"') };
    const r = await call<{ data: Job }>("POST", "/v1/imports", { token: A.admin.token, body: { mapping, files: edited, dry_run: false } });
    await runQueuedImports();
    const rep = (await call<{ data: Job }>("GET", `/v1/imports/${r.body.data.id}`, { token: A.admin.token })).body.data.report!;
    expect(rep.entities.products).toMatchObject({ creates: 0, updates: 1, unchanged: 3 });
    const [row] = await db.sql`select price from products where sku = 'LAK-001'`;
    expect(row!.price).toBe(1750);
    const [count] = await db.sql`select count(*)::int as n from products where merchant_id = ${A.merchantId}`;
    expect(count!.n).toBe(4);
  });

  it("only Admin may import", async () => {
    expect((await call("POST", "/v1/imports", { token: A.manager.token, body: { mapping, files } })).status).toBe(403);
  });
});

describe("money review: importer amounts", () => {
  it("a modifier price override that is not an amount refuses the row instead of silently using the product's price", async () => {
    const B = await seedMerchant(db.sql, "Bravo");
    const f = {
      "items.csv": "SKU,Item Name,Price,Type\nNOODLE,Noodle,8.00,Item\nEGG,Egg,1.00,Modifier\nHUGE,Banquet,99999999999999999999,Item\n",
      "modgroups.csv": "Group ID,Group Name,Min,Max\nADD,Add-ons,0,2\n",
      "modopts.csv": "Group,Modifier SKU,Parent SKU,Price\nADD,EGG,NOODLE,\"0,50\"\n",
    };
    const m = { files: [mapping.files[2]!, mapping.files[3]!, mapping.files[4]!].map((x) => ({ ...x, columns: Object.fromEntries(Object.entries(x.columns).filter(([k]) => !["category_legacy_id", "tags", "has_deposit", "tax_class"].includes(k))) })) };
    const r = await call<{ data: Job }>("POST", "/v1/imports", { token: B.admin.token, body: { mapping: m, files: f, dry_run: true } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    await runQueuedImports();
    const job = await call<{ data: Job }>("GET", `/v1/imports/${r.body.data.id}`, { token: B.admin.token });
    const e = job.body.data.report!.entities;
    expect(e.modifier_options!.creates).toBe(0);
    expect(e.modifier_options!.rejected.map((x) => x.reason)).toEqual(['price_override "0,50" is not an amount: write it like 4.50']);
    expect(e.products!.rejected.map((x) => x.reason)).toEqual(['price "99999999999999999999" is above the largest amount the register accepts']);
  });
});
