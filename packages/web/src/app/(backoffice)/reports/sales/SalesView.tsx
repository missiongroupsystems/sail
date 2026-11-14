"use client";

import { BusinessDay, DataTable, EmptyState, InlineError, Money, Panel, refundBlocks, Skeleton, taxRows, ValueRows, type DataTableColumn } from "@sail/ui";
import { blockRows } from "@/components/backoffice/ZReportBody";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Outlet, TaxBreakdown } from "@/lib/api/types";
import type { Scope } from "@/lib/cookies";
import { useSession } from "@/lib/session-context";
import { ReportRange, useReportRange } from "../ReportRange";

/**
 * The register's sales summary (reports.sales_summary). Figures are shown as the register reports them.
 * Every `net` is net sales: items after discounts, without tax and fees, less the refunds' net (`totals.refunds`).
 * `totals.fees` excludes tax; `totals.total` is what was collected before refunds.
 */
type SalesSummary = {
  totals: { orders: number; covers: number; items: number; gross: number; discounts: number; fees: number; tax: number; refunds: number; net: number; total: number; rounding: number; tips: number; net_before_refunds?: number; total_after_refunds?: number };
  /** `totals.tax` by component. */
  taxes: TaxBreakdown[];
  by_day: { business_date: string; orders: number; covers: number; gross: number; net: number }[];
  by_tender: { tender: string; is_cash: boolean; count: number; amount: number; rounding: number; tips: number }[];
  by_category: { category_id: string | null; category: string; quantity: number; gross: number; net: number }[];
  voids: { count: number; quantity: number; value: number };
  /** `net`, `fees`, `tax`, `tips` and `taxes` arrive with the before/after-refunds figures (`net + fees + tax = amount`). */
  refunds?: { count: number; amount: number; net?: number; fees?: number; tax?: number; tips?: number; taxes?: TaxBreakdown[] };
  /** The tax due by component (`taxes` less `refunds.taxes`), as the register computed it. */
  tax_due?: { name: string; bps: number; amount: number }[];
};

const dayColumns: DataTableColumn<SalesSummary["by_day"][number]>[] = [
  { key: "business_date", header: "Business date", isRowHeader: true, render: (d) => <span className="text-ink"><BusinessDay value={d.business_date} /></span> },
  { key: "orders", header: "Orders", numeric: true, render: (d) => d.orders },
  { key: "covers", header: "Covers", numeric: true, render: (d) => d.covers },
  { key: "gross", header: "Gross", numeric: true, render: (d) => <Money cents={d.gross} /> },
  { key: "net", header: "Net sales", numeric: true, render: (d) => <Money cents={d.net} /> },
];
const tenderColumns: DataTableColumn<SalesSummary["by_tender"][number]>[] = [
  { key: "tender", header: "Tender", isRowHeader: true, render: (t) => <span className="text-ink">{t.tender}</span> },
  { key: "count", header: "Payments", numeric: true, render: (t) => t.count },
  { key: "amount", header: "Amount", numeric: true, render: (t) => <Money cents={t.amount} /> },
  { key: "rounding", header: "Rounding", numeric: true, render: (t) => <Money cents={t.rounding} signed /> },
  { key: "tips", header: "Tips", numeric: true, render: (t) => <Money cents={t.tips} /> },
];
const categoryColumns: DataTableColumn<SalesSummary["by_category"][number]>[] = [
  { key: "category", header: "Category", isRowHeader: true, render: (c) => <span className="text-ink">{c.category}</span> },
  { key: "quantity", header: "Items", numeric: true, render: (c) => c.quantity },
  { key: "gross", header: "Gross", numeric: true, render: (c) => <Money cents={c.gross} /> },
  { key: "net", header: "Net sales", numeric: true, render: (c) => <Money cents={c.net} /> },
];

export function SalesView({ outlets, scope, initialOutletId, today }: { outlets: Outlet[]; scope: Scope; initialOutletId: string | null; today: string | null }) {
  const range = useReportRange(outlets, scope, initialOutletId, today);
  const report = useQuery<SalesSummary, ApiError>({
    queryKey: ["reports", "sales", range.query],
    queryFn: () => req(api.GET("/v1/reports/sales-summary", { params: { query: range.query } })).then((r) => (r as { data: SalesSummary }).data),
    enabled: range.outletId !== null && range.valid,
    // Dates that cannot make a range show no figures, not the last range's under the new dates (E-N9).
    placeholderData: range.valid ? keepPreviousData : undefined,
  });
  const t = report.data?.totals;
  const taxMode = useSession().merchant.settings.tax_mode;
  // Tips and rounding columns only where the merchant has them (F notes), so the table fits at 1024 (F-N2).
  const tipsEnabled = Boolean(useSession().merchant.settings.tips_enabled);
  const blocks = report.data && t && report.data.refunds ? refundBlocks({ ...t, taxes: report.data.taxes }, report.data.refunds, taxMode, report.data.tax_due) : null;

  return (
    <>
      <ReportRange outlets={outlets} scope={scope} range={range} />
      {report.isPending && range.outletId && range.valid ? <Skeleton lines={6} /> : null}
      <InlineError error={report.error} />
      {report.data && t ? (
        <div className={report.isPlaceholderData ? "grid items-start gap-6 opacity-60 lg:grid-cols-2" : "grid items-start gap-6 lg:grid-cols-2"}>
          {blocks && t ? (
            <div className="flex min-w-0 flex-col gap-6">
              <Panel title="Before refunds">
                <ValueRows
                  rows={[
                    { label: "Orders", value: t.orders },
                    { label: "Covers", value: t.covers },
                    { label: "Items", value: t.items },
                    ...blockRows(blocks.before),
                    { label: "Cash rounding", value: <Money cents={t.rounding} signed /> },
                    { label: "Tips", value: <Money cents={t.tips} /> },
                    { label: "Voids", value: <>{report.data.voids.count} · <Money cents={report.data.voids.value} /></> },
                  ]}
                />
              </Panel>
              <Panel title="Refunds">
                <ValueRows rows={blockRows(blocks.refunds)} />
                {blocks.tipsBack ? <ValueRows className="mt-1.5 border-t border-rule-subtle pt-1.5" rows={blockRows([blocks.tipsBack])} /> : null}
              </Panel>
              <Panel title="After refunds">
                <ValueRows rows={blockRows(blocks.after)} />
                {blocks.taxDue.length ? <ValueRows className="mt-1.5 border-t border-rule-subtle pt-1.5" rows={blockRows(blocks.taxDue)} /> : null}
              </Panel>
            </div>
          ) : (
          <Panel title="Totals">
            <ValueRows
              rows={[
                { label: "Orders", value: t.orders },
                { label: "Covers", value: t.covers },
                { label: "Items", value: t.items },
                { label: "Gross", value: <Money cents={t.gross} /> },
                { label: "Discounts", value: <Money cents={-t.discounts} /> },
                { label: "Refunds (before tax)", value: <Money cents={-t.refunds} /> },
                { label: "Net sales", value: <Money cents={t.net} />, strong: true },
                { label: "Service and fees (before tax)", value: <Money cents={t.fees} /> },
                ...taxRows(report.data.taxes, taxMode).before.map((x) => ({ key: x.key, label: x.label, value: <Money cents={x.amount} /> })),
                { label: "Collected", value: <Money cents={t.total} />, strong: true },
                ...taxRows(report.data.taxes, taxMode).after.map((x) => ({ key: x.key, label: x.label, value: <Money cents={x.amount} /> })),
                { label: "Cash rounding", value: <Money cents={t.rounding} signed /> },
                { label: "Tips", value: <Money cents={t.tips} /> },
                { label: "Voids", value: <>{report.data.voids.count} · <Money cents={report.data.voids.value} /></> },
              ]}
            />
          </Panel>
          )}
          <div className="flex min-w-0 flex-col gap-6">
            <Panel title="By tender" body="flush">
              <DataTable aria-label="Sales by tender" flush="inset" columns={tenderColumns.filter((c) => (c.key !== "tips" || tipsEnabled || report.data!.by_tender.some((t) => t.tips)) && (c.key !== "rounding" || report.data!.by_tender.some((t) => t.rounding)))} rows={report.data.by_tender} rowKey={(t) => t.tender} emptyState={<EmptyState variant="centred" title="No payments in this range" />} />
            </Panel>
            <Panel title="By category" body="flush">
              <DataTable aria-label="Sales by category" flush="inset" columns={categoryColumns} rows={report.data.by_category} rowKey={(c) => c.category_id ?? c.category} emptyState={<EmptyState variant="centred" title="No items in this range" />} />
            </Panel>
          </div>
          <Panel title="By day" body="flush" className="lg:col-span-2">
            <DataTable aria-label="Sales by day" flush="inset" columns={dayColumns} rows={report.data.by_day} rowKey={(d) => d.business_date} emptyState={<EmptyState variant="centred" title="No orders in this range" />} />
          </Panel>
        </div>
      ) : null}
    </>
  );
}
