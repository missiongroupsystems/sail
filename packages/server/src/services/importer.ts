import { currencyExponent, MAX_AMOUNT, toE164 } from "@sail/shared";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ROLES } from "@sail/shared";
import { withTransaction, type RequestTx } from "../db/client.js";
import { importJobs, type ImportEntity, type ImportMapping, type ImportReport } from "../db/schema/index.js";
import { hashSecret, pinLookup } from "../auth/tokens.js";
import { parseCsv } from "./csv.js";
import { TILE_COLOURS } from "../routes/floor.js";
import type { LayoutPage, LayoutTile } from "../db/schema/catalogue.js";
import { logger } from "../logger.js";
import { PIN_TAKEN_LIMITS, returnPinAttempt, takePinAttempt } from "./pin-attempts.js";

/**
 * Why the database refused a row, said as the API says it (app.ts): never a constraint, a key value or row-level
 * security. A refusal written for people (SL400) keeps its message; an error raised by the importer itself is kept.
 */
export function rowRefusal(e: unknown): string {
  const pg = e as { code?: unknown; message?: string; constraint_name?: string; detail?: string };
  if (typeof pg.code !== "string" || !/^[0-9A-Z]{5}$/.test(pg.code) || !(e instanceof Error) || e.name !== "PostgresError") return (e as Error).message;
  if (pg.code === "SL400") return pg.message ?? "This row is not allowed";
  if (pg.code === "23505") return pg.constraint_name === "staff_merchant_pin_uq" ? "Someone at this business already uses that PIN" : "A record with the same unique value already exists";
  if (pg.code === "23503") return "A referenced record does not exist";
  if (pg.code === "23502") return "A required value is missing";
  if (pg.code.startsWith("22")) return "A value is not valid or is too large";
  return "The row would break a rule the register keeps";
}

/**
 * Legacy POS importer: CSV-first, one-way, re-runnable. Records
 * match on `legacy_id` (or SKU for products), so a re-run updates rows instead
 * of duplicating them. A dry run produces the same report and rolls back.
 * Runs on the worker, never in a request transaction. Column mapping is
 * documented in docs/csv-mapping.md.
 */

const ENTITY_ORDER: ImportEntity[] = ["brands", "outlets", "categories", "products", "modifier_groups", "modifier_options", "menus", "menu_sections", "menu_items", "areas", "tables", "tender_types", "void_reasons", "staff", "customers", "layouts"];

type Row = Record<string, string>;
type EntityReport = ImportReport["entities"][string];
class DryRunRollback extends Error {}

export async function runQueuedImports(): Promise<number> {
  const jobs = await withTransaction((t) => t.db.select({ id: importJobs.id }).from(importJobs).where(eq(importJobs.status, "queued")).orderBy(importJobs.createdAt));
  for (const j of jobs) await runImportJob(j.id);
  return jobs.length;
}

export async function runImportJob(jobId: string): Promise<ImportReport> {
  const job = await withTransaction(async (t) => {
    const [row] = await t.db.update(importJobs).set({ status: "running", startedAt: new Date() }).where(and(eq(importJobs.id, jobId), eq(importJobs.status, "queued"))).returning();
    return row;
  });
  if (!job) throw new Error(`import job ${jobId} is not queued`);
  let report: ImportReport = { entities: {}, warnings: [] };
  try {
    try {
      await withTransaction(async (t) => {
        report = await importInto(t, job.merchantId, job.mapping, job.files, { actorId: job.createdBy });
        if (job.dryRun) throw new DryRunRollback();
      });
    } catch (e) {
      if (!(e instanceof DryRunRollback)) throw e;
    }
    await withTransaction((t) => t.db.update(importJobs).set({ status: job.dryRun ? "dry_run_complete" : "applied", report, finishedAt: new Date() }).where(eq(importJobs.id, jobId)));
    return report;
  } catch (e) {
    logger.error({ err: e, jobId }, "import failed");
    await withTransaction((t) => t.db.update(importJobs).set({ status: "failed", error: String((e as Error).message ?? e), report, finishedAt: new Date() }).where(eq(importJobs.id, jobId)));
    throw e;
  }
}

/** Run an import for a merchant inside the given transaction. Exposed for tests. */
export async function importInto(t: RequestTx, merchantId: string, mapping: ImportMapping, files: Record<string, string>, opts: { actorId?: string | null } = {}): Promise<ImportReport> {
  const report: ImportReport = { entities: {}, warnings: [] };
  // Each row runs in its own savepoint (below), and its queries go through that savepoint's handle.
  let sql = t.sql;
  const legacy: Record<string, Map<string, string>> = {}; // entity → legacy_id → our id
  const skuToProduct = new Map<string, string>();
  const [settings] = await sql<{ currency: string; locale: string }[]>`select currency, locale from merchant_settings where merchant_id = ${merchantId}`;
  if (!settings) throw new Error("merchant settings not found");
  const exponent = currencyExponent(settings.currency);
  /** A non-empty amount cell, in minor units; a row whose cell is not an amount is refused, never read as "no amount". */
  const amountCell = (field: string, value: string) => {
    const c = minorUnits(value, exponent);
    if (c == null) throw new Error(/^\s*[-−]/.test(value) ? `${field} "${value}" cannot be negative` : `${field} "${value}" is not an amount: write it like 4.50`);
    if (c > MAX_AMOUNT) throw new Error(`${field} "${value}" is above the largest amount the register accepts`);
    return c;
  };
  // Products name their tax class by name; blank is the merchant's default class.
  const taxClasses = new Map((await sql<{ id: string; name: string }[]>`select id, name from tax_classes where merchant_id = ${merchantId} and archived_at is null`).map((c) => [c.name.toLowerCase(), c.id]));

  // Pre-load existing legacy IDs so references resolve across re-runs and across files.
  const preload = async (entity: string, table: string) => {
    const rows = await sql.unsafe<{ id: string; legacy_id: string }[]>(`select id, legacy_id from ${table} where merchant_id = $1 and legacy_id is not null`, [merchantId]);
    legacy[entity] = new Map(rows.map((r) => [r.legacy_id, r.id]));
  };
  for (const [entity, table] of Object.entries({ brands: "brands", outlets: "outlets", categories: "report_categories", products: "products", modifier_groups: "modifier_groups", menus: "menus", menu_sections: "menu_sections", areas: "areas", tables: "tables", tender_types: "tender_types", void_reasons: "void_reasons", staff: "staff", customers: "customers", layouts: "pos_layouts" })) await preload(entity, table);
  for (const r of await sql<{ id: string; sku: string }[]>`select id, sku from products where merchant_id = ${merchantId} and sku is not null`) skuToProduct.set(r.sku, r.id);
  // A category or brand without a legacy id is named in Sail's own export by its name (A P4); a name two records share
  // names neither (null), and the row says so.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ids: Record<"categories" | "brands", Set<string>> = { categories: new Set(), brands: new Set() };
  for (const [ent, table] of [["categories", "report_categories"], ["brands", "brands"]] as const) for (const r of await sql.unsafe<{ id: string }[]>(`select id from ${table} where merchant_id = $1`, [merchantId])) ids[ent].add(r.id);
  const byName = async (table: string) => {
    const map = new Map<string, string | null>();
    for (const r of await sql.unsafe<{ id: string; name: string }[]>(`select id, name from ${table} where merchant_id = $1 and legacy_id is null`, [merchantId])) {
      const k = r.name.trim().toLowerCase();
      map.set(k, map.has(k) ? null : r.id);
    }
    return map;
  };
  const namedCategories = await byName("report_categories");
  const namedBrands = await byName("brands");
  const refOrName = (ent: "categories" | "brands", key: string, label: string): string | null => {
    const hit = legacy[ent]?.get(key);
    if (hit) return hit;
    // Sail's own export names a record whose name is shared by its id.
    if (UUID.test(key) && ids[ent].has(key.toLowerCase())) return key.toLowerCase();
    const named = (ent === "categories" ? namedCategories : namedBrands).get(key.trim().toLowerCase());
    if (named === null) throw new Error(`${label} "${key}" names more than one ${label}: give it a legacy_id`);
    if (named === undefined) throw new Error(`${label} ${key} not found`);
    return named;
  };

  const files_ = mapping.files.filter((f) => files[f.name] != null);
  for (const f of mapping.files) if (files[f.name] == null) report.warnings.push(`file ${f.name} was not uploaded; skipped`);

  for (const entity of ENTITY_ORDER) {
    for (const file of files_.filter((f) => f.entity === entity)) {
      const { headers, rows } = parseCsv(files[file.name]!);
      const rep: EntityReport = (report.entities[entity] ??= { creates: 0, updates: 0, unchanged: 0, rejected: [] });
      const missing = Object.values(file.columns).filter((col) => !headers.includes(col));
      if (missing.length) {
        report.warnings.push(`${file.name}: mapped columns not found: ${missing.join(", ")}`);
      }
      const get = (row: Row, field: string): string => {
        const col = file.columns[field];
        const v = col ? row[col] : undefined;
        return (v ?? file.defaults?.[field] ?? "").trim();
      };
      const reject = (i: number, reason: string, row: Row) => rep.rejected.push({ row: i + 2, reason, data: row });
      const ref = (ent: string, key: string): string | undefined => legacy[ent]?.get(key);

      const upsert = async (table: string, legacyId: string, values: Record<string, unknown>, matchBy: { column: string; value: string } = { column: "legacy_id", value: legacyId }) => {
        const [existing] = await sql.unsafe<Record<string, unknown>[]>(`select * from ${table} where merchant_id = $1 and ${matchBy.column} = $2 limit 1`, [merchantId, matchBy.value]);
        const cols = Object.keys(values);
        if (!existing) {
          const id = randomUUID();
          await sql.unsafe(`insert into ${table} (id, merchant_id, legacy_id, ${cols.join(", ")}) values ($1, $2, nullif($3, ''), ${cols.map((_, i) => `$${i + 4}`).join(", ")})`, [id, merchantId, legacyId, ...cols.map((c) => serialise(values[c]))] as never);
          rep.creates++;
          return { id, created: true };
        }
        const changed = cols.filter((c) => !same(existing[c], values[c])) ;
        if (changed.length === 0 && (existing["legacy_id"] === legacyId || !legacyId)) {
          rep.unchanged++;
          return { id: existing["id"] as string, created: false };
        }
        // An empty legacy id (a product matched on its Sail id) keeps the one stored.
        const sets = ["legacy_id = coalesce(nullif($2, ''), legacy_id)", ...changed.map((c, i) => `${c} = $${i + 3}`), ...(table === "products" || table === "customers" ? ["updated_at = now()"] : [])];
        await sql.unsafe(`update ${table} set ${sets.join(", ")} where id = $1`, [existing["id"], legacyId, ...changed.map((c) => serialise(values[c]))] as never);
        rep.updates++;
        return { id: existing["id"] as string, created: false };
      };

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        // A row the database refuses (a third category level, a taken email) is rejected alone, not the whole import.
        try {
          await t.sql.savepoint(async (sp) => {
          sql = sp;
          switch (entity) {
            case "brands": {
              const lid = get(row, "legacy_id") || get(row, "name");
              const name = get(row, "name");
              if (!name) throw new Error("name is required");
              const { id } = await upsert("brands", lid, { name, accent_color: get(row, "accent_color") || null });
              legacy.brands!.set(lid, id);
              break;
            }
            case "outlets": {
              const lid = get(row, "legacy_id") || get(row, "name");
              const name = get(row, "name");
              if (!name) throw new Error("name is required");
              // An outlet belongs to one brand: the row's, the file's default, or the merchant's only brand. An outlet
              // that is already there keeps its brand: an import does not move an outlet to another brand.
              const brandKey = get(row, "brand_legacy_id") || mapping.options?.brand_legacy_id || "";
              const named = brandKey ? refOrName("brands", brandKey, "brand") : null;
              const [there] = await sql.unsafe<{ brand_id: string }[]>(`select brand_id from outlets where merchant_id = $1 and legacy_id = $2 limit 1`, [merchantId, lid]);
              if (there && named && named !== there.brand_id) throw new Error("an outlet's brand cannot be changed by an import: change it in Settings > Outlets");
              // A new outlet goes on a brand that trades: the register refuses an archived one too.
              if (!there && named) {
                const [brand] = await sql.unsafe<{ archived: boolean }[]>(`select archived_at is not null as archived from brands where id = $1 and merchant_id = $2`, [named, merchantId]);
                if (brand?.archived) throw new Error(`brand ${brandKey} is archived: restore it in Settings > Brands, or name another brand`);
              }
              let brandId = there?.brand_id ?? named;
              if (!brandId) {
                const live = await sql.unsafe<{ id: string }[]>(`select id from brands where merchant_id = $1 and archived_at is null`, [merchantId]);
                if (live.length !== 1) throw new Error(live.length === 0 ? "brand_legacy_id is required: the merchant has no brand yet (import brands first)" : "brand_legacy_id is required: the merchant has more than one brand");
                brandId = live[0]!.id;
              }
              const { id } = await upsert("outlets", lid, { brand_id: brandId, name, address: get(row, "address") || null, phone: get(row, "phone") || null, business_registration_no: get(row, "business_registration_no") || null, tax_registration_no: get(row, "tax_registration_no") || null, business_day_cutoff: get(row, "business_day_cutoff") || null });
              legacy.outlets!.set(lid, id);
              break;
            }
            case "categories": {
              const lid = get(row, "legacy_id") || get(row, "name");
              const name = get(row, "name");
              if (!name) throw new Error("name is required");
              const parentKey = get(row, "parent_legacy_id");
              const parentId = (parentKey ? ref("categories", parentKey) : null) ?? null;
              if (parentKey && !parentId) throw new Error(`parent category ${parentKey} not found (parents must come first)`);
              const { id } = await upsert("report_categories", lid, { name, parent_id: parentId, sort: num(get(row, "sort"), 0) });
              legacy.categories!.set(lid, id);
              break;
            }
            case "products": {
              // Every problem on the row is reported together, not only the first (A P13).
              const errors: string[] = [];
              const check = <T,>(read: () => T, fallback: T): T => {
                try {
                  return read();
                } catch (e) {
                  errors.push((e as Error).message);
                  return fallback;
                }
              };
              const sku = get(row, "sku") || null;
              const lid = get(row, "legacy_id") || sku || "";
              // Sail's own export names every product by its id (`sail_id`), so one without a SKU or legacy id comes back.
              const sailId = get(row, "sail_id");
              if (sailId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sailId)) errors.push(`sail_id "${sailId}" is not a Sail product id`);
              const name = get(row, "name");
              if (!name) errors.push("name is required");
              if (!lid && !sailId) errors.push("sku, legacy_id or sail_id is required");
              const priceCents = check(() => amountCell("price", get(row, "price")), 0);
              const catKey = get(row, "category_legacy_id");
              const categoryId = catKey ? check(() => refOrName("categories", catKey, "category"), null) : null;
              const brandKey = get(row, "brand_legacy_id") || mapping.options?.brand_legacy_id || "";
              const brandId = brandKey ? check(() => refOrName("brands", brandKey, "brand"), null) : null;
              const tags = get(row, "tags").split(/[;|]/).map((s) => s.trim()).filter(Boolean);
              const kindCell = get(row, "kind");
              // A legacy "Item" is a product and a "Modifier" a component; any other word is refused, never guessed.
              if (kindCell && !/^(product|item|component|modifier)$/i.test(kindCell)) errors.push(`kind "${kindCell}" is not product or component`);
              const kind = /^(component|modifier)$/i.test(kindCell) ? "component" : "product";
              const className = get(row, "tax_class");
              const taxClassId = className ? taxClasses.get(className.toLowerCase()) : null;
              if (taxClassId === undefined) errors.push(`tax class "${className}" not found`);
              // Read the per-order-type prices first, so a bad one refuses the row before anything is written.
              const prices = (["dine_in", "takeaway", "pickup", "delivery"] as const).flatMap((ot) => {
                const v = get(row, `price_${ot}`);
                // A blank cell in a mapped column is "no price for that order type"; an unmapped column leaves it alone.
                if (!v) return file.columns[`price_${ot}`] ? [{ ot, price: null as number | null }] : [];
                return check(() => [{ ot, price: amountCell(`price_${ot}`, v) as number | null }], []);
              });
              if (errors.length) throw new Error(errors.join("; "));
              const values = { name, sku, description: get(row, "description") || null, price: priceCents, category_id: categoryId, brand_id: brandId, tags, has_deposit: bool(get(row, "has_deposit")), tax_class_id: taxClassId ?? null, open_price: bool(get(row, "open_price")), kind, kitchen_name: get(row, "kitchen_name") || null, archived_at: bool(get(row, "archived")) ? new Date().toISOString() : null };
              const [bySailId] = sailId ? await sql<{ id: string }[]>`select id from products where merchant_id = ${merchantId} and id = ${sailId} limit 1` : [];
              // A Sail id from another business or database names nothing here: without a SKU or legacy id the row would
              // create a new copy on every run, so it is refused instead.
              if (sailId && !bySailId && !lid) throw new Error(`sail_id ${sailId} is not a product of this business: give the row a sku or legacy_id`);
              const match = bySailId ? { column: "id", value: bySailId.id } : sku && !get(row, "legacy_id") ? { column: "sku", value: sku } : { column: "legacy_id", value: lid };
              const unchangedBefore = rep.unchanged;
              // Matched on its Sail id, a product keeps the legacy id it has unless the row gives one (its SKU is not one).
              const { id, created } = await upsert("products", bySailId ? get(row, "legacy_id") : lid, values, match);
              if (lid) legacy.products!.set(lid, id);
              if (sku) skuToProduct.set(sku, id);
              let pricesChanged = false;
              for (const { ot, price } of prices) {
                const changedRows =
                  price === null
                    ? await sql`delete from product_prices where product_id = ${id} and order_type = ${ot} returning 1`
                    : await sql`insert into product_prices (merchant_id, product_id, order_type, price) values (${merchantId}, ${id}, ${ot}, ${price}) on conflict (product_id, order_type) do update set price = excluded.price where product_prices.price is distinct from excluded.price returning 1`;
                if (changedRows.length) pricesChanged = true;
              }
              // A row whose only change is a per-order-type price is an update, not "unchanged".
              if (pricesChanged && !created && rep.unchanged > unchangedBefore) {
                rep.unchanged--;
                rep.updates++;
              }
              break;
            }
            case "modifier_groups": {
              const lid = get(row, "legacy_id") || get(row, "name");
              const name = get(row, "name");
              if (!name) throw new Error("name is required");
              const { id } = await upsert("modifier_groups", lid, { name, min_select: num(get(row, "min_select"), 0), max_select: get(row, "max_select") ? num(get(row, "max_select"), 1) : null, max_per_modifier: num(get(row, "max_per_modifier"), 1) });
              legacy.modifier_groups!.set(lid, id);
              break;
            }
            case "modifier_options": {
              const groupId = ref("modifier_groups", get(row, "group_legacy_id"));
              if (!groupId) throw new Error(`modifier group ${get(row, "group_legacy_id")} not found`);
              const prodKey = get(row, "product_legacy_id") || get(row, "product_sku");
              const productId = ref("products", prodKey) ?? skuToProduct.get(prodKey);
              if (!productId) throw new Error(`modifier product ${prodKey} not found`);
              const childKey = get(row, "child_group_legacy_id");
              const childId = (childKey ? ref("modifier_groups", childKey) : null) ?? null;
              if (childKey && !childId) throw new Error(`child group ${childKey} not found`);
              // A blank override uses the modifier product's own price; one that does not parse refuses the row.
              const override = get(row, "price_override") ? amountCell("price_override", get(row, "price_override")) : null;
              const [existing] = await sql<{ id: string; price_override: number | null; child_group_id: string | null; sort: number }[]>`select id, price_override, child_group_id, sort from modifier_options where group_id = ${groupId} and product_id = ${productId}`;
              const sort = num(get(row, "sort"), 0);
              if (!existing) {
                await sql`insert into modifier_options (merchant_id, group_id, product_id, price_override, child_group_id, is_default, sort) values (${merchantId}, ${groupId}, ${productId}, ${override}, ${childId}, ${bool(get(row, "is_default"))}, ${sort})`;
                rep.creates++;
              } else if (existing.price_override !== override || existing.child_group_id !== childId || existing.sort !== sort) {
                await sql`update modifier_options set price_override = ${override}, child_group_id = ${childId}, sort = ${sort} where id = ${existing.id}`;
                rep.updates++;
              } else rep.unchanged++;
              // Attach the group to a parent product when given.
              const parentKey = get(row, "parent_product_legacy_id") || get(row, "parent_product_sku");
              if (parentKey) {
                const parentId = ref("products", parentKey) ?? skuToProduct.get(parentKey);
                if (!parentId) throw new Error(`parent product ${parentKey} not found`);
                await sql`insert into product_modifier_groups (merchant_id, product_id, group_id, sort) values (${merchantId}, ${parentId}, ${groupId}, ${num(get(row, "group_sort"), 0)}) on conflict do nothing`;
              }
              break;
            }
            case "menus": {
              const lid = get(row, "legacy_id") || get(row, "name");
              const name = get(row, "name");
              const brandKey = get(row, "brand_legacy_id") || mapping.options?.brand_legacy_id || "";
              const brandId = (brandKey ? ref("brands", brandKey) : null) ?? null;
              if (!name) throw new Error("name is required");
              if (!brandId) throw new Error(`brand ${brandKey || "(none)"} not found`);
              const { id } = await upsert("menus", lid, { name, brand_id: brandId });
              legacy.menus!.set(lid, id);
              break;
            }
            case "menu_sections": {
              const lid = get(row, "legacy_id") || `${get(row, "menu_legacy_id")}/${get(row, "name")}`;
              const menuId = ref("menus", get(row, "menu_legacy_id"));
              if (!menuId) throw new Error(`menu ${get(row, "menu_legacy_id")} not found`);
              const parentKey = get(row, "parent_legacy_id");
              const parentId = (parentKey ? ref("menu_sections", parentKey) : null) ?? null;
              if (parentKey && !parentId) throw new Error(`parent section ${parentKey} not found`);
              const name = get(row, "name");
              if (!name) throw new Error("name is required");
              const { id } = await upsert("menu_sections", lid, { menu_id: menuId, parent_id: parentId, name, sort: num(get(row, "sort"), i) });
              legacy.menu_sections!.set(lid, id);
              break;
            }
            case "menu_items": {
              const sectionId = ref("menu_sections", get(row, "section_legacy_id"));
              if (!sectionId) throw new Error(`section ${get(row, "section_legacy_id")} not found`);
              const prodKey = get(row, "product_legacy_id") || get(row, "product_sku");
              const productId = ref("products", prodKey) ?? skuToProduct.get(prodKey);
              if (!productId) throw new Error(`product ${prodKey} not found`);
              const [menu] = await sql<{ menu_id: string }[]>`select menu_id from menu_sections where id = ${sectionId}`;
              const sort = num(get(row, "sort"), i);
              const [existing] = await sql<{ sort: number }[]>`select sort from menu_items where section_id = ${sectionId} and product_id = ${productId}`;
              if (!existing) {
                await sql`insert into menu_items (merchant_id, menu_id, section_id, product_id, sort) values (${merchantId}, ${menu!.menu_id}, ${sectionId}, ${productId}, ${sort})`;
                rep.creates++;
              } else if (existing.sort !== sort) {
                await sql`update menu_items set sort = ${sort} where section_id = ${sectionId} and product_id = ${productId}`;
                rep.updates++;
              } else rep.unchanged++;
              break;
            }
            case "areas": {
              const lid = get(row, "legacy_id") || `${get(row, "outlet_legacy_id")}/${get(row, "name")}`;
              const outletId = ref("outlets", get(row, "outlet_legacy_id") || mapping.options?.outlet_legacy_id || "");
              if (!outletId) throw new Error(`outlet ${get(row, "outlet_legacy_id")} not found`);
              const name = get(row, "name");
              if (!name) throw new Error("name is required");
              const { id } = await upsert("areas", lid, { outlet_id: outletId, name, sort: num(get(row, "sort"), i) });
              legacy.areas!.set(lid, id);
              break;
            }
            case "tables": {
              const lid = get(row, "legacy_id") || `${get(row, "area_legacy_id")}/${get(row, "name")}`;
              const areaId = ref("areas", get(row, "area_legacy_id"));
              if (!areaId) throw new Error(`area ${get(row, "area_legacy_id")} not found`);
              const [area] = await sql<{ outlet_id: string }[]>`select outlet_id from areas where id = ${areaId}`;
              const name = get(row, "name");
              if (!name) throw new Error("name is required");
              const { id } = await upsert("tables", lid, { outlet_id: area!.outlet_id, area_id: areaId, name, seats: num(get(row, "seats"), 4), shape: get(row, "shape") || "rect", x: num(get(row, "x"), 0), y: num(get(row, "y"), 0), w: num(get(row, "w"), 2), h: num(get(row, "h"), 2) });
              legacy.tables!.set(lid, id);
              break;
            }
            case "tender_types": {
              const lid = get(row, "legacy_id") || get(row, "name");
              const name = get(row, "name");
              if (!name) throw new Error("name is required");
              const isCash = bool(get(row, "is_cash"));
              const isTerminal = bool(get(row, "is_terminal"));
              // A house account (neither cash nor a card terminal) needs a Manager's approval, as when created by hand.
              const { id } = await upsert("tender_types", lid, { name, is_cash: isCash, opens_drawer: bool(get(row, "opens_drawer")) || isCash, is_terminal: isTerminal, requires_approval: !isCash && !isTerminal, sort: num(get(row, "sort"), i) });
              legacy.tender_types!.set(lid, id);
              break;
            }
            case "void_reasons": {
              const lid = get(row, "legacy_id") || get(row, "name");
              const name = get(row, "name");
              if (!name) throw new Error("name is required");
              const { id } = await upsert("void_reasons", lid, { name, for_refunds: get(row, "for_refunds") ? bool(get(row, "for_refunds")) : true, sort: num(get(row, "sort"), i) });
              legacy.void_reasons!.set(lid, id);
              break;
            }
            case "staff": {
              const lid = get(row, "legacy_id") || get(row, "email") || get(row, "name");
              const name = get(row, "name");
              if (!name) throw new Error("name is required");
              const role = get(row, "role").toLowerCase();
              if (!(ROLES as readonly string[]).includes(role)) throw new Error(`role "${role}" must be one of ${ROLES.join(", ")}`);
              const outletKeys = get(row, "outlet_legacy_ids").split(/[;|]/).map((s) => s.trim()).filter(Boolean);
              const outletIds = outletKeys.map((k) => ref("outlets", k));
              if (outletIds.some((x) => !x)) throw new Error(`outlet not found in ${outletKeys.join(";")}`);
              const pin = get(row, "pin");
              if (pin && !/^\d{6}$/.test(pin)) throw new Error("pin must be 6 digits");
              const values: Record<string, unknown> = { name, email: get(row, "email").toLowerCase() || null, role, outlet_ids: outletIds, initials: initialsFor(name), active: get(row, "active") ? bool(get(row, "active")) : true };
              if (pin) {
                values["pin_hash"] = hashSecret(pin);
                values["pin_lookup"] = pinLookup(merchantId, pin);
              }
              if (pin) {
                // A taken PIN is refused, and finding taken PINs is limited per person as in the staff form, so a dry
                // run of many rows cannot list colleagues' PINs. The count commits on its own, dry run or not.
                const scope = `pin_taken:${opts.actorId ? `staff:${opts.actorId}` : "import"}`;
                await takePinAttempt(merchantId, scope, PIN_TAKEN_LIMITS);
                const [holder] = await sql<{ id: string }[]>`select id from staff where merchant_id = ${merchantId} and pin_lookup = ${values["pin_lookup"] as string} and legacy_id is distinct from ${lid} limit 1`;
                if (holder) throw new Error("Someone at this business already uses that PIN");
                await returnPinAttempt(merchantId, scope);
              }
              const email = values["email"] as string | null;
              if (email) {
                const [taken] = await sql<{ id: string }[]>`select id from staff where merchant_id = ${merchantId} and lower(email) = ${email} and legacy_id is distinct from ${lid} limit 1`;
                if (taken) throw new Error(`email ${email} is already used by another staff member`);
              }
              const { id } = await upsert("staff", lid, values);
              legacy.staff!.set(lid, id);
              break;
            }
            case "customers": {
              // Stored in E.164, with the merchant's country for a national number, as every other customer write.
              const mobile = get(row, "mobile").trim() ? toE164(get(row, "mobile"), settings?.locale) : null;
              const lid = get(row, "legacy_id") || mobile || "";
              const name = get(row, "name");
              if (!name) throw new Error("name is required");
              if (!lid) throw new Error("mobile or legacy_id is required");
              const { id } = await upsert("customers", lid, { name, mobile, email: get(row, "email") || null, marketing_consent: bool(get(row, "marketing_consent")) }, mobile && !get(row, "legacy_id") ? { column: "mobile", value: mobile } : { column: "legacy_id", value: lid });
              legacy.customers!.set(lid, id);
              break;
            }
            case "layouts": {
              // One row per tile: layout, page, optional folder, label, product sku, colour, access level.
              const layoutKey = get(row, "layout_legacy_id") || get(row, "layout_name") || "default";
              const brandKey = get(row, "brand_legacy_id") || mapping.options?.brand_legacy_id || "";
              const brandId = (brandKey ? ref("brands", brandKey) : null) ?? null;
              if (!brandId) throw new Error(`brand ${brandKey || "(none)"} not found`);
              const prodKey = get(row, "product_legacy_id") || get(row, "product_sku");
              const productId = prodKey ? (ref("products", prodKey) ?? skuToProduct.get(prodKey)) : undefined;
              if (prodKey && !productId) throw new Error(`product ${prodKey} not found`);
              const tile: LayoutTile = { id: `t-${i + 1}`, kind: productId ? "product" : "folder", product_id: productId, label: get(row, "label") || get(row, "folder") || "?", color: mapColour(get(row, "colour") || get(row, "color"), mapping.options?.tile_colour_map), access_level: accessLevel(get(row, "access_level")) };
              if (!productId && !get(row, "folder")) throw new Error("a tile needs a product sku or a folder name");
              pendingLayouts.push({ key: layoutKey, brandId, name: get(row, "layout_name") || layoutKey, page: get(row, "page") || "Page 1", folder: get(row, "folder") || null, tile });
              break;
            }
          }
          });
        } catch (e) {
          reject(i, rowRefusal(e), row);
        } finally {
          sql = t.sql;
        }
      }
    }
  }

  // Assemble layouts from the collected tiles.
  const byLayout = new Map<string, { brandId: string; name: string; pages: Map<string, { folders: Map<string, LayoutTile>; tiles: LayoutTile[] }> }>();
  for (const pl of pendingLayouts) {
    const l = byLayout.get(pl.key) ?? { brandId: pl.brandId, name: pl.name, pages: new Map() };
    byLayout.set(pl.key, l);
    const page = l.pages.get(pl.page) ?? { folders: new Map(), tiles: [] };
    l.pages.set(pl.page, page);
    if (pl.folder && pl.tile.kind === "product") {
      let folder = page.folders.get(pl.folder);
      if (!folder) {
        folder = { id: `f-${page.folders.size + 1}`, kind: "folder", label: pl.folder, color: pl.tile.color, access_level: "everyone", tiles: [] };
        page.folders.set(pl.folder, folder);
        page.tiles.push(folder);
      }
      folder.tiles!.push(pl.tile);
    } else page.tiles.push(pl.tile);
  }
  if (byLayout.size) {
    const rep: EntityReport = (report.entities["layouts"] ??= { creates: 0, updates: 0, unchanged: 0, rejected: [] });
    for (const [key, l] of byLayout) {
      const pages: LayoutPage[] = [...l.pages.entries()].map(([name, p], i) => ({ id: `p-${i + 1}`, name, tiles: p.tiles }));
      const [existing] = await sql<{ id: string; pages: LayoutPage[] }[]>`select id, pages from pos_layouts where merchant_id = ${merchantId} and legacy_id = ${key}`;
      if (!existing) {
        await sql`insert into pos_layouts (merchant_id, brand_id, name, pages, legacy_id) values (${merchantId}, ${l.brandId}, ${l.name}, ${JSON.stringify(pages)}::jsonb, ${key})`;
        rep.creates++;
      } else if (canonical(existing.pages) !== canonical(pages)) {
        await sql`update pos_layouts set pages = ${JSON.stringify(pages)}::jsonb, version = version + 1, updated_at = now() where id = ${existing.id}`;
        rep.updates++;
      } else rep.unchanged++;
    }
  }
  pendingLayouts.length = 0;
  return report;
}

const pendingLayouts: { key: string; brandId: string; name: string; page: string; folder: string | null; tile: LayoutTile }[] = [];

/** Stable JSON with sorted keys, so jsonb round-trips compare equal. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, val) => (val && typeof val === "object" && !Array.isArray(val) ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : val));
}
function serialise(v: unknown): unknown {
  if (Array.isArray(v)) return v;
  if (v instanceof Date) return v.toISOString();
  return v;
}
function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  if (a instanceof Date) return b != null && new Date(b as string).getTime() === a.getTime();
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  return a === b;
}
function num(s: string, dflt: number): number {
  const n = Number(s);
  return s === "" || Number.isNaN(n) ? dflt : Math.trunc(n);
}
/**
 * An amount from a CSV cell in minor units of a currency with `exponent`
 * decimals: "16.00", "$16", "1,234.5" (exponent 2) → 1600, 1600, 123450;
 * "1600c" is already in minor units. Null for text that is not an amount or
 * has more decimals than the currency. CSV files use "." for decimals.
 */
export function minorUnits(s: string, exponent: number): number | null {
  let t = s.replace(/[\p{Sc}\s]/gu, "");
  if (t === "") return null;
  if (/^\d+c$/i.test(t)) return Number(t.slice(0, -1));
  // A comma only ever groups thousands: "16,50" is refused, not read as 1650.
  const [whole = "", ...rest] = t.split(".");
  if (whole.includes(",")) {
    if (!/^\d{1,3}(,\d{3})+$/.test(whole)) return null;
    t = [whole.replaceAll(",", ""), ...rest].join(".");
  }
  const m = /^(\d+)(?:\.(\d*))?$/.exec(t);
  if (!m) return null;
  const fraction = m[2] ?? "";
  if (fraction.length > exponent) return null;
  return Number(m[1]! + fraction.padEnd(exponent, "0"));
}
function bool(s: string): boolean {
  return /^(1|true|yes|y|t)$/i.test(s.trim());
}
function initialsFor(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
}
function accessLevel(s: string): LayoutTile["access_level"] {
  const v = s.toLowerCase();
  if (v.startsWith("cash")) return "cashier";
  if (v.startsWith("man")) return "manager";
  if (v.startsWith("adm")) return "admin";
  return "everyone";
}
/** Map a legacy colour (name or hex) to the nearest curated tile colour. */
export function mapColour(input: string, overrides?: Record<string, string>): LayoutTile["color"] {
  const v = input.trim().toLowerCase();
  if (!v) return "stone";
  if (overrides?.[v] && (TILE_COLOURS as readonly string[]).includes(overrides[v]!)) return overrides[v] as LayoutTile["color"];
  if ((TILE_COLOURS as readonly string[]).includes(v)) return v as LayoutTile["color"];
  const hex = v.startsWith("#") ? v.slice(1) : /^[0-9a-f]{6}$/.test(v) ? v : null;
  if (!hex || hex.length !== 6) {
    const byName: Record<string, LayoutTile["color"]> = { red: "brick", orange: "amber", yellow: "brass", green: "sage", blue: "sky", purple: "plum", pink: "rose", grey: "stone", gray: "stone", brown: "brass", teal: "teal", navy: "indigo", white: "stone", black: "slate" };
    return byName[v] ?? "stone";
  }
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const anchors: Record<LayoutTile["color"], [number, number, number]> = { slate: [60, 65, 75], stone: [150, 140, 128], brass: [181, 140, 60], amber: [220, 150, 40], olive: [120, 125, 60], sage: [120, 160, 120], teal: [40, 140, 140], sky: [80, 150, 220], indigo: [70, 70, 170], plum: [130, 70, 140], rose: [220, 110, 150], brick: [190, 60, 50] };
  let best: LayoutTile["color"] = "stone";
  let bestD = Infinity;
  for (const [name, [ar, ag, ab]] of Object.entries(anchors) as [LayoutTile["color"], [number, number, number]][]) {
    const d = (r - ar) ** 2 + (g - ag) ** 2 + (b - ab) ** 2;
    if (d < bestD) {
      bestD = d;
      best = name;
    }
  }
  return best;
}
