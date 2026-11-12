import type { OpenAPIHono } from "@hono/zod-openapi";
import { and, desc, eq, isNull } from "drizzle-orm";
import { currencyExponent, registerOperations } from "@sail/shared";
import { db } from "../db/client.js";
import { importJobs, merchantSettings, products, reportCategories, taxClasses, type ImportEntity } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import type { AppEnv } from "../lib/context.js";
import { dataResponse, defineOp, errorResponses, jsonBody, jsonResponse, listResponse, mutationResponse, z, untrusted } from "../lib/openapi.js";
import { appendEvent } from "../lib/events.js";
import { recordAudit } from "../lib/audit.js";
import { toCsv } from "../services/csv.js";

registerOperations({
  "imports.create": { op: "imports.create", summary: "Upload legacy CSV files and queue an import", description: "Queues a dry run by default: the worker produces a report of creates, updates, unchanged and rejected rows (with reasons) without changing data. Apply it with imports.apply. Records match on legacy_id or SKU, so re-runs update instead of duplicating.", tier: "T1", minRole: "admin", overrideAllowed: false, reasonRequired: false, dryRun: true, principals: ["staff", "agent"], emits: ["import.queued"], mcp: { expose: true, toolsets: ["config.author"] } },
  "imports.list": { op: "imports.list", summary: "List import jobs", tier: "T0", minRole: "admin", overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff", "agent"], emits: [], description: "Import jobs with status and report summary.", mcp: { expose: true, toolsets: ["config.author"] } },
  "imports.get": { op: "imports.get", summary: "Get an import job with its full report", tier: "T0", minRole: "admin", overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff", "agent"], emits: [], description: "The full dry-run or apply report, including rejected rows and reasons.", mcp: { expose: true, toolsets: ["config.author"] } },
  "imports.apply": { op: "imports.apply", summary: "Apply a dry-run import", description: "Queues the same files and mapping for real. The approver must be a human Admin.", tier: "T3", minRole: "admin", overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff"], emits: ["import.queued"], mcp: { expose: false, toolsets: [] } },
  "exports.products_csv": { op: "exports.products_csv", summary: "Export products as CSV", description: "The catalogue in the importer's own column format, so an export can be edited and re-imported.", tier: "T0", minRole: "manager", overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff", "agent"], emits: [], mcp: { expose: false, toolsets: [] } },
});

const ENTITIES: [ImportEntity, ...ImportEntity[]] = ["brands", "outlets", "categories", "products", "modifier_groups", "modifier_options", "menus", "menu_sections", "menu_items", "areas", "tables", "tender_types", "void_reasons", "staff", "customers", "layouts"];
const MappingSchema = z.object({
  files: z.array(z.object({ name: z.string().min(1), entity: z.enum(ENTITIES), columns: z.record(z.string(), z.string()), defaults: z.record(z.string(), z.string()).optional() })).min(1),
  options: z.object({ brand_legacy_id: z.string().optional(), outlet_legacy_id: z.string().optional(), tile_colour_map: z.record(z.string(), z.string()).optional() }).optional(),
});
const ReportSchema = z.object({ entities: z.record(z.string(), z.object({ creates: z.number().int(), updates: z.number().int(), unchanged: z.number().int(), rejected: z.array(z.object({ row: z.number().int(), reason: untrusted(z.string()), data: z.record(z.string(), z.string()) })) })), warnings: z.array(z.string()) });
const JobSchema = z.object({ id: z.string(), status: z.enum(["queued", "running", "dry_run_complete", "applied", "failed"]), dry_run: z.boolean(), mapping: MappingSchema, file_names: z.array(z.string()), report: ReportSchema.nullable(), error: z.string().nullable(), created_by: z.string().nullable(), created_at: z.string(), finished_at: z.string().nullable() });

const toJob = (j: typeof importJobs.$inferSelect) => ({ id: j.id, status: j.status, dry_run: j.dryRun, mapping: j.mapping, file_names: Object.keys(j.files), report: j.report ?? null, error: j.error, created_by: j.createdBy, created_at: j.createdAt.toISOString(), finished_at: j.finishedAt?.toISOString() ?? null });

export function importRoutes(app: OpenAPIHono<AppEnv>) {
  defineOp(app, { op: "imports.create", method: "post", path: "/v1/imports", tags: ["imports"], request: { body: jsonBody(z.object({ mapping: MappingSchema, files: z.record(z.string(), z.string()), dry_run: z.boolean().default(true) })) }, responses: { 201: jsonResponse(mutationResponse(JobSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const b = c.req.valid("json");
    const total = Object.values(b.files).reduce((n, s) => n + s.length, 0);
    if (total > 25_000_000) throw AppError.validation("Uploaded files exceed 25 MB in total", { remedy: "Split the export into smaller files." });
    for (const f of b.mapping.files) if (b.files[f.name] == null) throw AppError.validation(`mapping names file "${f.name}" but it was not uploaded`);
    if (!b.dry_run && p.type !== "staff") throw new AppError("permission_denied", "Only a human Admin can apply an import", { remedy: "Queue a dry run and ask an Admin to apply it." });
    const [row] = await db().insert(importJobs).values({ merchantId: p.merchantId, dryRun: b.dry_run, mapping: b.mapping, files: b.files, createdBy: p.id }).returning();
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: null, type: "import.queued", aggregate: { kind: "import_job", id: row!.id }, operationId: "imports.create", payload: { dry_run: b.dry_run, files: Object.keys(b.files) }, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey") }, p);
    await recordAudit(p, { action: "imports.create", targetKind: "import_job", targetId: row!.id, details: { dry_run: b.dry_run, files: Object.keys(b.files) } });
    return c.json({ data: toJob(row!), events: [ev], warnings: [] }, 201);
  });

  defineOp(app, { op: "imports.list", method: "get", path: "/v1/imports", tags: ["imports"], responses: { 200: jsonResponse(listResponse(JobSchema.omit({ mapping: true }).extend({ report_summary: z.record(z.string(), z.object({ creates: z.number(), updates: z.number(), unchanged: z.number(), rejected: z.number() })).nullable() }))), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const rows = await db().select().from(importJobs).where(eq(importJobs.merchantId, p.merchantId)).orderBy(desc(importJobs.createdAt)).limit(100);
    return c.json(
      {
        data: rows.map((j) => {
          const { mapping: _m, ...rest } = toJob(j);
          return { ...rest, report: null, report_summary: j.report ? Object.fromEntries(Object.entries(j.report.entities).map(([k, v]) => [k, { creates: v.creates, updates: v.updates, unchanged: v.unchanged, rejected: v.rejected.length }])) : null };
        }),
        next_cursor: null,
      },
      200,
    );
  });

  defineOp(app, { op: "imports.get", method: "get", path: "/v1/imports/{id}", tags: ["imports"], request: { params: z.object({ id: z.uuid() }) }, responses: { 200: jsonResponse(dataResponse(JobSchema)), ...errorResponses } }, async (c) => {
    const { id } = c.req.valid("param");
    const [row] = await db().select().from(importJobs).where(eq(importJobs.id, id)).limit(1);
    if (!row) throw AppError.notFound("import job", id);
    return c.json({ data: toJob(row) }, 200);
  });

  defineOp(app, { op: "imports.apply", method: "post", path: "/v1/imports/{id}/apply", tags: ["imports"], request: { params: z.object({ id: z.uuid() }), body: jsonBody(z.object({}).passthrough()) }, responses: { 201: jsonResponse(mutationResponse(JobSchema)), ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const [src] = await db().select().from(importJobs).where(and(eq(importJobs.id, id), eq(importJobs.merchantId, p.merchantId))).limit(1);
    if (!src) throw AppError.notFound("import job", id);
    if (src.status !== "dry_run_complete") throw AppError.state(`import ${id} is ${src.status}; only a completed dry run can be applied`, ["dry_run_complete → applied"]);
    const [row] = await db().insert(importJobs).values({ merchantId: p.merchantId, dryRun: false, mapping: src.mapping, files: src.files, createdBy: p.id }).returning();
    const ev = await appendEvent({ merchantId: p.merchantId, outletId: null, type: "import.queued", aggregate: { kind: "import_job", id: row!.id }, operationId: "imports.apply", payload: { dry_run: false, from: id }, causationId: null, correlationId: c.get("correlationId"), idempotencyKey: c.get("idempotencyKey") }, p);
    await recordAudit(p, { action: "imports.apply", targetKind: "import_job", targetId: row!.id, details: { from_dry_run: id } });
    return c.json({ data: toJob(row!), events: [ev], warnings: [] }, 201);
  });

  defineOp(app, { op: "exports.products_csv", method: "get", path: "/v1/exports/products.csv", tags: ["imports"], responses: { 200: { description: "CSV", content: { "text/csv": { schema: z.string() } } }, ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const rows = await db().select().from(products).where(and(eq(products.merchantId, p.merchantId), isNull(products.archivedAt))).orderBy(products.name);
    const cats = await db().select().from(reportCategories).where(eq(reportCategories.merchantId, p.merchantId));
    const catLegacy = new Map(cats.map((x) => [x.id, x.legacyId ?? x.name]));
    const [settings] = await db().select({ currency: merchantSettings.currency }).from(merchantSettings).where(eq(merchantSettings.merchantId, p.merchantId)).limit(1);
    if (!settings) throw AppError.notFound("merchant settings");
    const exponent = currencyExponent(settings.currency);
    const classNames = new Map((await db().select({ id: taxClasses.id, name: taxClasses.name }).from(taxClasses).where(eq(taxClasses.merchantId, p.merchantId))).map((x) => [x.id, x.name]));
    const csv = toCsv(
      ["legacy_id", "sku", "name", "kind", "price", "category_legacy_id", "tags", "has_deposit", "tax_class", "open_price", "description", "kitchen_name"],
      rows.map((r) => [r.legacyId, r.sku, r.name, r.kind, decimal(r.price, exponent), r.categoryId ? (catLegacy.get(r.categoryId) ?? "") : "", r.tags.join(";"), r.hasDeposit ? "true" : "false", r.taxClassId ? (classNames.get(r.taxClassId) ?? "") : "", r.openPrice ? "true" : "false", r.description, r.kitchenName]),
    );
    return c.body(csv, 200, { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="products.csv"' });
  });
}

/** Minor units as a plain decimal for CSV, in the currency's decimals: 1600 → "16.00" (EUR), "1600" (JPY), "1.600" (KWD). */
function decimal(amount: number, exponent: number): string {
  if (exponent === 0) return String(amount);
  const sign = amount < 0 ? "-" : "";
  const digits = String(Math.abs(amount)).padStart(exponent + 1, "0");
  return `${sign}${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}
