"use client";

import { DataTable, EmptyState, InlineError, Money, Select, Skeleton, type DataTableColumn, useLocale } from "@sail/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { ReportExport } from "@/components/backoffice/ReportExport";
import { ReportPrintHead } from "@/components/backoffice/ReportPrintHead";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Outlet } from "@/lib/api/types";
import type { Scope } from "@/lib/cookies";
import { rangeScope, ReportRange, useReportRange } from "../ReportRange";

/** One row of the register's product mix (reports.product_mix): gross − discounts − tax − refunds = net. */
type MixRow = { key: string | null; name: string; quantity: number; gross: number; discounts: number; tax: number; refunds: number; net: number; share_bps: number };
type GroupBy = "item" | "category" | "staff";

const GROUPS: { id: GroupBy; label: string }[] = [
  { id: "item", label: "By item" },
  { id: "category", label: "By category" },
  { id: "staff", label: "By staff" },
];

/** Basis points as a percentage with one decimal, in the merchant's number format. */
function Share({ bps }: { bps: number }) {
  const { number } = useLocale();
  return <>{number(bps / 100, 1)}%</>;
}

// Refunds have a column so every row adds up (review 2, N6); the tax inside VAT-inclusive prices only where there is some.
const columnsFor = (rows: MixRow[]): DataTableColumn<MixRow>[] => [
  { key: "name", header: "Name", isRowHeader: true, sortable: true, render: (r) => <span className="text-ink">{r.name}</span> },
  { key: "quantity", header: "Sold", numeric: true, sortable: true, render: (r) => r.quantity },
  { key: "gross", header: "Gross", numeric: true, sortable: true, render: (r) => <Money cents={r.gross} /> },
  { key: "discounts", header: "Discounts", numeric: true, sortable: true, render: (r) => <Money cents={-r.discounts} /> },
  ...(rows.some((r) => r.tax !== 0) ? [{ key: "tax", header: "Tax in prices", numeric: true, sortable: true, render: (r: MixRow) => <Money cents={-r.tax} /> }] : []),
  { key: "refunds", header: "Refunds", numeric: true, sortable: true, render: (r) => <Money cents={-r.refunds} /> },
  { key: "net", header: "Net", numeric: true, sortable: true, render: (r) => <Money cents={r.net} /> },
  { key: "share_bps", header: "Share of net", numeric: true, sortable: true, render: (r) => <Share bps={r.share_bps} /> },
];

export function ItemsView({ outlets, scope, initialOutletId, today, initialRange }: { outlets: Outlet[]; scope: Scope; initialOutletId: string | null; today: string | null; initialRange?: { from: string | null; to: string | null } }) {
  const range = useReportRange(outlets, scope, initialOutletId, today, initialRange);
  const figures = useRef<HTMLDivElement>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>("item");
  const query = { ...range.query, group_by: groupBy };
  const report = useQuery<MixRow[], ApiError>({
    queryKey: ["reports", "product-mix", query],
    queryFn: () => req(api.GET("/v1/reports/product-mix", { params: { query } })).then((r) => (r as { data: MixRow[] }).data),
    enabled: range.outletId !== null && range.valid,
    // Dates that cannot make a range show no figures, not the last range's under the new dates (E-N9).
    placeholderData: range.valid ? keepPreviousData : undefined,
  });

  return (
    <>
      <ReportRange
        outlets={outlets}
        scope={scope}
        range={range}
        actions={
          <>
            <ReportExport title="Items" scope={[...rangeScope(outlets, range), ["Group", GROUPS.find((g) => g.id === groupBy)!.label]]} fileName={`items-by-${groupBy}-${range.from}-${range.to}`} target={figures} isDisabled={!report.data || report.isPlaceholderData} />
          </>
        }
      >
        <Select aria-label="Group by" variant="toolbar" size="sm" selectedKey={groupBy} onSelectionChange={(k) => setGroupBy(k as GroupBy)} items={GROUPS} />
      </ReportRange>
      {report.isPending && range.outletId && range.valid ? <Skeleton lines={6} /> : null}
      <InlineError error={report.error} />
      {report.data ? (
        <div ref={figures}>
        <ReportPrintHead title="Items" scope={[...rangeScope(outlets, range), ["Group", GROUPS.find((g) => g.id === groupBy)!.label]]} />
        <DataTable aria-label="Items sold" columns={columnsFor(report.data)} rows={report.data} rowKey={(r) => r.key ?? r.name} defaultSort={{ column: "net", direction: "descending" }} emptyState={<EmptyState title="Nothing sold in this range" />} className={report.isPlaceholderData ? "opacity-60" : undefined} />
        </div>
      ) : null}
    </>
  );
}
