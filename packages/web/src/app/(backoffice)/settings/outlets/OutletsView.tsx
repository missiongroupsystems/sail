"use client";

import { Button, DataTable, EmptyState, StatusDot, Switch, type DataTableColumn } from "@sail/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { req } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Outlet } from "@/lib/api/types";
import { summariseHours } from "@/lib/hours";
import { keys } from "@/lib/query";
import { OutletSheet, type OutletSheetState } from "./OutletSheet";

const columns: DataTableColumn<Outlet>[] = [
  { key: "name", header: "Name", sortable: true, isRowHeader: true, render: (o) => <span className="text-ink">{o.name}</span> },
  { key: "address", header: "Address", render: (o) => <span className="text-ink-2">{o.address ?? "—"}</span> },
  { key: "phone", header: "Phone", render: (o) => <span className="tabular">{o.phone ?? "—"}</span> },
  { key: "uen", header: "UEN", render: (o) => <span className="font-mono text-caption">{o.uen ?? "—"}</span> },
  { key: "business_day_cutoff", header: "Day ends", sortable: true, render: (o) => <span className="tabular">{o.business_day_cutoff ?? "Merchant default"}</span> },
  { key: "hours", header: "Hours", render: (o) => <span className="text-ink-2">{summariseHours(o.hours)}</span> },
  {
    key: "archived",
    header: "Status",
    sortable: true,
    sortValue: (o) => (o.archived ? 1 : 0),
    render: (o) => (o.archived ? <StatusDot status="neutral" label="Archived" muted /> : <StatusDot status="paid" label="Active" />),
  },
];

export function OutletsView({ initialOutlets }: { initialOutlets: Outlet[] }) {
  const [showArchived, setShowArchived] = useState(false);
  const [sheet, setSheet] = useState<OutletSheetState>(null);

  const outlets = useQuery({
    queryKey: keys.outlets(true),
    queryFn: () => req(api.GET("/v1/outlets", { params: { query: { include_archived: "true" } } })).then((r) => r.data),
    initialData: initialOutlets,
  });

  const rows = outlets.data.filter((o) => showArchived || !o.archived);
  const archivedCount = outlets.data.filter((o) => o.archived).length;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-ink-2">
          {rows.length} {rows.length === 1 ? "outlet" : "outlets"}
          {!showArchived && archivedCount ? ` · ${archivedCount} archived` : ""}
        </p>
        <div className="flex items-center gap-4">
          <Switch isSelected={showArchived} onChange={setShowArchived} className="min-h-11 py-0">
            Show archived
          </Switch>
          <Button variant="primary" onPress={() => setSheet({ mode: "create" })}>
            Add outlet
          </Button>
        </div>
      </div>

      <DataTable
        aria-label="Outlets"
        columns={columns}
        rows={rows}
        rowKey={(o) => o.id}
        defaultSort={{ column: "name", direction: "ascending" }}
        onRowAction={(o) => setSheet({ mode: "edit", outlet: o })}
        rowClassName={(o) => (o.archived ? "text-ink-2" : undefined)}
        emptyState={<EmptyState variant="quiet" title="No outlets yet" hint="Tap Add outlet to create the first one." />}
      />

      <OutletSheet state={sheet} onClose={() => setSheet(null)} />
    </>
  );
}
