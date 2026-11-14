import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { zonedToUtc, type MoneyFormat, type TaxAmount, type TaxBreakdown } from "@sail/shared";
import { tx } from "../db/client.js";
import { toCsv } from "./csv.js";
import { businessDayInputs } from "./business-day.js";
import { shiftDate } from "../lib/time.js";
import { pdfMoney, winAnsi } from "../lib/pdf-text.js";
import type { ZReport } from "./shifts.js";
import { taxDue } from "./tax-due.js";

/**
 * Operational reports read from the `report_*` views. Every
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
  /**
   * `net` is net sales: items after discounts, without tax and fees, less `refunds` (the refunds' net).
   * `gross` and `discounts` are as charged (tax included in inclusive mode); `fees` excludes tax.
   * `total` is what was collected before refunds: `net + refunds + fees + tax = total`, and
   * `net_before_refunds + fees + tax = total`; after refunds, `total_after_refunds = total - refunds.amount`.
   * Every `net` below (by day, order type, source and category) is the same figure split up.
   */
  totals: { orders: number; covers: number; items: number; gross: number; discounts: number; fees: number; tax: number; refunds: number; net: number; total: number; rounding: number; tips: number; net_before_refunds: number; total_after_refunds: number };
  /** totals.tax by component name and rate. */
  taxes: TaxBreakdown[];
  by_day: { business_date: string; orders: number; covers: number; gross: number; net: number }[];
  by_order_type: { order_type: string; orders: number; net: number }[];
  by_source: { source: string; orders: number; net: number }[];
  by_tender: { tender: string; is_cash: boolean; count: number; amount: number; rounding: number; tips: number }[];
  by_category: { category_id: string | null; category: string; quantity: number; gross: number; net: number }[];
  adjustments_by_rule: { rule_key: string; name: string; kind: string; report_class: string; count: number; total: number }[];
  adjustments_by_class: { report_class: string; kind: string; count: number; total: number }[];
  voids: { count: number; quantity: number; value: number };
  /**
   * `amount` is the bills' share given back, `net + fees + tax = amount`; `taxes` is the tax given back, by component;
   * the period's tax due is `taxes` (in totals) less these. `tips` were given back on top of `amount`.
   */
  refunds: { count: number; amount: number; net: number; fees: number; tax: number; tips: number; by_kind: { kind: string; count: number; amount: number }[]; taxes: { name: string; bps: number; amount: number }[] };
  /** The period's tax due by component: `taxes` less `refunds.taxes`, matched on name and rate. */
  tax_due: TaxAmount[];
  generated_at: string;
};

export async function salesSummary(f: ReportFilters): Promise<SalesSummary> {
  const sql = tx();
  const w = orderWhere(f);
  const catFilter = f.categoryId ? sql`and (r.category_id = ${f.categoryId} or r.parent_category_id = ${f.categoryId})` : sql``;
  const [t] = await sql<{ orders: number; covers: number; gross: number; discounts: number; fees: number; tax: number; net: number; total: number }[]>`
    select count(*)::int as orders, coalesce(sum(pax),0)::bigint as covers, coalesce(sum(subtotal),0)::bigint as gross, coalesce(sum(discount_total),0)::bigint as discounts,
           coalesce(sum(fees_net),0)::bigint as fees, coalesce(sum(tax_total),0)::bigint as tax, coalesce(sum(net_sales),0)::bigint as net, coalesce(sum(total),0)::bigint as total
    from report_orders r where ${w}`;
  const taxes = await sql<TaxBreakdown[]>`
    select t->>'name' as name, (t->>'bps')::int as bps, coalesce(sum((t->>'taxable')::bigint),0)::bigint as taxable, coalesce(sum((t->>'amount')::bigint),0)::bigint as amount
    from report_orders r, jsonb_array_elements(r.taxes) t where ${w} group by 1, 2 order by 2 desc, 1`;
  const [items] = await sql<{ n: number }[]>`select coalesce(sum(quantity),0)::bigint as n from report_sales_lines r where ${w} ${catFilter}`;
  // Orders and covers come from the orders of the period; net from report_net_sales, so a refund lands on its own day.
  const byDay = await sql<SalesSummary["by_day"]>`select business_date, coalesce(o.orders,0)::bigint as orders, coalesce(o.covers,0)::bigint as covers, coalesce(o.gross,0)::bigint as gross, coalesce(n.net,0)::bigint as net
    from (select business_date, count(*) as orders, sum(pax) as covers, sum(subtotal) as gross from report_orders r where ${w} group by 1) o
    full join (select business_date, sum(net) as net from report_net_sales r where ${w} group by 1) n using (business_date) order by business_date`;
  const byType = await sql<SalesSummary["by_order_type"]>`select order_type, coalesce(o.orders,0)::bigint as orders, coalesce(n.net,0)::bigint as net
    from (select order_type, count(*) as orders from report_orders r where ${w} group by 1) o
    full join (select order_type, sum(net) as net from report_net_sales r where ${w} group by 1) n using (order_type) order by order_type`;
  const bySource = await sql<SalesSummary["by_source"]>`select source, coalesce(o.orders,0)::bigint as orders, coalesce(n.net,0)::bigint as net
    from (select source, count(*) as orders from report_orders r where ${w} group by 1) o
    full join (select source, sum(net) as net from report_net_sales r where ${w} group by 1) n using (source) order by source`;
  const byTender = await sql<SalesSummary["by_tender"]>`select tender_name as tender, is_cash, count(*)::int as count, coalesce(sum(amount),0)::bigint as amount, coalesce(sum(rounding_cents),0)::bigint as rounding, coalesce(sum(tip_cents),0)::bigint as tips
    from report_payments r where ${w} and status = 'recorded' ${f.shiftId ? sql`and shift_id = ${f.shiftId}` : sql``} group by tender_name, is_cash order by amount desc`;
  const byCategory = await sql<SalesSummary["by_category"]>`select r.category_id, coalesce(c.name, 'Uncategorised') as category, coalesce(sum(r.quantity),0)::bigint as quantity, coalesce(sum(r.gross),0)::bigint as gross, coalesce(sum(r.net),0)::bigint as net
    from report_net_sales r left join report_categories c on c.id = r.category_id where ${w} ${catFilter} group by r.category_id, c.name order by net desc`;
  const byRule = await sql<SalesSummary["adjustments_by_rule"]>`select rule_key, name, kind, report_class, count(*)::int as count, coalesce(sum(total),0)::bigint as total from report_adjustments r where ${w} group by rule_key, name, kind, report_class order by kind, total`;
  const byClass = await sql<SalesSummary["adjustments_by_class"]>`select report_class, kind, count(*)::int as count, coalesce(sum(total),0)::bigint as total from report_adjustments r where ${w} group by report_class, kind order by kind, total`;
  const [voids] = await sql<{ count: number; quantity: number; value: number }[]>`select count(*)::int as count, coalesce(sum(quantity),0)::bigint as quantity, coalesce(sum(value),0)::bigint as value from report_voids r where ${w} and r.after_firing`;
  const [refunds] = await sql<{ count: number; amount: number; net: number; tax: number; tips: number }[]>`select count(*)::int as count, coalesce(sum(total),0)::bigint as amount, coalesce(sum(net),0)::bigint as net, coalesce(sum(tax),0)::bigint as tax, coalesce(sum(tip),0)::bigint as tips from report_refunds r where ${w}`;
  const refundTaxes = await sql<SalesSummary["refunds"]["taxes"]>`select t->>'name' as name, (t->>'bps')::int as bps, coalesce(sum((t->>'amount')::bigint),0)::bigint as amount from report_refunds r cross join lateral jsonb_array_elements(r.taxes) t where ${w} group by 1, 2 order by 2 desc, 1`;
  const refundKinds = await sql<{ kind: string; count: number; amount: number }[]>`select kind, count(*)::int as count, coalesce(sum(total),0)::bigint as amount from report_refunds r where ${w} group by kind order by kind`;
  const rounding = byTender.reduce((s, x) => s + x.rounding, 0);
  const tips = byTender.reduce((s, x) => s + x.tips, 0);
  return {
    filters: f,
    totals: { orders: t?.orders ?? 0, covers: t?.covers ?? 0, items: items?.n ?? 0, gross: t?.gross ?? 0, discounts: t?.discounts ?? 0, fees: t?.fees ?? 0, tax: t?.tax ?? 0, refunds: refunds?.net ?? 0, net: (t?.net ?? 0) - (refunds?.net ?? 0), total: t?.total ?? 0, rounding, tips, net_before_refunds: t?.net ?? 0, total_after_refunds: (t?.total ?? 0) - (refunds?.amount ?? 0) },
    taxes,
    by_day: byDay,
    by_order_type: byType,
    by_source: bySource,
    by_tender: byTender,
    by_category: byCategory,
    adjustments_by_rule: byRule,
    adjustments_by_class: byClass,
    voids: voids ?? { count: 0, quantity: 0, value: 0 },
    refunds: { count: refunds?.count ?? 0, amount: refunds?.amount ?? 0, net: refunds?.net ?? 0, fees: (refunds?.amount ?? 0) - (refunds?.net ?? 0) - (refunds?.tax ?? 0), tax: refunds?.tax ?? 0, tips: refunds?.tips ?? 0, by_kind: refundKinds, taxes: refundTaxes },
    tax_due: taxDue(taxes, refundTaxes),
    generated_at: new Date().toISOString(),
  };
}

export type ProductMixRow = { key: string | null; name: string; quantity: number; gross: number; discounts: number; net: number; share_bps: number };

export async function productMix(f: ReportFilters, groupBy: "item" | "category" | "staff"): Promise<ProductMixRow[]> {
  const sql = tx();
  const w = orderWhere(f);
  const catFilter = f.categoryId ? sql`and (r.category_id = ${f.categoryId} or r.parent_category_id = ${f.categoryId})` : sql``;
  let rows: Omit<ProductMixRow, "share_bps">[];
  if (groupBy === "item") rows = await sql<Omit<ProductMixRow, "share_bps">[]>`select r.product_id::text as key, r.product_name as name, sum(r.quantity)::bigint as quantity, sum(r.gross)::bigint as gross, sum(r.discounts)::bigint as discounts, sum(r.net)::bigint as net from report_net_sales r where ${w} ${catFilter} group by r.product_id, r.product_name order by net desc`;
  else if (groupBy === "category") rows = await sql<Omit<ProductMixRow, "share_bps">[]>`select r.category_id::text as key, coalesce(c.name, 'Uncategorised') as name, sum(r.quantity)::bigint as quantity, sum(r.gross)::bigint as gross, sum(r.discounts)::bigint as discounts, sum(r.net)::bigint as net from report_net_sales r left join report_categories c on c.id = r.category_id where ${w} ${catFilter} group by r.category_id, c.name order by net desc`;
  else rows = await sql<Omit<ProductMixRow, "share_bps">[]>`select r.added_by::text as key, coalesce(r.added_by_name, 'Guest') as name, sum(r.quantity)::bigint as quantity, sum(r.gross)::bigint as gross, sum(r.discounts)::bigint as discounts, sum(r.net)::bigint as net from report_net_sales r where ${w} ${catFilter} group by r.added_by, r.added_by_name order by net desc`;
  const total = rows.reduce((s, r) => s + r.net, 0);
  return rows.map((r) => ({ ...r, share_bps: total ? Math.round((r.net * 10_000) / total) : 0 }));
}

export type ExceptionsReport = {
  voids: { order_no: string; business_date: string; product_name: string; quantity: number; value: number; after_firing: boolean; reason: string | null; voided_by: string | null; approved_by: string | null }[];
  discounts: { order_no: string; business_date: string; rule_key: string; name: string; report_class: string; total: number; entered_value: number | null; applied_by: string | null; approved_by: string | null; reason: string | null }[];
  refunds: { order_no: string; business_date: string; kind: string; total: number; reason: string; refunded_by: string | null; approved_by: string | null; refund_receipt_no: string; credit_note_no: string | null }[];
  /** Payments reversed after they were taken: voided, or reversed by reopening the order. */
  payment_reversals: { order_no: string; business_date: string; tender: string; is_cash: boolean; amount: number; reversed_at: string | null; reversed_by: string | null; reason: string | null }[];
};

export async function exceptions(f: ReportFilters): Promise<ExceptionsReport> {
  const sql = tx();
  const w = orderWhere(f);
  // A void is a line taken off after it was sent to the kitchen. A line removed before sending, or by cancelling an
  // order with nothing sent, never reached the kitchen and is not a void in any report (L2).
  const voids = await sql<ExceptionsReport["voids"]>`select r.order_no, r.business_date, r.product_name, r.quantity, r.value, r.after_firing, r.void_reason as reason, s1.name as voided_by, s2.name as approved_by
    from report_voids r left join staff s1 on s1.id = r.voided_by left join staff s2 on s2.id = r.void_approved_by where ${w} and r.after_firing order by r.voided_at desc limit 1000`;
  const discounts = await sql<ExceptionsReport["discounts"]>`select r.order_no, r.business_date, r.rule_key, r.name, r.report_class, r.total, r.entered_value, s1.name as applied_by, s2.name as approved_by, r.reason
    from report_adjustments r left join staff s1 on s1.id::text = r.applied_by::text left join staff s2 on s2.id::text = r.approved_by::text where ${w} and r.kind = 'discount' and r.manual_application_id is not null order by r.business_date desc limit 1000`;
  const refunds = await sql<ExceptionsReport["refunds"]>`select order_no, business_date, kind, total, reason, refunded_by_name as refunded_by, approved_by_name as approved_by, refund_receipt_no, credit_note_no from report_refunds r where ${w} order by created_at desc limit 1000`;
  const paymentReversals = await sql<ExceptionsReport["payment_reversals"]>`select r.order_no, r.business_date, r.tender_name as tender, r.is_cash, r.amount, p.reversed_at, s.name as reversed_by, p.reversed_reason as reason
    from report_payments r join payments p on p.id = r.payment_id left join staff s on s.id = p.reversed_by where ${w} and r.status = 'reversed' order by p.reversed_at desc limit 1000`;
  return { voids, discounts, refunds, payment_reversals: paymentReversals };
}

export type PrintHealthRow = { printer_id: string | null; printer_name: string | null; relay_id: string | null; jobs: number; printed: number; failed: number; rerouted: number; reprints: number; late: number; p50_seconds: number | null; p95_seconds: number | null };

export async function printHealth(f: Pick<ReportFilters, "merchantId" | "outletId" | "from" | "to">): Promise<PrintHealthRow[]> {
  const sql = tx();
  // Jobs carry no business date: bound them by the business days' cutoff instants, not the calendar date.
  const bd = await businessDayInputs(f.merchantId, f.outletId);
  const start = zonedToUtc(f.from, bd.cutoff, bd.timeZone).toISOString();
  const end = zonedToUtc(shiftDate(f.to, 1), bd.cutoff, bd.timeZone).toISOString();
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
    where r.merchant_id = ${f.merchantId} ${f.outletId ? sql`and r.outlet_id = ${f.outletId}` : sql``} and r.created_at >= ${start} and r.created_at < ${end}
    group by printer_id, printer_name, relay_id order by printer_name`;
}

/* ---- CSV ---- */

export function salesSummaryCsv(s: SalesSummary): string {
  const rows: (string | number | boolean | null)[][] = [];
  rows.push(["totals", "orders", s.totals.orders, "covers", s.totals.covers, "gross", s.totals.gross, "discounts", s.totals.discounts, "refunds", s.totals.refunds, "net", s.totals.net, "fees", s.totals.fees, "tax", s.totals.tax, "total", s.totals.total, "rounding", s.totals.rounding, "tips", s.totals.tips]);
  for (const t of s.taxes) rows.push(["tax", t.name, t.bps, t.taxable, t.amount]);
  for (const d of s.by_day) rows.push(["by_day", d.business_date, d.orders, d.covers, d.gross, d.net]);
  for (const t of s.by_order_type) rows.push(["by_order_type", t.order_type, t.orders, t.net]);
  for (const t of s.by_source) rows.push(["by_source", t.source, t.orders, t.net]);
  for (const t of s.by_tender) rows.push(["by_tender", t.tender, t.is_cash, t.count, t.amount, t.rounding, t.tips]);
  for (const c of s.by_category) rows.push(["by_category", c.category, c.quantity, c.gross, c.net]);
  for (const a of s.adjustments_by_rule) rows.push(["adjustment", a.rule_key, a.name, a.kind, a.report_class, a.count, a.total]);
  rows.push(["voids", s.voids.count, s.voids.quantity, s.voids.value]);
  rows.push(["refunds", s.refunds.count, s.refunds.amount]);
  return toCsv(["section", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v"], rows);
}

export function rowsCsv<T extends Record<string, unknown>>(rows: T[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]!);
  return toCsv(headers, rows.map((r) => headers.map((h) => r[h] as string | number | boolean | null)));
}

/* ---- Daily summary PDF ---- */

export async function dailySummaryPdf(input: { outletName: string; businessDate: string; z: ZReport; summary: SalesSummary; money: MoneyFormat }): Promise<Uint8Array> {
  const formatCents = pdfMoney(input.money);
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Daily summary · ${input.outletName} · ${input.businessDate}`);
  const page = pdf.addPage([595.28, 841.89]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const safe = winAnsi;
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
  row("Refunds (net)", formatCents(-input.z.sales.refunds));
  row("Net sales", formatCents(input.z.sales.net), bold);
  row("Fees (net)", formatCents(input.z.sales.fees));
  for (const t of input.z.sales.taxes) row(t.name, formatCents(t.amount));
  row("Collected", formatCents(input.z.sales.total), bold);
  row(`Refunded (${input.z.refunds.count})`, formatCents(-input.z.refunds.amount));
  for (const t of input.z.refunds.taxes) row(`${t.name} refunded`, formatCents(-t.amount));
  section("Tenders");
  for (const t of input.z.tenders) row(`${t.tender} (${t.count})`, `${formatCents(t.amount)}${t.rounding ? ` · rounding ${formatCents(t.rounding)}` : ""}`);
  section("Cash");
  row("Float", formatCents(input.z.cash.float));
  row("Cash payments", formatCents(input.z.cash.cash_payments));
  row("Cash rounding", formatCents(input.z.cash.rounding));
  row("Cash tips", formatCents(input.z.cash.tips));
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
