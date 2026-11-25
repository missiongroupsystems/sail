import { currencyExponent, MAX_AMOUNT, toE164 } from "@sail/shared";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ROLES } from "@sail/shared";
import { db, withTransaction, type RequestTx } from "../db/client.js";
import { importJobs, staff, type ImportEntity, type ImportMapping, type ImportReport } from "../db/schema/index.js";
import { hashSecret, pinLookup } from "../auth/tokens.js";
import { parseCsv } from "./csv.js";
import { TILE_COLOURS } from "../routes/floor.js";
import type { LayoutPage, LayoutTile } from "../db/schema/catalogue.js";
import { logger } from "../logger.js";
import { PIN_TAKEN_LIMITS, returnPinAttempt, takePinAttempt } from "./pin-attempts.js";
import { endBackofficeAccess } from "./staff-access.js";
import { recordAudit } from "../lib/audit.js";
import { appendEvent } from "../lib/events.js";
import type { Principal } from "../auth/principal.js";

/**
 * Why the database refused a row, said as the API says it (app.ts): never a constraint, a key value or row-level
 * security. A refusal written for people (SL400) keeps its message; an error raised by the importer itself is kept.
 */
export function rowRefusal(e: unknown): string {
  const pg = e as { code?: unknown; message?: string; constraint_name?: string; detail?: string };
  if (typeof pg.code !== "string" || !/^[0-9A-Z]{5}$/.test(pg.code) || !(e instanceof Error) || e.name !== "PostgresError") return (e as Error).message;
  // A syntax error is a fault in the importer, not in the row: it fails the job loudly instead of rejecting the row.
  if (pg.code === "42601") throw e;
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
/** At most this many updated ids per entity go in the audit entry; the entry also gives the total. */
const AUDIT_IDS_PER_ENTITY = 100;
/** A row the import created or updated (an update only counts when something changed). */
type Touched = { entity: string; id: string; created: boolean; outletId?: string };

/**
 * A value for a column the file does not have (not mapped, or mapped to a header the file lacks, and no `defaults`
 * value): written when the row creates a record, left as stored when it updates one. A blank cell in a column the
 * file has is not this: it clears the field or sets its default.
 */
class OnCreate {
  constructor(readonly value: unknown) {}
}
const valueOnCreate = (v: unknown) => (v instanceof OnCreate ? v.value : v);

export async function runQueuedImports(): Promise<number> {
  const jobs = await withTransaction((t) => t.db.select({ id: importJobs.id }).from(importJobs).where(eq(importJobs.status, "queued")).orderBy(importJobs.createdAt));
  // One failed job (already logged and marked failed) does not hold up the others.
  for (const j of jobs) await runImportJob(j.id).catch(() => undefined);
  return jobs.length;
}

export async function runImportJob(jobId: string): Promise<ImportReport> {
  const job = await withTransaction(async (t) => {
    const [row] = await t.db.update(importJobs).set({ status: "running", startedAt: new Date() }).where(and(eq(importJobs.id, jobId), eq(importJobs.status, "queued"))).returning();
    return row;
  });
  if (!job) throw new Error(`import job ${jobId} is not queued`);
  // Filled as the rows run, so a failed job keeps the counts and refusals it reached.
  const report: ImportReport = { entities: {}, warnings: [] };
  try {
    try {
      await withTransaction(async (t) => {
        const touched: Touched[] = [];
        await importInto(t, job.merchantId, job.mapping, job.files, { actorId: job.createdBy, dryRun: job.dryRun, report, touched });
        if (job.dryRun) throw new DryRunRollback();
        await recordImport(job, report, touched);
      });
    } catch (e) {
      if (!(e instanceof DryRunRollback)) throw e;
    }
    await withTransaction((t) => t.db.update(importJobs).set({ status: job.dryRun ? "dry_run_complete" : "applied", report, finishedAt: new Date() }).where(eq(importJobs.id, jobId)));
    return report;
  } catch (e) {
    // The API shows the job's error: the database's own words stay in the log.
    logger.error({ err: e, jobId }, "import failed");
    // Everything the job wrote was rolled back, so it reports nothing applied; the refused rows it reached stay listed.
    const rolledBack: ImportReport = { entities: Object.fromEntries(Object.entries(report.entities).map(([e, r]) => [e, { ...r, creates: 0, updates: 0, unchanged: 0 }])), warnings: report.warnings };
    await withTransaction((t) => t.db.update(importJobs).set({ status: "failed", error: "The import stopped on an unexpected error. Nothing was changed.", report: rolledBack, finishedAt: new Date() }).where(eq(importJobs.id, jobId)));
    throw e;
  }
}

/**
 * The audit log gets one entry per applied import (counts per entity and the ids it updated, at most
 * AUDIT_IDS_PER_ENTITY of them with the total), in the import's transaction, instead of one per row. Tables and
 * areas also get the events the POS floor refreshes on.
 */
async function recordImport(job: typeof importJobs.$inferSelect, report: ImportReport, touched: Touched[]) {
  const [by] = job.createdBy ? await db().select({ id: staff.id, name: staff.name, role: staff.role }).from(staff).where(eq(staff.id, job.createdBy)).limit(1) : [];
  if (!by) throw new Error(`import job ${job.id} has no Admin who queued it`);
  const p: Principal = { type: "staff", id: by.id, merchantId: job.merchantId, role: by.role, name: by.name, outletIds: [], brandIds: [], riskCeiling: null, via: "backoffice" };
  const entities = Object.fromEntries(
    Object.entries(report.entities).map(([e, r]) => {
      const updated = touched.filter((x) => x.entity === e && !x.created).map((x) => x.id);
      return [e, { creates: r.creates, updates: r.updates, unchanged: r.unchanged, rejected: r.rejected.length, updated_ids: updated.slice(0, AUDIT_IDS_PER_ENTITY), updated_ids_total: updated.length }];
    }),
  );
  await recordAudit(p, { action: "imports.applied", targetKind: "import_job", targetId: job.id, details: { entities } });
  for (const x of touched) {
    if (!x.outletId || (x.entity !== "tables" && x.entity !== "areas")) continue;
    const kind = x.entity === "tables" ? "table" : "area";
    await appendEvent({ merchantId: job.merchantId, outletId: x.outletId, type: `${kind}.${x.created ? "created" : "updated"}`, aggregate: { kind, id: x.id }, operationId: "imports.apply", payload: { import_job_id: job.id }, correlationId: job.id }, p);
  }
}

/** Run an import for a merchant inside the given transaction. Exposed for tests. */
export async function importInto(t: RequestTx, merchantId: string, mapping: ImportMapping, files: Record<string, string>, opts: { actorId?: string | null; dryRun?: boolean; report?: ImportReport; touched?: Touched[] } = {}): Promise<ImportReport> {
  const report: ImportReport = opts.report ?? { entities: {}, warnings: [] };
  const touched = opts.touched ?? [];
  const pendingLayouts: { key: string; brandId: string; name: string; page: string; folder: string | null; tile: LayoutTile }[] = [];
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
      /** The file gives this field: a column that is in the file, or a default in the mapping. */
      const mapped = (field: string) => (file.columns[field] != null && headers.includes(file.columns[field])) || file.defaults?.[field] != null;
      /** `value` when the file has this field's column; otherwise OnCreate(value), which an update leaves as stored. */
      const given = <T,>(field: string, value: T): T | OnCreate => (mapped(field) ? value : new OnCreate(value));
      /** The row's value for a field: `fallback` for a blank cell (it clears or sets the default), OnCreate when the file has no such column. */
      const opt = <T,>(row: Row, field: string, read: (v: string) => T, fallback: T): T | OnCreate => {
        const v = get(row, field);
        return given(field, v === "" ? fallback : read(v));
      };

      /**
       * Create the record, or update the columns the row gives that differ. A column whose value is OnCreate is written
       * on create only. `refuse` names why an existing record cannot take this row (a move the import does not make).
       */
      const upsert = async (table: string, legacyId: string, values: Record<string, unknown>, o: { match?: { column: string; value: string }; refuse?: (existing: Record<string, unknown>) => string | null; counted?: boolean } = {}) => {
        const matchBy = o.match ?? { column: "legacy_id", value: legacyId };
        const [existing] = await sql.unsafe<Record<string, unknown>[]>(`select * from ${table} where merchant_id = $1 and ${matchBy.column} = $2 limit 1`, [merchantId, matchBy.value]);
        const outletId = typeof values["outlet_id"] === "string" ? values["outlet_id"] : undefined;
        if (!existing) {
          const id = randomUUID();
          const cols = Object.keys(values);
          await sql.unsafe(`insert into ${table} (id, merchant_id, legacy_id, ${cols.join(", ")}) values ($1, $2, nullif($3, ''), ${cols.map((_, i) => `$${i + 4}`).join(", ")})`, [id, merchantId, legacyId, ...cols.map((c) => serialise(valueOnCreate(values[c])))] as never);
          rep.creates++;
          touched.push({ entity, id, created: true, outletId });
          return { id, created: true };
        }
        const id = existing["id"] as string;
        const refusal = o.refuse?.(existing);
        if (refusal) throw new Error(refusal);
        const changed = Object.keys(values).filter((c) => !(values[c] instanceof OnCreate) && !same(existing[c], values[c]));
        // `counted`: an update even with no column changed (a dry run's PIN, which is never compared).
        if (changed.length === 0 && (existing["legacy_id"] === legacyId || !legacyId) && !o.counted) {
          rep.unchanged++;
          return { id, created: false };
        }
        // An empty legacy id (a product matched on its Sail id) keeps the one stored.
        const sets = ["legacy_id = coalesce(nullif($3, ''), legacy_id)", ...changed.map((c, i) => `${c} = $${i + 4}`), ...(table === "products" || table === "customers" ? ["updated_at = now()"] : [])];
        await sql.unsafe(`update ${table} set ${sets.join(", ")} where id = $1 and merchant_id = $2`, [id, merchantId, legacyId, ...changed.map((c) => serialise(values[c]))] as never);
        rep.updates++;
        touched.push({ entity, id, created: false, outletId });
        return { id, created: false };
      };

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        // A row refused after it was written (a later check in its savepoint) is rolled back, so its counts go too.
        const before = { creates: rep.creates, updates: rep.updates, unchanged: rep.unchanged, touched: touched.length };
        // A row the database refuses (a third category level, a taken email) is rejected alone, not the whole import.
        try {
          await t.sql.savepoint(async (sp) => {
          sql = sp;
          switch (entity) {
            case "brands": {
              const lid = get(row, "legacy_id") || get(row, "name");
              const name = get(row, "name");
              if (!name) throw new Error("name is required");
              const { id } = await upsert("brands", lid, { name, accent_color: opt(row, "accent_color", (v) => v, null) });
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
              const { id } = await upsert("outlets", lid, { brand_id: brandId, name, ...Object.fromEntries(["address", "phone", "business_registration_no", "tax_registration_no", "business_day_cutoff"].map((f) => [f, opt(row, f, (v) => v, null)])) });
              legacy.outlets!.set(lid, id);
              break;
            }
            case "categories": {
              const lid = get(row, "legacy_id") || get(row, "name");
              const name = get(row, "name");
              if (!name) throw new Error("name is required");
              const parentKey = get(row, "parent_legacy_id");
              const parentId = parentKey ? ref("categories", parentKey) : given("parent_legacy_id", null);
              if (parentKey && !parentId) throw new Error(`parent category ${parentKey} not found (parents must come first)`);
              // A category under itself, or a third level, is refused by the database (0052) in words.
              const { id } = await upsert("report_categories", lid, { name, parent_id: parentId, sort: opt(row, "sort", (v) => num(v, 0), 0) });
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
              const categoryId = catKey ? check(() => refOrName("categories", catKey, "category"), null) : given("category_legacy_id", null);
              const brandKey = get(row, "brand_legacy_id") || mapping.options?.brand_legacy_id || "";
              const brandId = brandKey ? check(() => refOrName("brands", brandKey, "brand"), null) : given("brand_legacy_id", null);
              const kindCell = get(row, "kind");
              // A legacy "Item" is a product and a "Modifier" a component; any other word is refused, never guessed.
              if (kindCell && !/^(product|item|component|modifier)$/i.test(kindCell)) errors.push(`kind "${kindCell}" is not product or component`);
              const kind = /^(component|modifier)$/i.test(kindCell) ? "component" : "product";
              const className = get(row, "tax_class");
              // A blank class is the merchant's default class (null); a file without the column leaves it alone.
              const taxClassId = className ? taxClasses.get(className.toLowerCase()) : given("tax_class", null);
              if (taxClassId === undefined) errors.push(`tax class "${className}" not found`);
              // Read the per-order-type prices first, so a bad one refuses the row before anything is written.
              const prices = (["dine_in", "takeaway", "pickup", "delivery"] as const).flatMap((ot) => {
                const v = get(row, `price_${ot}`);
                // A blank cell in a mapped column is "no price for that order type"; an unmapped column leaves it alone.
                if (!v) return mapped(`price_${ot}`) ? [{ ot, price: null as number | null }] : [];
                return check(() => [{ ot, price: amountCell(`price_${ot}`, v) as number | null }], []);
              });
              if (errors.length) throw new Error(errors.join("; "));
              const text = (f: string) => opt(row, f, (v) => v, null);
              const values = { name, sku: given("sku", sku), description: text("description"), price: priceCents, category_id: categoryId, brand_id: brandId, tags: opt(row, "tags", (v) => v.split(/[;|]/).map((s) => s.trim()).filter(Boolean), []), has_deposit: opt(row, "has_deposit", bool, false), tax_class_id: taxClassId, open_price: opt(row, "open_price", bool, false), kind: given("kind", kind), kitchen_name: text("kitchen_name"), archived_at: opt(row, "archived", (v) => (bool(v) ? new Date().toISOString() : null), null) };
              const [bySailId] = sailId ? await sql<{ id: string }[]>`select id from products where merchant_id = ${merchantId} and id = ${sailId} limit 1` : [];
              // A Sail id from another business or database names nothing here: without a SKU or legacy id the row would
              // create a new copy on every run, so it is refused instead.
              if (sailId && !bySailId && !lid) throw new Error(`sail_id ${sailId} is not a product of this business: give the row a sku or legacy_id`);
              const match = bySailId ? { column: "id", value: bySailId.id } : sku && !get(row, "legacy_id") ? { column: "sku", value: sku } : { column: "legacy_id", value: lid };
              const unchangedBefore = rep.unchanged;
              // Matched on its Sail id, a product keeps the legacy id it has unless the row gives one (its SKU is not one).
              const { id, created } = await upsert("products", bySailId ? get(row, "legacy_id") : lid, values, { match });
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
                touched.push({ entity, id, created: false });
              }
              break;
            }
            case "modifier_groups": {
              const lid = get(row, "legacy_id") || get(row, "name");
              const name = get(row, "name");
              if (!name) throw new Error("name is required");
              const { id } = await upsert("modifier_groups", lid, { name, min_select: opt(row, "min_select", (v) => num(v, 0), 0), max_select: opt(row, "max_select", (v) => num(v, 1), null), max_per_modifier: opt(row, "max_per_modifier", (v) => num(v, 1), 1) });
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
              } else {
                // A column the file does not have keeps what is stored.
                const next = { price_override: mapped("price_override") ? override : existing.price_override, child_group_id: mapped("child_group_legacy_id") ? childId : existing.child_group_id, sort: mapped("sort") ? sort : existing.sort };
                if (existing.price_override !== next.price_override || existing.child_group_id !== next.child_group_id || existing.sort !== next.sort) {
                  await sql`update modifier_options set price_override = ${next.price_override}, child_group_id = ${next.child_group_id}, sort = ${next.sort} where id = ${existing.id}`;
                  rep.updates++;
                } else rep.unchanged++;
              }
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
              // Channel links carry the menu's brand, and the back office never moves a menu to another brand.
              const { id } = await upsert("menus", lid, { name, brand_id: brandId }, { refuse: (m) => (m["brand_id"] !== brandId ? "a menu's brand cannot be changed by an import" : null) });
              legacy.menus!.set(lid, id);
              break;
            }
            case "menu_sections": {
              const lid = get(row, "legacy_id") || `${get(row, "menu_legacy_id")}/${get(row, "name")}`;
              const menuId = ref("menus", get(row, "menu_legacy_id"));
              if (!menuId) throw new Error(`menu ${get(row, "menu_legacy_id")} not found`);
              const parentKey = get(row, "parent_legacy_id");
              const parentId = parentKey ? ref("menu_sections", parentKey) : given("parent_legacy_id", null);
              if (parentKey && !parentId) throw new Error(`parent section ${parentKey} not found`);
              const name = get(row, "name");
              if (!name) throw new Error("name is required");
              // Menu items carry their section's menu, so a section stays in its menu.
              const { id } = await upsert("menu_sections", lid, { menu_id: menuId, parent_id: parentId, name, sort: opt(row, "sort", (v) => num(v, i), i) }, { refuse: (s) => (s["menu_id"] !== menuId ? "a section's menu cannot be changed by an import" : null) });
              // Sections nest one level, as categories do (0052): never under itself, under a sub-section, or with its own.
              if (typeof parentId === "string") {
                if (parentId === id) throw new Error("A section cannot sit under itself");
                const [nesting] = await sql<{ parent_nested: boolean; has_children: boolean }[]>`select exists (select 1 from menu_sections where id = ${parentId} and parent_id is not null) as parent_nested, exists (select 1 from menu_sections where parent_id = ${id}) as has_children`;
                if (nesting!.parent_nested) throw new Error("A section can only sit under a top-level section");
                if (nesting!.has_children) throw new Error("A section with sub-sections cannot sit under another one");
              }
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
              const [existing] = await sql<{ sort: number }[]>`select sort from menu_items where section_id = ${sectionId} and product_id = ${productId}`;
              // A file without a sort column keeps the stored order.
              const sort = existing && !mapped("sort") ? existing.sort : num(get(row, "sort"), i);
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
              // An area's tables carry its outlet, and the back office never moves an area to another outlet.
              const { id } = await upsert("areas", lid, { outlet_id: outletId, name, sort: opt(row, "sort", (v) => num(v, i), i) }, { refuse: (a) => (a["outlet_id"] !== outletId ? "an area's outlet cannot be changed by an import" : null) });
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
              const { id } = await upsert("tables", lid, { outlet_id: area!.outlet_id, area_id: areaId, name, seats: opt(row, "seats", (v) => num(v, 4), 4), shape: opt(row, "shape", (v) => v, "rect"), x: opt(row, "x", (v) => num(v, 0), 0), y: opt(row, "y", (v) => num(v, 0), 0), w: opt(row, "w", (v) => num(v, 2), 2), h: opt(row, "h", (v) => num(v, 2), 2) }, { refuse: (x) => (x["outlet_id"] !== area!.outlet_id ? "a table's outlet cannot be changed by an import" : null) });
              legacy.tables!.set(lid, id);
              break;
            }
            case "tender_types": {
              const lid = get(row, "legacy_id") || get(row, "name");
              const name = get(row, "name");
              if (!name) throw new Error("name is required");
              const isCash = opt(row, "is_cash", bool, false);
              const isTerminal = opt(row, "is_terminal", bool, false);
              // Cash opens the drawer. A new house account (neither cash nor a card terminal) needs a Manager's approval,
              // as when created by hand; after that, approval is set in Settings only.
              const opensDrawer = opt(row, "opens_drawer", (v) => bool(v) || isCash === true, valueOnCreate(isCash));
              const { id } = await upsert("tender_types", lid, { name, is_cash: isCash, opens_drawer: opensDrawer, is_terminal: isTerminal, requires_approval: new OnCreate(!valueOnCreate(isCash) && !valueOnCreate(isTerminal)), sort: opt(row, "sort", (v) => num(v, i), i) });
              legacy.tender_types!.set(lid, id);
              break;
            }
            case "void_reasons": {
              const lid = get(row, "legacy_id") || get(row, "name");
              const name = get(row, "name");
              if (!name) throw new Error("name is required");
              const { id } = await upsert("void_reasons", lid, { name, for_refunds: opt(row, "for_refunds", bool, true), sort: opt(row, "sort", (v) => num(v, i), i) });
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
              const [there] = await sql<{ id: string; role: string; active: boolean; pin_lookup: string | null }[]>`select id, role, active, pin_lookup from staff where merchant_id = ${merchantId} and legacy_id = ${lid} limit 1`;
              // No outlets is every outlet, as on the Team page: a blank cell gives that; a file without the column keeps
              // the outlets they have. Initials are made from the name once and then belong to the Team page.
              const values: Record<string, unknown> = { name, email: opt(row, "email", (v) => v.toLowerCase(), null), role, outlet_ids: given("outlet_legacy_ids", outletIds as string[]), initials: new OnCreate(initialsFor(name)), active: opt(row, "active", bool, true) };
              const lookup = pin ? pinLookup(merchantId, pin) : null;
              // A dry run never compares a PIN with anyone's (its own or a colleague's), so its report cannot tell whether
              // a guessed PIN is in use: a PIN cell is always "would set it". The applied import checks and writes it.
              const pinInDryRun = !!lookup && !!opts.dryRun;
              if (lookup && !opts.dryRun && lookup !== there?.pin_lookup) {
                // A taken PIN is refused, and finding taken PINs is limited per person as in the staff form, so a dry
                // run of many rows cannot list colleagues' PINs. The count commits on its own, dry run or not.
                const scope = `pin_taken:${opts.actorId ? `staff:${opts.actorId}` : "import"}`;
                await takePinAttempt(merchantId, scope, PIN_TAKEN_LIMITS);
                const [holder] = await sql<{ id: string }[]>`select id from staff where merchant_id = ${merchantId} and pin_lookup = ${lookup} and legacy_id is distinct from ${lid} limit 1`;
                if (holder) throw new Error("Someone at this business already uses that PIN");
                await returnPinAttempt(merchantId, scope);
                // A new PIN starts with no failed attempts, as on the Team page.
                Object.assign(values, { pin_hash: hashSecret(pin), pin_lookup: lookup, pin_failed_attempts: 0, pin_locked_until: null });
              }
              const email = values["email"];
              if (typeof email === "string") {
                const [taken] = await sql<{ id: string }[]>`select id from staff where merchant_id = ${merchantId} and lower(email) = ${email} and legacy_id is distinct from ${lid} limit 1`;
                if (taken) throw new Error(`email ${email} is already used by another staff member`);
              }
              // The Team page's guards: an Admin does not lower their own role.
              if (there && there.id === opts.actorId && role !== "admin") throw new Error("You cannot lower your own role: ask another Admin to change it");
              const { id } = await upsert("staff", lid, values, { counted: pinInDryRun });
              legacy.staff!.set(lid, id);
              if (there?.role === "admin" && (role !== "admin" || values["active"] === false)) {
                const [admins] = await sql<{ n: number }[]>`select count(*)::int as n from staff where merchant_id = ${merchantId} and role = 'admin' and active`;
                if (admins!.n === 0) throw new Error("This would leave the business with no active Admin");
              }
              // Deactivating ends back-office sessions and open sign-in links, as on the Team page.
              if (there?.active && values["active"] === false) await endBackofficeAccess(id);
              break;
            }
            case "customers": {
              // Stored in E.164, with the merchant's country for a national number, as every other customer write.
              const mobile = get(row, "mobile").trim() ? toE164(get(row, "mobile"), settings?.locale) : null;
              const lid = get(row, "legacy_id") || mobile || "";
              const name = get(row, "name");
              if (!name) throw new Error("name is required");
              if (!lid) throw new Error("mobile or legacy_id is required");
              const { id } = await upsert("customers", lid, { name, mobile: given("mobile", mobile), email: opt(row, "email", (v) => v, null), marketing_consent: opt(row, "marketing_consent", bool, false) }, { match: mobile && !get(row, "legacy_id") ? { column: "mobile", value: mobile } : { column: "legacy_id", value: lid } });
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
          const reason = rowRefusal(e);
          Object.assign(rep, { creates: before.creates, updates: before.updates, unchanged: before.unchanged });
          touched.length = before.touched;
          reject(i, reason, row);
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
  return report;
}

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
