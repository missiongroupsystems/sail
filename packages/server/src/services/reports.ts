import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { formatCents } from "@sail/shared";
import { tx } from "../db/client.js";
import { toCsv } from "./csv.js";
import type { ZReport } from "./shifts.js";

/**
 * Operational reports (scope doc 4.10) read from the `report_*` views. Every
 * figure is a sum of register-written cents; nothing here re-prices anything.
 */
export type ReportFilters = {
  merchantId: string;
  outletId?: string | null;
  from: string;
  to: string;
  brandId?: string | null;
  stationId?: string | null;
  shiftId?: string | null;
  source?: string | null;
  orderType?: string | null;
  staffId?: string | null;
  categoryId?: string | null;
};

type Frag = ReturnType<ReturnType<typeof tx>>;

function orderWhere(f: ReportFilters, alias = "r") {
  const sql = tx();
  return sql`${sql.unsafe(alias)}.merchant_id = ${f.merchantId}
    and ${sql.unsafe(alias)}.business_date between ${f.from} and ${f.to}
    ${f.outletId ? sql`and ${sql.unsafe(alias)}.outlet_id = ${f.outletId}` : sql``}
    ${f.brandId ? sql`and ${sql.unsafe(alias)}.brand_id = ${f.brandId}` : sql``}
    ${f.stationId ? sql`and ${sql.unsafe(alias)}.station_id = ${f.stationId}` : sql``}
    ${f.source ? sql`and ${sql.unsafe(alias)}.source = ${f.source}` : sql``}
    ${f.orderType ? sql`and ${sql.unsafe(alias)}.order_type = ${f.orderType}` : sql``}
    ${f.staffId ? sql`and ${sql.unsafe(alias)}.staff_id = ${f.staffId}` : sql``}` as unknown as Frag;
}

export type SalesSummary = {
  filters: ReportFilters;
  totals: { orders: number; covers: number; items: number; gross: number; discounts: number; fees: number; gst: number; net: number; refunds: number; net_after_refunds: number; rounding: number; tips: number };
  by_day: { business_date: string; orders: number; covers: number; gross: number; net: number }[];
  by_order_type: { order_type: string; orders: number; net: number }[];
  by_source: { source: string; orders: number; net: number }[];
  by_tender: { tender: string; is_cash: boolean; count: number; amount: number; rounding: number; tips: number }[];
  by_category: { category_id: string | null; category: string; quantity: number; gross: number; net: number }[];
  adjustments_by_rule: { rule_key: string; name: string; kind: string; report_class: string; count: number; total: number }[];
  adjustments_by_class: { report_class: string; kind: string; count: number; total: number }[];
  voids: { count: number; quantity: number; value: number };
  refunds: { count: number; amount: number; by_kind: { kind: string; count: number; amount: number }[] };
  generated_at: string;
};

export async function salesSummary(f: ReportFilters): Promise<SalesSummary> {
  const sql = tx();
  const w = orderWhere(f);
  const catFilter = f.categoryId ? sql`and (r.category_id = ${f.categoryId} or r.parent_category_id = ${f.categoryId})` : sql``;
  const [t] = await sql<{ orders: number; covers: number; gross: number; discounts: number; fees: number; gst: number; net: number }[]>`
    select count(*)::int as orders, coalesce(sum(pax),0)::int as covers, coalesce(sum(subtotal),0)::int as gross, coalesce(sum(discount_total),0)::int as discounts,
           coalesce(sum(fee_total),0)::int as fees, coalesce(sum(gst_total),0)::int as gst, coalesce(sum(total),0)::int as net
    from report_orders r where ${w}`;
  const [items] = await sql<{ n: number }[]>`select coalesce(sum(quantity),0)::int as n from report_sales_lines r where ${w} ${catFilter}`;
  const byDay = await sql<SalesSummary["by_day"]>`select business_date, count(*)::int as orders, coalesce(sum(pax),0)::int as covers, coalesce(sum(subtotal),0)::int as gross, coalesce(sum(total),0)::int as net from report_orders r where ${w} group by business_date order by business_date`;
  const byType = await sql<SalesSummary["by_order_type"]>`select order_type, count(*)::int as orders, coalesce(sum(total),0)::int as net from report_orders r where ${w} group by order_type order by order_type`;
  const bySource = await sql<SalesSummary["by_source"]>`select source, count(*)::int as orders, coalesce(sum(total),0)::int as net from report_orders r where ${w} group by source order by source`;
  const byTender = await sql<SalesSummary["by_tender"]>`select tender_name as tender, is_cash, count(*)::int as count, coalesce(sum(amount),0)::int as amount, coalesce(sum(rounding_cents),0)::int as rounding, coalesce(sum(tip_cents),0)::int as tips
    from report_payments r where ${w} and status = 'recorded' ${f.shiftId ? sql`and shift_id = ${f.shiftId}` : sql``} group by tender_name, is_cash order by amount desc`;
  const byCategory = await sql<SalesSummary["by_category"]>`select r.category_id, coalesce(c.name, 'Uncategorised') as category, coalesce(sum(r.quantity),0)::int as quantity, coalesce(sum(r.base_amount),0)::int as gross, coalesce(sum(r.net_amount),0)::int as net
    from report_sales_lines r left join report_categories c on c.id = r.category_id where ${w} ${catFilter} group by r.category_id, c.name order by net desc`;
  const byRule = await sql<SalesSummary["adjustments_by_rule"]>`select rule_key, name, kind, report_class, count(*)::int as count, coalesce(sum(total),0)::int as total from report_adjustments r where ${w} group by rule_key, name, kind, report_class order by kind, total`;
  const byClass = await sql<SalesSummary["adjustments_by_class"]>`select report_class, kind, count(*)::int as count, coalesce(sum(total),0)::int as total from report_adjustments r where ${w} group by report_class, kind order by kind, total`;
  const [voids] = await sql<{ count: number; quantity: number; value: number }[]>`select count(*)::int as count, coalesce(sum(quantity),0)::int as quantity, coalesce(sum(value),0)::int as value from report_voids r where ${w}`;
  const [refunds] = await sql<{ count: number; amount: number }[]>`select count(*)::int as count, coalesce(sum(total),0)::int as amount from report_refunds r where ${w}`;
  const refundKinds = await sql<{ kind: string; count: number; amount: number }[]>`select kind, count(*)::int as count, coalesce(sum(total),0)::int as amount from report_refunds r where ${w} group by kind order by kind`;
  const rounding = byTender.reduce((s, x) => s + x.rounding, 0);
  const tips = byTender.reduce((s, x) => s + x.tips, 0);
  return {
    filters: f,
    totals: { orders: t?.orders ?? 0, covers: t?.covers ?? 0, items: items?.n ?? 0, gross: t?.gross ?? 0, discounts: t?.discounts ?? 0, fees: t?.fees ?? 0, gst: t?.gst ?? 0, net: t?.net ?? 0, refunds: refunds?.amount ?? 0, net_after_refunds: (t?.net ?? 0) - (refunds?.amount ?? 0), rounding, tips },
    by_day: byDay,
    by_order_type: byType,
    by_source: bySource,
    by_tender: byTender,
    by_category: byCategory,
    adjustments_by_rule: byRule,
    adjustments_by_class: byClass,
    voids: voids ?? { count: 0, quantity: 0, value: 0 },
    refunds: { count: refunds?.count ?? 0, amount: refunds?.amount ?? 0, by_kind: refundKinds },
    generated_at: new Date().toISOString(),
  };
}

export type ProductMixRow = { key: string | null; name: string; quantity: number; gross: number; discounts: number; net: number; share_bps: number };

export async function productMix(f: ReportFilters, groupBy: "item" | "category" | "staff"): Promise<ProductMixRow[]> {
  const sql = tx();
  const w = orderWhere(f);
  const catFilter = f.categoryId ? sql`and (r.category_id = ${f.categoryId} or r.parent_category_id = ${f.categoryId})` : sql``;
  let rows: Omit<ProductMixRow, "share_bps">[];
  if (groupBy === "item") rows = await sql<Omit<ProductMixRow, "share_bps">[]>`select r.product_id::text as key, r.product_name as name, sum(r.quantity)::int as quantity, sum(r.base_amount)::int as gross, sum(r.discount_amount)::int as discounts, sum(r.net_amount)::int as net from report_sales_lines r where ${w} ${catFilter} group by r.product_id, r.product_name order by net desc`;
  else if (groupBy === "category") rows = await sql<Omit<ProductMixRow, "share_bps">[]>`select r.category_id::text as key, coalesce(c.name, 'Uncategorised') as name, sum(r.quantity)::int as quantity, sum(r.base_amount)::int as gross, sum(r.discount_amount)::int as discounts, sum(r.net_amount)::int as net from report_sales_lines r left join report_categories c on c.id = r.category_id where ${w} ${catFilter} group by r.category_id, c.name order by net desc`;
  else rows = await sql<Omit<ProductMixRow, "share_bps">[]>`select r.added_by::text as key, coalesce(r.added_by_name, 'Guest') as name, sum(r.quantity)::int as quantity, sum(r.base_amount)::int as gross, sum(r.discount_amount)::int as discounts, sum(r.net_amount)::int as net from report_sales_lines r where ${w} ${catFilter} group by r.added_by, r.added_by_name order by net desc`;
  const total = rows.reduce((s, r) => s + r.net, 0);
  return rows.map((r) => ({ ...r, share_bps: total ? Math.round((r.net * 10_000) / total) : 0 }));
}

export type ExceptionsReport = {
  voids: { order_no: string; business_date: string; product_name: string; quantity: number; value: number; after_firing: boolean; reason: string | null; voided_by: string | null; approved_by: string | null }[];
  discounts: { order_no: string; business_date: string; rule_key: string; name: string; report_class: string; total: number; entered_value: number | null; applied_by: string | null; approved_by: string | null; reason: string | null }[];
  refunds: { order_no: string; business_date: string; kind: string; total: number; reason: string; refunded_by: string | null; approved_by: string | null; refund_receipt_no: string; credit_note_no: string | null }[];
};

export async function exceptions(f: ReportFilters): Promise<ExceptionsReport> {
  const sql = tx();
  const w = orderWhere(f);
  const voids = await sql<ExceptionsReport["voids"]>`select r.order_no, r.business_date, r.product_name, r.quantity, r.value, r.after_firing, r.void_reason as reason, s1.name as voided_by, s2.name as approved_by
    from report_voids r left join staff s1 on s1.id = r.voided_by left join staff s2 on s2.id = r.void_approved_by where ${w} order by r.voided_at desc limit 1000`;
  const discounts = await sql<ExceptionsReport["discounts"]>`select r.order_no, r.business_date, r.rule_key, r.name, r.report_class, r.total, r.entered_value, s1.name as applied_by, s2.name as approved_by, r.reason
    from report_adjustments r left join staff s1 on s1.id::text = r.applied_by::text left join staff s2 on s2.id::text = r.approved_by::text where ${w} and r.kind = 'discount' and r.manual_application_id is not null order by r.business_date desc limit 1000`;
  const refunds = await sql<ExceptionsReport["refunds"]>`select order_no, business_date, kind, total, reason, refunded_by_name as refunded_by, approved_by_name as approved_by, refund_receipt_no, credit_note_no from report_refunds r where ${w} order by created_at desc limit 1000`;
  return { voids, discounts, refunds };
}

export type PrintHealthRow = { printer_id: string | null; printer_name: string | null; relay_id: string | null; jobs: number; printed: number; failed: number; rerouted: number; reprints: number; late: number; p50_seconds: number | null; p95_seconds: number | null };

export async function printHealth(f: Pick<ReportFilters, "merchantId" | "outletId" | "from" | "to">): Promise<PrintHealthRow[]> {
  const sql = tx();
  return sql<PrintHealthRow[]>`
    select printer_id::text, printer_name, relay_id::text, count(*)::int as jobs,
           count(*) filter (where status = 'printed')::int as printed,
           count(*) filter (where status = 'failed')::int as failed,
           count(*) filter (where status = 'rerouted')::int as rerouted,
           count(*) filter (where is_reprint)::int as reprints,
           count(*) filter (where seconds_to_print > 10 or (status in ('queued','claimed','failed') and created_at < now() - interval '10 seconds'))::int as late,
           percentile_cont(0.5) within group (order by seconds_to_print) as p50_seconds,
           percentile_cont(0.95) within group (order by seconds_to_print) as p95_seconds
    from report_print_jobs r
    where r.merchant_id = ${f.merchantId} ${f.outletId ? sql`and r.outlet_id = ${f.outletId}` : sql``} and r.created_date between ${f.from} and ${f.to}
    group by printer_id, printer_name, relay_id order by printer_name`;
}

/* ---- CSV ---- */

export function salesSummaryCsv(s: SalesSummary): string {
  const rows: (string | number | boolean | null)[][] = [];
  rows.push(["totals", "orders", s.totals.orders, "covers", s.totals.covers, "gross", s.totals.gross, "discounts", s.totals.discounts, "fees", s.totals.fees, "gst", s.totals.gst, "net", s.totals.net, "refunds", s.totals.refunds, "rounding", s.totals.rounding, "tips", s.totals.tips]);
  for (const d of s.by_day) rows.push(["by_day", d.business_date, d.orders, d.covers, d.gross, d.net]);
  for (const t of s.by_order_type) rows.push(["by_order_type", t.order_type, t.orders, t.net]);
  for (const t of s.by_source) rows.push(["by_source", t.source, t.orders, t.net]);
  for (const t of s.by_tender) rows.push(["by_tender", t.tender, t.is_cash, t.count, t.amount, t.rounding, t.tips]);
  for (const c of s.by_category) rows.push(["by_category", c.category, c.quantity, c.gross, c.net]);
  for (const a of s.adjustments_by_rule) rows.push(["adjustment", a.rule_key, a.name, a.kind, a.report_class, a.count, a.total]);
  rows.push(["voids", s.voids.count, s.voids.quantity, s.voids.value]);
  rows.push(["refunds", s.refunds.count, s.refunds.amount]);
  return toCsv(["section", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s"], rows);
}

export function rowsCsv<T extends Record<string, unknown>>(rows: T[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]!);
  return toCsv(headers, rows.map((r) => headers.map((h) => r[h] as string | number | boolean | null)));
}

/* ---- Daily summary PDF ---- */

export async function dailySummaryPdf(input: { outletName: string; businessDate: string; z: ZReport; summary: SalesSummary }): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Daily summary · ${input.outletName} · ${input.businessDate}`);
  const page = pdf.addPage([595.28, 841.89]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const safe = (s: string) => s.replace(/−/g, "-").replace(/[^ -~ -ÿ]/g, "?");
  let y = 790;
  const text = (s: string, x: number, size = 10, f = font) => page.drawText(safe(s), { x, y, size, font: f, color: rgb(0.11, 0.11, 0.12) });
  const right = (s: string, xRight: number, size = 10, f = font) => page.drawText(safe(s), { x: xRight - f.widthOfTextAtSize(safe(s), size), y, size, font: f, color: rgb(0.11, 0.11, 0.12) });
  const row = (label: string, value: string, f = font) => {
    text(label, 60, 10, f);
    right(value, 535, 10, f);
    y -= 14;
  };
  const section = (title: string) => {
    y -= 10;
    text(title, 48, 12, bold);
    y -= 16;
  };
  text(input.outletName, 48, 16, bold);
  right(`Daily summary · ${input.businessDate}`, 547, 11, font);
  y -= 24;
  section("Sales");
  row("Orders", String(input.z.orders.count));
  row("Covers", String(input.z.orders.covers));
  row("Gross sales", formatCents(input.z.sales.gross));
  row("Discounts", formatCents(input.z.sales.discounts));
  row("Fees", formatCents(input.z.sales.fees));
  row("GST", formatCents(input.z.sales.gst));
  row("Net sales", formatCents(input.z.sales.net), bold);
  row("Refunds", formatCents(-input.z.refunds.amount));
  section("Tenders");
  for (const t of input.z.tenders) row(`${t.tender} (${t.count})`, `${formatCents(t.amount)}${t.rounding ? ` · rounding ${formatCents(t.rounding)}` : ""}`);
  section("Cash");
  row("Float", formatCents(input.z.cash.float));
  row("Cash payments", formatCents(input.z.cash.cash_payments));
  row("Cash rounding", formatCents(input.z.cash.rounding));
  row("Cash refunds", formatCents(-input.z.cash.refunds));
  row("Expected", formatCents(input.z.cash.expected), bold);
  if (input.z.cash.counted != null) {
    row("Counted", formatCents(input.z.cash.counted));
    row("Variance", formatCents(input.z.cash.variance ?? 0), bold);
  }
  section("Fees and discounts by reporting class");
  for (const a of input.summary.adjustments_by_class) row(`${a.report_class} (${a.kind}, ${a.count})`, formatCents(a.total));
  section("Voids");
  row(`${input.z.voids.count} void${input.z.voids.count === 1 ? "" : "s"}, ${input.z.voids.quantity} item(s)`, formatCents(input.z.voids.value));
  section("By order type");
  for (const t of input.summary.by_order_type) row(`${t.order_type} (${t.orders})`, formatCents(t.net));
  return pdf.save({ useObjectStreams: false });
}
