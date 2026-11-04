"use client";

import { Badge, Button, DataTable, EmptyState, InlineError, Select, Switch, type DataTableColumn } from "@sail/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { OutletChoice, useOutletChoice } from "@/components/backoffice/OutletChoice";
import { label } from "@/components/backoffice/labels";
import { isLate, isWaiting, JobRowActions, JobStatus, RerouteDialog, useJobMutations } from "@/components/backoffice/PrintJobActions";
import { boKeys, formatElapsed, PRINT_JOB_KIND_LABEL, PRINT_JOB_STATUS_LABEL, PRINT_JOB_STATUSES, plural, type PrintJob, type Printer } from "@/components/backoffice/register";
import { Warnings } from "@/components/backoffice/Warnings";
import { req } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Outlet } from "@/lib/api/types";
import type { Scope } from "@/lib/cookies";
import { formatDayClock, shortId } from "@/lib/format";

const ANY = "__any__";

/** Late jobs first (oldest first), then the rest newest first (design 4.8: what needs a person now). */
export function orderJobs(jobs: PrintJob[]): PrintJob[] {
  return jobs.slice().sort((a, b) => {
    const la = isLate(a) ? 1 : 0;
    const lb = isLate(b) ? 1 : 0;
    if (la !== lb) return lb - la;
    if (la) return b.age_seconds - a.age_seconds;
    return b.created_at.localeCompare(a.created_at);
  });
}

export function PrintJobsView({ outlets, scope, initialOutletId, initialPrinters }: { outlets: Outlet[]; scope: Scope; initialOutletId: string | null; initialPrinters: Printer[] }) {
  const { outletId, setOutletId } = useOutletChoice(outlets, scope, initialOutletId);
  const [status, setStatus] = useState<string | null>(null);
  const [printerId, setPrinterId] = useState<string | null>(null);
  const [lateOnly, setLateOnly] = useState(false);
  const [note, setNote] = useState<{ text: string; warnings: string[] } | null>(null);
  const [rerouteAll, setRerouteAll] = useState(false);

  const filters = useMemo(() => ({ status: status ?? undefined, printer_id: printerId ?? undefined, late: lateOnly ? ("true" as const) : undefined }), [status, printerId, lateOnly]);
  const jobs = useQuery({
    queryKey: boKeys.printJobs(outletId ?? "", filters),
    queryFn: () => req(api.GET("/v1/outlets/{id}/print-jobs", { params: { path: { id: outletId! }, query: { ...filters, limit: 200 } } })).then((r) => r.data),
    enabled: outletId !== null,
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
  const printers = useQuery({
    queryKey: boKeys.printers(outletId ?? ""),
    queryFn: () => req(api.GET("/v1/printers", { params: { query: { outlet_id: outletId!, include_archived: "true" } } })).then((r) => r.data),
    enabled: outletId !== null,
    initialData: outletId === initialOutletId ? initialPrinters : undefined,
  });
  const printerName = useMemo(() => new Map((printers.data ?? []).map((p) => [p.id, p.name])), [printers.data]);

  const rows = useMemo(() => orderJobs(jobs.data ?? []), [jobs.data]);
  const late = rows.filter(isLate);
  const waiting = rows.filter(isWaiting);
  const onDone = (text: string, warnings: string[]) => setNote({ text, warnings });
  const { reroute } = useJobMutations(onDone);

  const columns: DataTableColumn<PrintJob>[] = [
    {
      key: "age",
      header: "Age",
      isRowHeader: true,
      render: (j) => (
        <span className="inline-flex flex-col leading-tight">
          <span className={`tabular ${isLate(j) ? "text-status-alert" : "text-ink"}`}>{isWaiting(j) ? formatElapsed(j.age_seconds) : "—"}</span>
          <span className="text-caption text-ink-2 whitespace-nowrap">{formatDayClock(j.created_at)}</span>
        </span>
      ),
    },
    { key: "kind", header: "Kind", render: (j) => <span className="text-ink">{label(PRINT_JOB_KIND_LABEL, j.kind)}{j.copies > 1 ? <span className="text-caption text-ink-2"> · copy {j.copy_no}/{j.copies}</span> : null}</span> },
    { key: "printer", header: "Printer", render: (j) => <span className="text-ink-2">{printerName.get(j.printer_id) ?? shortId(j.printer_id)}</span> },
    { key: "order", header: "Order", render: (j) => (j.order_id ? <span className="font-mono text-caption text-ink-2">{shortId(j.order_id)}</span> : <span className="text-ink-2">—</span>) },
    { key: "status", header: "Status", render: (j) => <JobStatus job={j} /> },
    { key: "attempts", header: "Attempts", numeric: true, render: (j) => j.attempts },
    {
      key: "last_error",
      header: "Last error",
      render: (j) => (
        <span className="inline-flex flex-col leading-tight">
          {j.last_error ? <span className="text-status-alert">{j.last_error}</span> : <span className="text-ink-2">—</span>}
          {j.reprint_of ? <span className="text-caption text-ink-2">Reprint of {shortId(j.reprint_of)}</span> : null}
          {j.rerouted_to ? <span className="text-caption text-ink-2">Rerouted to {shortId(j.rerouted_to)}</span> : null}
          {j.rerouted_from ? <span className="text-caption text-ink-2">From {shortId(j.rerouted_from)}</span> : null}
        </span>
      ),
    },
    { key: "actions", header: "", align: "end", render: (j) => <JobRowActions job={j} printers={printers.data ?? []} onDone={onDone} compact /> },
  ];

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <OutletChoice outlets={outlets} scope={scope} outletId={outletId} onChange={setOutletId} />
          <Select aria-label="Status" variant="toolbar" selectedKey={status ?? ANY} onSelectionChange={(k) => setStatus(k === ANY ? null : k)} items={[{ id: ANY, label: "Any status" }, ...PRINT_JOB_STATUSES.map((s) => ({ id: s, label: PRINT_JOB_STATUS_LABEL[s]! }))]} />
          <Select aria-label="Printer" variant="toolbar" selectedKey={printerId ?? ANY} onSelectionChange={(k) => setPrinterId(k === ANY ? null : k)} items={[{ id: ANY, label: "Any printer" }, ...(printers.data ?? []).map((p) => ({ id: p.id, label: p.name }))]} />
          <Switch isSelected={lateOnly} onChange={setLateOnly} className="min-h-11 py-0">
            Late only
          </Switch>
        </div>
        {waiting.length > 0 ? (
          <Button onPress={() => setRerouteAll(true)}>
            Reroute {plural(waiting.length, "waiting ticket")}
          </Button>
        ) : null}
      </div>

      {late.length > 0 ? (
        <p className="mb-3 flex items-center gap-2 text-body text-ink" role="status">
          <Badge tone="alert">{late.length}</Badge>
          {late.length === 1 ? "ticket has" : "tickets have"} not printed within 10 seconds. Reroute to the backup or retry.
        </p>
      ) : null}
      {note ? (
        <div className="mb-4 flex flex-col gap-2" role="status">
          <p className="text-body text-ink">{note.text}.</p>
          <Warnings warnings={note.warnings} />
        </div>
      ) : null}

      {outlets.length === 0 ? (
        <EmptyState title="No outlets yet" hint="Print jobs belong to an outlet." />
      ) : (
        <DataTable
          aria-label="Print jobs"
          columns={columns}
          rows={rows}
          rowKey={(j) => j.id}
          isLoading={jobs.isPending}
          className={jobs.isPlaceholderData ? "opacity-60" : undefined}
          emptyState={<EmptyState variant="quiet" title={lateOnly ? "Nothing late" : "No print jobs"} hint={lateOnly ? "Every ticket printed within 10 seconds." : "Tickets appear here as orders are sent to the kitchen."} />}
        />
      )}
      <InlineError error={jobs.error} className="mt-4" />
      <p className="mt-3 text-caption text-ink-2 tabular">
        {plural(rows.length, "job")} · up to 200 shown · refreshes every 15 s
      </p>

      {rerouteAll ? (
        <RerouteDialog
          jobs={waiting}
          printers={printers.data ?? []}
          isOpen
          onClose={() => {
            setRerouteAll(false);
            reroute.reset();
          }}
          onReroute={(target) => reroute.mutate({ jobIds: waiting.map((j) => j.id), printerId: target }, { onSuccess: () => setRerouteAll(false) })}
          isPending={reroute.isPending}
          error={reroute.error}
        />
      ) : null}
    </>
  );
}
