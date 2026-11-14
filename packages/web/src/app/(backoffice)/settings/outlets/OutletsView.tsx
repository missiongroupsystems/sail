"use client";

import { Button, DataTable, EmptyState, Switch, type DataTableColumn, Pill } from "@sail/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Quiet, TwoLine } from "@/components/office/parts";
import { req } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Outlet } from "@/lib/api/types";
import { summariseHours } from "@/lib/hours";
import { keys } from "@/lib/query";
import { useSession } from "@/lib/session-context";
import { OutletSheet, type OutletSheetState } from "./OutletSheet";
import { useCan } from "@/lib/can";

/** Registration columns are headed with the merchant's own labels. */
const outletColumns = (labels: { business: string; tax: string }): DataTableColumn<Outlet>[] => [
  { key: "name", header: "Name", sortable: true, isRowHeader: true, width: "1.4fr", render: (o) => <TwoLine primary={o.name} /> },
  { key: "address", header: "Address", render: (o) => <Quiet>{o.address ?? "—"}</Quiet> },
  { key: "phone", header: "Phone", render: (o) => (o.phone ? <span className="tabular">{o.phone}</span> : <Quiet>—</Quiet>) },
  { key: "business_registration_no", header: labels.business, render: (o) => (o.business_registration_no ? <span className="tabular break-words">{o.business_registration_no}</span> : <Quiet>—</Quiet>) },
  { key: "tax_registration_no", header: labels.tax, render: (o) => (o.tax_registration_no ? <span className="tabular break-words">{o.tax_registration_no}</span> : <Quiet>—</Quiet>) },
  { key: "business_day_cutoff", header: "Day ends", sortable: true, render: (o) => <span className="tabular">{o.business_day_cutoff ?? "Merchant default"}</span> },
  { key: "hours", header: "Hours", render: (o) => <Quiet>{summariseHours(o.hours)}</Quiet> },
  {
    key: "archived",
    header: "Status",
    sortable: true,
    sortValue: (o) => (o.archived ? 1 : 0),
    render: (o) => (o.archived ? <Pill size="sm" tone="neutral">Archived</Pill> : <Pill size="sm" tone="paid">Active</Pill>),
  },
];

export function OutletsView({ initialOutlets }: { initialOutlets: Outlet[] }) {
  const canCreate = useCan("outlets.create");
  const { business_registration_label, tax_registration_label } = useSession().merchant.settings;
  const columns = outletColumns({ business: business_registration_label, tax: tax_registration_label });
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
        <p className="text-[14px] text-ink-2">
          {rows.length} {rows.length === 1 ? "outlet" : "outlets"}
          {!showArchived && archivedCount ? ` · ${archivedCount} archived` : ""}
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <Switch isSelected={showArchived} onChange={setShowArchived} className="min-h-11 py-0">
            Show archived
          </Switch>
          {canCreate.ok ? (
            <Button size="sm" variant="primary" onPress={() => setSheet({ mode: "create" })}>
            Add outlet
          </Button>
          ) : null}
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
        emptyState={<EmptyState variant="centred" title="No outlets yet" hint="Tap Add outlet to create the first one." />}
      />

      <OutletSheet state={sheet} onClose={() => setSheet(null)} />
    </>
  );
}
