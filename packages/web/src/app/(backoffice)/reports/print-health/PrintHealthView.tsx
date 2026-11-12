"use client";

import { DataTable, EmptyState, InlineError, Skeleton, type DataTableColumn, useLocale } from "@sail/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Outlet } from "@/lib/api/types";
import type { Scope } from "@/lib/cookies";
import { ReportRange, useReportRange } from "../ReportRange";

/** One printer's row from the register (reports.print_health). */
type PrintHealthRow = { printer_id: string | null; printer_name: string | null; relay_id: string | null; jobs: number; printed: number; failed: number; rerouted: number; reprints: number; late: number; p50_seconds: number | null; p95_seconds: number | null };

/** The register's percentiles are unrounded floats: one decimal, in the merchant's number format. */
function Seconds({ value }: { value: number | null }) {
  const { number } = useLocale();
  return <>{value === null ? "—" : `${number(value, 1)} s`}</>;
}

const columns: DataTableColumn<PrintHealthRow>[] = [
  { key: "printer_name", header: "Printer", isRowHeader: true, sortable: true, render: (r) => <span className="text-ink">{r.printer_name ?? "No printer"}</span> },
  { key: "jobs", header: "Jobs", numeric: true, sortable: true, render: (r) => r.jobs },
  { key: "printed", header: "Printed", numeric: true, sortable: true, render: (r) => r.printed },
  { key: "failed", header: "Failed", numeric: true, sortable: true, render: (r) => <span className={r.failed > 0 ? "text-status-alert" : undefined}>{r.failed}</span> },
  { key: "late", header: "Late", numeric: true, sortable: true, render: (r) => <span className={r.late > 0 ? "text-status-sent" : undefined}>{r.late}</span> },
  { key: "rerouted", header: "Rerouted", numeric: true, sortable: true, render: (r) => r.rerouted },
  { key: "reprints", header: "Reprints", numeric: true, sortable: true, render: (r) => r.reprints },
  { key: "p50_seconds", header: "Median to print", numeric: true, sortable: true, render: (r) => <Seconds value={r.p50_seconds} /> },
  { key: "p95_seconds", header: "95th percentile", numeric: true, sortable: true, render: (r) => <Seconds value={r.p95_seconds} /> },
];

export function PrintHealthView({ outlets, scope, initialOutletId }: { outlets: Outlet[]; scope: Scope; initialOutletId: string | null }) {
  const range = useReportRange(outlets, scope, initialOutletId);
  const { outlet_id, from, to } = range.query;
  const report = useQuery<PrintHealthRow[], ApiError>({
    queryKey: ["reports", "print-health", range.query],
    queryFn: () => req(api.GET("/v1/reports/print-health", { params: { query: { outlet_id, from, to } } })).then((r) => (r as { data: PrintHealthRow[] }).data),
    enabled: range.outletId !== null && range.valid,
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <ReportRange outlets={outlets} scope={scope} range={range} />
      {report.isPending && range.outletId ? <Skeleton lines={4} /> : null}
      <InlineError error={report.error} />
      {report.data ? (
        <DataTable aria-label="Print health by printer" columns={columns} rows={report.data} rowKey={(r) => r.printer_id ?? "none"} emptyState={<EmptyState title="No print jobs in this range" />} className={report.isPlaceholderData ? "opacity-60" : undefined} />
      ) : null}
    </>
  );
}
