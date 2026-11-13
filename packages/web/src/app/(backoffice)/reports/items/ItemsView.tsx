"use client";

import { DataTable, EmptyState, InlineError, Money, Select, Skeleton, type DataTableColumn, useLocale } from "@sail/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Outlet } from "@/lib/api/types";
import type { Scope } from "@/lib/cookies";
import { ReportRange, useReportRange } from "../ReportRange";

/** One row of the register's product mix (reports.product_mix). */
type MixRow = { key: string | null; name: string; quantity: number; gross: number; discounts: number; net: number; share_bps: number };
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

const columns: DataTableColumn<MixRow>[] = [
  { key: "name", header: "Name", isRowHeader: true, sortable: true, render: (r) => <span className="text-ink">{r.name}</span> },
  { key: "quantity", header: "Sold", numeric: true, sortable: true, render: (r) => r.quantity },
  { key: "gross", header: "Gross", numeric: true, sortable: true, render: (r) => <Money cents={r.gross} /> },
  { key: "discounts", header: "Discounts", numeric: true, sortable: true, render: (r) => <Money cents={-r.discounts} /> },
  { key: "net", header: "Net", numeric: true, sortable: true, render: (r) => <Money cents={r.net} /> },
  { key: "share_bps", header: "Share of net", numeric: true, sortable: true, render: (r) => <Share bps={r.share_bps} /> },
];

export function ItemsView({ outlets, scope, initialOutletId, today }: { outlets: Outlet[]; scope: Scope; initialOutletId: string | null; today: string | null }) {
  const range = useReportRange(outlets, scope, initialOutletId, today);
  const [groupBy, setGroupBy] = useState<GroupBy>("item");
  const query = { ...range.query, group_by: groupBy };
  const report = useQuery<MixRow[], ApiError>({
    queryKey: ["reports", "product-mix", query],
    queryFn: () => req(api.GET("/v1/reports/product-mix", { params: { query } })).then((r) => (r as { data: MixRow[] }).data),
    enabled: range.outletId !== null && range.valid,
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <ReportRange outlets={outlets} scope={scope} range={range} />
        <div className="mb-6">
          <Select aria-label="Group by" variant="toolbar" selectedKey={groupBy} onSelectionChange={(k) => setGroupBy(k as GroupBy)} items={GROUPS} />
        </div>
      </div>
      {report.isPending && range.outletId ? <Skeleton lines={6} /> : null}
      <InlineError error={report.error} />
      {report.data ? (
        <DataTable aria-label="Items sold" columns={columns} rows={report.data} rowKey={(r) => r.key ?? r.name} defaultSort={{ column: "net", direction: "descending" }} emptyState={<EmptyState title="Nothing sold in this range" />} className={report.isPlaceholderData ? "opacity-60" : undefined} />
      ) : null}
    </>
  );
}
