import type { OpenAPIHono } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { PERMISSIONS, registerOperations, type OperationSpec } from "@sail/shared";
import { db } from "../db/client.js";
import { outlets, shifts } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import type { AppEnv } from "../lib/context.js";
import { dataResponse, defineOp, errorResponses, jsonResponse, z } from "../lib/openapi.js";
import { principalCanSeeOutlet } from "../auth/principal.js";
import { businessDateFor } from "../lib/time.js";
import { businessDayInputs } from "./org.js";
import { dailySummaryPdf, exceptions, printHealth, productMix, rowsCsv, salesSummary, salesSummaryCsv, type ReportFilters } from "../services/reports.js";
import { zReport } from "../services/shifts.js";

const op = (o: Partial<OperationSpec> & { op: string; summary: string; description: string }): OperationSpec => ({ tier: "T0", ...PERMISSIONS["reports.run"], reasonRequired: false, dryRun: false, principals: ["staff", "agent"], emits: [], mcp: { expose: true, toolsets: ["reports"] }, ...o });

registerOperations({
  "reports.sales_summary": op({ op: "reports.sales_summary", summary: "Sales summary", description: "Totals and breakdowns (by day, order type, source, tender, category, rule and reporting class, voids, refunds) for a date range with filters for outlet, brand, station, shift, source, order type, staff and category. `format=csv` returns CSV. Every figure is a sum of register-written cents." }),
  "reports.product_mix": op({ op: "reports.product_mix", summary: "Product mix", description: "Quantity, gross, discounts and net by item, category or staff member, with share of net in basis points." }),
  "reports.exceptions": op({ op: "reports.exceptions", summary: "Void, discount and refund report", description: "Who voided, discounted or refunded, who approved, the reason and the rule applied." }),
  "reports.print_health": op({ op: "reports.print_health", summary: "Print health", description: "Jobs, printed, failed, rerouted, reprinted and late counts with p50/p95 fire-to-printed seconds by printer and relay." }),
  "reports.daily": op({ op: "reports.daily", summary: "Daily outlet report", description: "The Z-report plus breakdowns for one outlet and business date; `.pdf` for the printable summary." }),
});

const Filters = z.object({
  outlet_id: z.uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  brand_id: z.uuid().optional(),
  station_id: z.uuid().optional(),
  shift_id: z.uuid().optional(),
  source: z.enum(["pos", "scan_to_order"]).optional(),
  order_type: z.enum(["dine_in", "takeaway", "pickup", "delivery"]).optional(),
  staff_id: z.uuid().optional(),
  category_id: z.uuid().optional(),
  format: z.enum(["json", "csv"]).default("json"),
});

async function filtersFrom(p: { merchantId: string; type: string }, q: z.infer<typeof Filters>, principal: Parameters<typeof principalCanSeeOutlet>[0]): Promise<ReportFilters> {
  if (q.outlet_id && !principalCanSeeOutlet(principal, q.outlet_id)) throw AppError.notFound("outlet", q.outlet_id);
  const bd = await businessDayInputs(p.merchantId, q.outlet_id ?? null);
  const today = businessDateFor(new Date(), bd.cutoff, bd.timeZone);
  return { merchantId: p.merchantId, outletId: q.outlet_id ?? null, from: q.from ?? today, to: q.to ?? q.from ?? today, brandId: q.brand_id ?? null, stationId: q.station_id ?? null, shiftId: q.shift_id ?? null, source: q.source ?? null, orderType: q.order_type ?? null, staffId: q.staff_id ?? null, categoryId: q.category_id ?? null };
}

const Any = z.record(z.string(), z.unknown());

export function reportRoutes(app: OpenAPIHono<AppEnv>) {
  defineOp(app, { op: "reports.sales_summary", method: "get", path: "/v1/reports/sales-summary", tags: ["reports"], request: { query: Filters }, responses: { 200: { description: "Report (JSON or CSV)", content: { "application/json": { schema: dataResponse(Any) }, "text/csv": { schema: z.string() } } }, ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const q = c.req.valid("query");
    const s = await salesSummary(await filtersFrom(p, q, p));
    if (q.format === "csv") return c.body(salesSummaryCsv(s), 200, { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="sales-summary.csv"' });
    return c.json({ data: s }, 200);
  });

  defineOp(app, { op: "reports.product_mix", method: "get", path: "/v1/reports/product-mix", tags: ["reports"], request: { query: Filters.extend({ group_by: z.enum(["item", "category", "staff"]).default("item") }) }, responses: { 200: { description: "Report (JSON or CSV)", content: { "application/json": { schema: dataResponse(z.array(Any)) }, "text/csv": { schema: z.string() } } }, ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const q = c.req.valid("query");
    const rows = await productMix(await filtersFrom(p, q, p), q.group_by);
    if (q.format === "csv") return c.body(rowsCsv(rows), 200, { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="product-mix.csv"' });
    return c.json({ data: rows }, 200);
  });

  defineOp(app, { op: "reports.exceptions", method: "get", path: "/v1/reports/exceptions", tags: ["reports"], request: { query: Filters }, responses: { 200: { description: "Report (JSON or CSV)", content: { "application/json": { schema: dataResponse(Any) }, "text/csv": { schema: z.string() } } }, ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const q = c.req.valid("query");
    const r = await exceptions(await filtersFrom(p, q, p));
    if (q.format === "csv") return c.body([rowsCsv(r.voids.map((v) => ({ section: "void", ...v }))), rowsCsv(r.discounts.map((d) => ({ section: "discount", ...d }))), rowsCsv(r.refunds.map((x) => ({ section: "refund", ...x })))].filter(Boolean).join("\r\n"), 200, { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="exceptions.csv"' });
    return c.json({ data: r }, 200);
  });

  defineOp(app, { op: "reports.print_health", method: "get", path: "/v1/reports/print-health", tags: ["reports"], request: { query: Filters.pick({ outlet_id: true, from: true, to: true, format: true }) }, responses: { 200: { description: "Report (JSON or CSV)", content: { "application/json": { schema: dataResponse(z.array(Any)) }, "text/csv": { schema: z.string() } } }, ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const q = c.req.valid("query");
    const f = await filtersFrom(p, q, p);
    const rows = await printHealth(f);
    if (q.format === "csv") return c.body(rowsCsv(rows), 200, { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="print-health.csv"' });
    return c.json({ data: rows }, 200);
  });

  const daily = async (p: AppEnv["Variables"]["principal"], outletId: string, businessDate: string | undefined) => {
    if (!principalCanSeeOutlet(p, outletId)) throw AppError.notFound("outlet", outletId);
    const [outlet] = await db().select().from(outlets).where(eq(outlets.id, outletId)).limit(1);
    if (!outlet) throw AppError.notFound("outlet", outletId);
    const bd = await businessDayInputs(p.merchantId, outletId);
    const date = businessDate ?? businessDateFor(new Date(), bd.cutoff, bd.timeZone);
    const dayShifts = await db().select().from(shifts).where(and(eq(shifts.outletId, outletId), eq(shifts.businessDate, date)));
    const float = dayShifts.reduce((s, x) => s + x.floatCents, 0);
    const closed = dayShifts.filter((x) => x.status === "closed");
    const counted = closed.reduce((s, x) => s + (x.countedCashCents ?? 0), 0);
    const z = await zReport({ outletId, businessDate: date }, { float, counted: closed.length ? counted : null });
    const summary = await salesSummary({ merchantId: p.merchantId, outletId, from: date, to: date });
    return { outlet, date, z, summary };
  };

  defineOp(app, { op: "reports.daily", method: "get", path: "/v1/outlets/{id}/reports/daily", tags: ["reports"], request: { params: z.object({ id: z.uuid() }), query: z.object({ business_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), format: z.enum(["json", "pdf"]).default("json") }) }, responses: { 200: { description: "Daily outlet report (JSON or PDF)", content: { "application/json": { schema: dataResponse(Any) }, "application/pdf": { schema: z.string() } } }, ...errorResponses } }, async (c) => {
    const p = c.get("principal");
    const { id } = c.req.valid("param");
    const q = c.req.valid("query");
    const { outlet, date, z, summary } = await daily(p, id, q.business_date);
    if (q.format === "pdf") {
      const pdf = await dailySummaryPdf({ outletName: outlet.name, businessDate: date, z, summary });
      return c.body(pdf as unknown as ArrayBuffer, 200, { "content-type": "application/pdf", "content-disposition": `inline; filename="daily-${date}.pdf"` });
    }
    return c.json({ data: { outlet: { id: outlet.id, name: outlet.name }, business_date: date, z_report: z, summary } }, 200);
  });
}
