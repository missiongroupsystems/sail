"use client";

import { Badge, DataTable, DescriptionList, EmptyState, InlineError, Money, Select, Sheet, TextField, type DataTableColumn, useLocale } from "@sail/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { OutletChoice, useOutletChoice } from "@/components/backoffice/OutletChoice";
import { boKeys, type Shift } from "@/components/backoffice/register";
import { ZReportBody } from "@/components/backoffice/ZReportBody";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Outlet } from "@/lib/api/types";
import type { Scope } from "@/lib/cookies";

const ANY = "__any__";

export function ShiftsView({ outlets, scope, initialOutletId }: { outlets: Outlet[]; scope: Scope; initialOutletId: string | null }) {
  const { dayClock } = useLocale();
  const { outletId, setOutletId } = useOutletChoice(outlets, scope, initialOutletId);
  const [status, setStatus] = useState<"open" | "closed" | null>(null);
  const [date, setDate] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const filters = useMemo(() => ({ status: status ?? undefined, business_date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined }), [status, date]);
  const shifts = useQuery<Shift[], ApiError>({
    queryKey: boKeys.shifts(outletId ?? "", filters),
    queryFn: () => req(api.GET("/v1/outlets/{id}/shifts", { params: { path: { id: outletId! }, query: filters } })).then((r) => r.data as unknown as Shift[]),
    enabled: outletId !== null,
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  const stations = useQuery({
    queryKey: ["stations", outletId ?? ""],
    queryFn: () => req(api.GET("/v1/outlets/{id}/stations", { params: { path: { id: outletId! } } })).then((r) => r.data),
    enabled: outletId !== null,
    staleTime: 60_000,
  });
  const stationName = (id: string | null) => (id ? (stations.data ?? []).find((s) => s.id === id)?.name ?? "Station" : "Outlet");
  const open = (shifts.data ?? []).find((s) => s.id === openId) ?? null;

  const variance = (s: Shift) => {
    if (s.variance_cents === null) return <span className="text-ink-2">—</span>;
    return <Money cents={s.variance_cents} signed className={s.variance_cents === 0 ? "text-status-paid" : "text-status-alert"} />;
  };

  const columns: DataTableColumn<Shift>[] = [
    { key: "opened_at", header: "Opened", sortable: true, isRowHeader: true, render: (s) => <span className="tabular whitespace-nowrap text-ink">{dayClock(s.opened_at)}</span> },
    { key: "business_date", header: "Business date", sortable: true, render: (s) => <span className="tabular text-ink-2">{s.business_date}</span> },
    { key: "name", header: "Shift", sortValue: (s) => s.name ?? stationName(s.station_id), render: (s) => <span className="text-ink">{s.name ?? stationName(s.station_id)}{s.name && s.station_id ? <span className="text-caption text-ink-2"> · {stationName(s.station_id)}</span> : null}</span> },
    { key: "opened_by", header: "Opened by", sortable: true, render: (s) => <span className="text-ink-2">{s.opened_by ?? "—"}</span> },
    { key: "status", header: "Status", sortable: true, render: (s) => <Badge tone={s.status === "open" ? "seated" : "neutral"}>{s.status === "open" ? "Open" : "Closed"}</Badge> },
    { key: "float_cents", header: "Float", numeric: true, sortable: true, render: (s) => <Money cents={s.float_cents} /> },
    { key: "expected_cash_cents", header: "Expected", numeric: true, sortable: true, render: (s) => (s.expected_cash_cents === null ? <span className="text-ink-2">—</span> : <Money cents={s.expected_cash_cents} />) },
    { key: "counted_cash_cents", header: "Counted", numeric: true, sortable: true, render: (s) => (s.counted_cash_cents === null ? <span className="text-ink-2">—</span> : <Money cents={s.counted_cash_cents} />) },
    { key: "variance_cents", header: "Variance", numeric: true, sortable: true, render: variance },
    { key: "closed_at", header: "Closed", sortable: true, render: (s) => <span className="tabular whitespace-nowrap text-ink-2">{s.closed_at ? `${dayClock(s.closed_at)}${s.closed_by ? ` · ${s.closed_by}` : ""}` : "—"}</span> },
  ];

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <OutletChoice outlets={outlets} scope={scope} outletId={outletId} onChange={setOutletId} />
        <Select aria-label="Status" variant="toolbar" selectedKey={status ?? ANY} onSelectionChange={(k) => setStatus(k === ANY ? null : (k as "open" | "closed"))} items={[{ id: ANY, label: "Open and closed" }, { id: "open", label: "Open" }, { id: "closed", label: "Closed" }]} />
        <TextField aria-label="Business date" type="date" numeric value={date} onChange={setDate} className="w-[170px]" />
      </div>

      {outlets.length === 0 ? (
        <EmptyState title="No outlets yet" hint="Shifts belong to an outlet." />
      ) : (
        <DataTable
          aria-label="Shifts"
          columns={columns}
          rows={shifts.data ?? []}
          rowKey={(s) => s.id}
          isLoading={shifts.isPending}
          className={shifts.isPlaceholderData ? "opacity-60" : undefined}
          defaultSort={{ column: "opened_at", direction: "descending" }}
          onRowAction={(s) => setOpenId(s.id)}
          emptyState={<EmptyState variant="quiet" title="No shifts" hint="Stations open a shift with a counted float; closed shifts keep their Z figures here." />}
        />
      )}
      <InlineError error={shifts.error} className="mt-4" />
      <p className="mt-3 text-caption text-ink-2">Up to 200 shifts, newest first. Variance is counted minus expected, from the register.</p>

      <Sheet isOpen={open !== null} onOpenChange={(o) => !o && setOpenId(null)} width="lg" title={open ? open.name ?? stationName(open.station_id) : "Shift"} description={open ? `${open.status === "open" ? "Open" : "Closed"} · business day ${open.business_date} · opened ${dayClock(open.opened_at)}${open.opened_by ? ` by ${open.opened_by}` : ""}` : undefined}>
        {open ? (
          <div className="flex flex-col gap-8">
            <DescriptionList
              layout="grid"
              items={[
                { term: "Float", detail: <Money cents={open.float_cents} />, numeric: true },
                { term: "Expected cash", detail: open.expected_cash_cents === null ? "—" : <Money cents={open.expected_cash_cents} />, numeric: true },
                { term: "Counted", detail: open.counted_cash_cents === null ? "—" : <Money cents={open.counted_cash_cents} />, numeric: true },
                { term: "Variance", detail: variance(open), numeric: true },
                ...(open.variance_reason ? [{ term: "Variance reason", detail: open.variance_reason }] : []),
                ...(open.closed_at ? [{ term: "Closed", detail: `${dayClock(open.closed_at)}${open.closed_by ? ` by ${open.closed_by}` : ""}` }] : []),
              ]}
            />
            {open.float_counts && Object.keys(open.float_counts).length ? (
              <p className="text-caption text-ink-2">
                Float counted by denomination:{" "}
                {Object.entries(open.float_counts)
                  .map(([d, n]) => `${n}× ${d}`)
                  .join(", ")}
              </p>
            ) : null}
            {open.summary ? <ZReportBody report={open.summary} stationName={(id) => stationName(id)} /> : <p className="text-ink-2">The Z figures are stored when the shift closes.</p>}
          </div>
        ) : null}
      </Sheet>
    </>
  );
}
