"use client";

import { Badge, Button, DataTable, EmptyState, InlineError, StatusDot, Switch, type DataTableColumn, useLocale } from "@sail/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { OutletChoice, useOutletChoice } from "@/components/backoffice/OutletChoice";
import { label } from "@/components/backoffice/labels";
import { useAllProducts } from "@/components/backoffice/products";
import { boKeys, can, PRINTER_ROLE_LABEL, plural, type CreatedJob, type Printer, type Relay } from "@/components/backoffice/register";
import { Warnings } from "@/components/backoffice/Warnings";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Outlet, Product, Station } from "@/lib/api/types";
import type { Scope } from "@/lib/cookies";
import { useSession } from "@/lib/session-context";
import { PrinterSheet, type PrinterSheetState } from "./PrinterSheet";

/** The latest reachability report for a printer across the outlet's relays (relays heartbeat every 30 s). */
export function latestStatus(relays: Relay[], printerId: string): { ok: boolean; checked_at: string; error?: string; relay: string } | null {
  let best: { ok: boolean; checked_at: string; error?: string; relay: string } | null = null;
  for (const r of relays) {
    const s = r.printer_status[printerId];
    if (s && (!best || s.checked_at > best.checked_at)) best = { ...s, relay: r.name };
  }
  return best;
}

/**
 * Routing coverage (services/printing.ts printerMatches): a kitchen printer takes a
 * line when its include tags meet the line's tags (and no exclude tag does). Lines
 * nobody takes go to the default kitchen printer. Station-bound printers only serve
 * their station, so they do not count as outlet coverage here.
 */
export function routingWarnings(products: Product[], printers: Printer[]): { warnings: string[]; fallbackCount: number } {
  const kitchen = printers.filter((p) => p.role === "kitchen" && !p.archived);
  const outletWide = kitchen.filter((p) => !p.station_id);
  const fallback = kitchen.find((p) => p.is_default_kitchen) ?? null;
  const matchers = outletWide.filter((p) => !(p.include_tags.length === 0 && p.is_default_kitchen));
  const matches = (tags: string[], p: Printer) => {
    if (p.include_tags.length > 0 && !tags.some((t) => p.include_tags.includes(t))) return false;
    if (p.exclude_tags.length > 0 && tags.some((t) => p.exclude_tags.includes(t))) return false;
    return true;
  };
  const live = products.filter((p) => !p.archived && p.kind !== "component");
  const unmatched = live.filter((pr) => !matchers.some((p) => matches(pr.tags, p)));
  const warnings: string[] = [];
  if (kitchen.length === 0) {
    warnings.push("No kitchen printer at this outlet: nothing sent to the kitchen will print.");
    return { warnings, fallbackCount: 0 };
  }
  if (!fallback) warnings.push("No default kitchen printer. Items whose tags match no printer will not print. Mark one kitchen printer as the default.");
  if (!fallback && unmatched.length > 0) {
    const names = unmatched.slice(0, 6).map((p) => p.name);
    warnings.push(`${plural(unmatched.length, "product routes", "products route")} to no printer: ${names.join(", ")}${unmatched.length > names.length ? ` and ${unmatched.length - names.length} more` : ""}.`);
  }
  const defaultOnly = fallback && !fallback.station_id && fallback.include_tags.length === 0 && matchers.length === 0;
  if (defaultOnly) warnings.push(`Only the default kitchen printer is set up; every item prints on ${fallback.name}.`);
  return { warnings, fallbackCount: fallback ? unmatched.length : 0 };
}

export function PrintersView({ outlets, scope, initialOutletId, initialPrinters, initialRelays, initialStations }: { outlets: Outlet[]; scope: Scope; initialOutletId: string | null; initialPrinters: Printer[]; initialRelays: Relay[]; initialStations: Station[] }) {
  const { dayClock } = useLocale();
  const { me } = useSession();
  const admin = can(me, "print_jobs.test");
  const { outletId, setOutletId } = useOutletChoice(outlets, scope, initialOutletId);
  const [showArchived, setShowArchived] = useState(false);
  const [sheet, setSheet] = useState<PrinterSheetState>(null);
  const [note, setNote] = useState<{ text: string; warnings: string[] } | null>(null);

  const printers = useQuery({
    queryKey: boKeys.printers(outletId ?? ""),
    queryFn: () => req(api.GET("/v1/printers", { params: { query: { outlet_id: outletId!, include_archived: "true" } } })).then((r) => r.data),
    enabled: outletId !== null,
    initialData: outletId === initialOutletId ? initialPrinters : undefined,
  });
  const relays = useQuery({
    queryKey: boKeys.relays(outletId ?? ""),
    queryFn: () => req(api.GET("/v1/relays", { params: { query: { outlet_id: outletId! } } })).then((r) => r.data),
    enabled: outletId !== null,
    initialData: outletId === initialOutletId ? initialRelays : undefined,
    refetchInterval: 30_000,
  });
  const stations = useQuery({
    queryKey: ["stations", outletId ?? ""],
    queryFn: () => req(api.GET("/v1/outlets/{id}/stations", { params: { path: { id: outletId! } } })).then((r) => r.data),
    enabled: outletId !== null,
    initialData: outletId === initialOutletId ? initialStations : undefined,
  });
  const products = useAllProducts({ include_archived: "false" }, outletId !== null);

  const all = printers.data ?? [];
  const rows = all.filter((p) => showArchived || !p.archived);
  const nameOf = useMemo(() => new Map(all.map((p) => [p.id, p.name])), [all]);
  const stationName = useMemo(() => new Map((stations.data ?? []).map((s) => [s.id, s.name])), [stations.data]);
  const coverage = useMemo(() => (products.data ? routingWarnings(products.data, all) : null), [products.data, all]);

  const test = useMutation<{ data: CreatedJob[]; warnings: string[] }, ApiError, Printer>({
    mutationFn: (p) => req(api.POST("/v1/printers/{id}/test", { params: { path: { id: p.id } }, body: {} })),
    onSuccess: (r, p) => setNote({ text: `Test ticket queued on ${p.name}${r.data[0] ? ` · job ${r.data[0].id.slice(0, 8)}` : ""}. It prints when the relay picks it up.`, warnings: r.warnings }),
  });

  const columns: DataTableColumn<Printer>[] = [
    { key: "name", header: "Name", sortable: true, isRowHeader: true, render: (p) => <span className="text-ink">{p.name}</span> },
    { key: "address", header: "Address", sortValue: (p) => p.ip, render: (p) => <span className="font-mono text-caption text-ink-2">{p.ip}:{p.port}</span> },
    { key: "role", header: "Role", sortable: true, render: (p) => <Badge tone={p.role === "kitchen" ? "sent" : "neutral"}>{label(PRINTER_ROLE_LABEL, p.role)}</Badge> },
    { key: "paper_width", header: "Paper", sortable: true, render: (p) => <span className="tabular">{p.paper_width}</span> },
    { key: "station_id", header: "Station", sortValue: (p) => (p.station_id ? stationName.get(p.station_id) ?? "" : ""), render: (p) => <span className="text-ink-2">{p.station_id ? stationName.get(p.station_id) ?? "Unknown station" : "Any"}</span> },
    {
      key: "tags",
      header: "Tags",
      render: (p) =>
        p.role !== "kitchen" ? (
          <span className="text-ink-2">—</span>
        ) : p.include_tags.length === 0 && p.exclude_tags.length === 0 ? (
          <span className="text-ink-2">{p.is_default_kitchen ? "Everything else" : "Any"}</span>
        ) : (
          <span className="inline-flex flex-wrap gap-1">
            {p.include_tags.map((t) => (
              <Badge key={`i-${t}`}>{t}</Badge>
            ))}
            {p.exclude_tags.map((t) => (
              <Badge key={`x-${t}`} tone="alert">
                not {t}
              </Badge>
            ))}
          </span>
        ),
    },
    { key: "copies", header: "Copies", numeric: true, sortable: true, render: (p) => p.copies },
    { key: "backup", header: "Backup", sortValue: (p) => (p.backup_printer_id ? nameOf.get(p.backup_printer_id) ?? "" : ""), render: (p) => <span className="text-ink-2">{p.backup_printer_id ? nameOf.get(p.backup_printer_id) ?? "Unknown" : "—"}</span> },
    { key: "is_default_kitchen", header: "Default", sortable: true, render: (p) => (p.is_default_kitchen ? <Badge tone="seated">Default kitchen</Badge> : <span className="text-ink-2">—</span>) },
    {
      key: "status",
      header: "Relay status",
      render: (p) => {
        if (p.archived) return <StatusDot status="neutral" label="Archived" muted />;
        const s = latestStatus(relays.data ?? [], p.id);
        if (!s) return <StatusDot status="neutral" label="No report yet" muted />;
        return (
          <span className="inline-flex flex-col leading-tight">
            <StatusDot status={s.ok ? "paid" : "alert"} label={s.ok ? "Reachable" : s.error || "Not reachable"} />
            <span className="pl-4 text-caption text-ink-2" title={dayClock(s.checked_at)}>
              {s.relay} · {dayClock(s.checked_at)}
            </span>
          </span>
        );
      },
    },
    {
      key: "actions",
      header: "",
      align: "end",
      render: (p) =>
        admin && !p.archived ? (
          <Button variant="quiet" className="min-h-9 px-2.5 text-caption" onPress={() => test.mutate(p)} isPending={test.isPending && test.variables?.id === p.id}>
            Test print
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-4">
          <OutletChoice outlets={outlets} scope={scope} outletId={outletId} onChange={setOutletId} />
          <Switch isSelected={showArchived} onChange={setShowArchived} className="min-h-11 py-0">
            Show archived
          </Switch>
        </div>
        <Button variant="primary" onPress={() => setSheet({ mode: "create" })} isDisabled={!outletId || !admin}>
          Add printer
        </Button>
      </div>

      {coverage ? <Warnings warnings={coverage.warnings} className="mb-4" /> : null}
      {coverage && coverage.warnings.length === 0 && coverage.fallbackCount > 0 ? <p className="mb-4 text-caption text-ink-2">{plural(coverage.fallbackCount, "product falls", "products fall")} back to the default kitchen printer.</p> : null}
      {note ? (
        <div className="mb-4 flex flex-col gap-2" role="status">
          <p className="text-body text-ink">{note.text}</p>
          <Warnings warnings={note.warnings} />
        </div>
      ) : null}
      <InlineError error={test.error} className="mb-4" />

      {outlets.length === 0 ? (
        <EmptyState title="No outlets yet" hint="Printers belong to an outlet. Add an outlet first." />
      ) : (
        <DataTable
          aria-label="Printers"
          columns={columns}
          rows={rows}
          rowKey={(p) => p.id}
          isLoading={printers.isPending}
          defaultSort={{ column: "name", direction: "ascending" }}
          onRowAction={(p) => setSheet({ mode: "edit", printer: p })}
          rowClassName={(p) => (p.archived ? "text-ink-2" : undefined)}
          emptyState={<EmptyState variant="quiet" title="No printers at this outlet" hint={admin ? "Tap Add printer. Give it a fixed IP on the outlet LAN, port 9100." : "An Admin adds printers."} />}
        />
      )}
      <InlineError error={printers.error ?? relays.error} className="mt-4" />
      {!admin ? <p className="mt-3 text-caption text-ink-2">Printers are read-only for your role. An Admin adds, edits and tests them.</p> : null}

      {outletId ? <PrinterSheet state={sheet} outletId={outletId} printers={all} stations={stations.data ?? []} canEdit={admin} onClose={() => setSheet(null)} /> : null}
    </>
  );
}
