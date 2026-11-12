"use client";

import { DataTable, DescriptionList, EmptyState, InlineError, Money, SectionHeading, Skeleton, taxRows, type DataTableColumn } from "@sail/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Outlet, TaxBreakdown } from "@/lib/api/types";
import type { Scope } from "@/lib/cookies";
import { useSession } from "@/lib/session-context";
import { ReportRange, useReportRange } from "../ReportRange";

/** The register's sales summary (reports.sales_summary). Figures are shown as the register reports them. */
type SalesSummary = {
  totals: { orders: number; covers: number; items: number; gross: number; discounts: number; fees: number; tax: number; net: number; refunds: number; net_after_refunds: number; rounding: number; tips: number };
  /** `totals.tax` by component. */
  taxes: TaxBreakdown[];
  by_day: { business_date: string; orders: number; covers: number; gross: number; net: number }[];
  by_tender: { tender: string; is_cash: boolean; count: number; amount: number; rounding: number; tips: number }[];
  by_category: { category_id: string | null; category: string; quantity: number; gross: number; net: number }[];
  voids: { count: number; quantity: number; value: number };
};

const dayColumns: DataTableColumn<SalesSummary["by_day"][number]>[] = [
  { key: "business_date", header: "Business date", isRowHeader: true, render: (d) => <span className="tabular text-ink">{d.business_date}</span> },
  { key: "orders", header: "Orders", numeric: true, render: (d) => d.orders },
  { key: "covers", header: "Covers", numeric: true, render: (d) => d.covers },
  { key: "gross", header: "Gross", numeric: true, render: (d) => <Money cents={d.gross} /> },
  { key: "net", header: "Net", numeric: true, render: (d) => <Money cents={d.net} /> },
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
  { key: "net", header: "Net", numeric: true, render: (c) => <Money cents={c.net} /> },
];

export function SalesView({ outlets, scope, initialOutletId }: { outlets: Outlet[]; scope: Scope; initialOutletId: string | null }) {
  const range = useReportRange(outlets, scope, initialOutletId);
  const report = useQuery<SalesSummary, ApiError>({
    queryKey: ["reports", "sales", range.query],
    queryFn: () => req(api.GET("/v1/reports/sales-summary", { params: { query: range.query } })).then((r) => (r as { data: SalesSummary }).data),
    enabled: range.outletId !== null && range.valid,
    placeholderData: keepPreviousData,
  });
  const t = report.data?.totals;
  const taxMode = useSession().merchant.settings.tax_mode;

  return (
    <>
      <ReportRange outlets={outlets} scope={scope} range={range} />
      {report.isPending && range.outletId ? <Skeleton lines={6} /> : null}
      <InlineError error={report.error} />
      {report.data && t ? (
        <div className={report.isPlaceholderData ? "flex flex-col gap-8 opacity-60" : "flex flex-col gap-8"}>
          <section className="max-w-[560px]">
            <SectionHeading title="Totals" />
            <DescriptionList
              items={[
                { term: "Orders", detail: t.orders, numeric: true },
                { term: "Covers", detail: t.covers, numeric: true },
                { term: "Items", detail: t.items, numeric: true },
                { term: "Gross", detail: <Money cents={t.gross} />, numeric: true },
                { term: "Discounts", detail: <Money cents={-t.discounts} />, numeric: true },
                { term: "Service and fees", detail: <Money cents={t.fees} />, numeric: true },
                ...taxRows(report.data.taxes, taxMode).before.map((x) => ({ term: x.label, detail: <Money cents={x.amount} />, numeric: true })),
                { term: "Net", detail: <Money cents={t.net} />, numeric: true },
                ...taxRows(report.data.taxes, taxMode).after.map((x) => ({ term: x.label, detail: <Money cents={x.amount} />, numeric: true })),
                { term: "Refunds", detail: <Money cents={-t.refunds} />, numeric: true },
                { term: "Net after refunds", detail: <Money cents={t.net_after_refunds} />, numeric: true },
                { term: "Cash rounding", detail: <Money cents={t.rounding} signed />, numeric: true },
                { term: "Tips", detail: <Money cents={t.tips} />, numeric: true },
                { term: "Voids", detail: <>{report.data.voids.count} · <Money cents={report.data.voids.value} /></>, numeric: true },
              ]}
            />
          </section>
          <section>
            <SectionHeading title="By day" />
            <DataTable aria-label="Sales by day" columns={dayColumns} rows={report.data.by_day} rowKey={(d) => d.business_date} emptyState={<EmptyState title="No orders in this range" />} />
          </section>
          <section>
            <SectionHeading title="By tender" />
            <DataTable aria-label="Sales by tender" columns={tenderColumns} rows={report.data.by_tender} rowKey={(t) => t.tender} emptyState={<EmptyState title="No payments in this range" />} />
          </section>
          <section>
            <SectionHeading title="By category" />
            <DataTable aria-label="Sales by category" columns={categoryColumns} rows={report.data.by_category} rowKey={(c) => c.category_id ?? c.category} emptyState={<EmptyState title="No items in this range" />} />
          </section>
        </div>
      ) : null}
    </>
  );
}
