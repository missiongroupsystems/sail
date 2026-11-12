"use client";

import { AttributionChip, Button, DataTable, EmptyState, InlineError, initialsOf, Select, TextField, type DataTableColumn, useLocale } from "@sail/ui";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { req } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { AuditEntry, AuditPage, Staff } from "@/lib/api/types";
import { shortId } from "@/lib/format";
import { keys } from "@/lib/query";

const ANY = "__any__";
const PAGE = 50;

/** Actions the register records in this phase (server routes). Later phases extend the list. */
const ACTIONS = ["merchants.update_settings", "brands.create", "brands.update", "outlets.create", "outlets.update", "stations.create", "stations.update", "staff.create", "staff.update"];
const TARGET_KINDS = ["merchant", "brand", "outlet", "station", "staff"];

type Filters = { action?: string; actor_id?: string; target_kind?: string; from?: string; to?: string };

function compact(details: Record<string, unknown>): string {
  const parts = Object.entries(details)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
    .map(([k, v]) => `${k}: ${String(v)}`);
  const nested = Object.entries(details).filter(([, v]) => v && typeof v === "object").length;
  if (nested) parts.push(`+${nested} more`);
  const text = parts.join(" · ");
  return text.length > 96 ? `${text.slice(0, 95)}…` : text || "—";
}

function who(a: AuditEntry) {
  if (a.actor_type === "agent") return <AttributionChip who={{ kind: "assistant", forName: a.on_behalf_of ?? undefined }} />;
  if (a.actor_type === "guest") return <AttributionChip who={{ kind: "guest" }} />;
  if (a.actor_type === "station" || a.actor_type === "relay") return <AttributionChip who={{ kind: "system", label: a.actor_type === "station" ? "Station" : "Print relay" }} />;
  return <AttributionChip who={{ kind: "person", initials: initialsOf(a.actor_name) }} />;
}

function When({ iso }: { iso: string }) {
  const { fullStamp, dayClock } = useLocale();
  return (
    <span className="tabular whitespace-nowrap" title={fullStamp(iso)}>
      {dayClock(iso)}
    </span>
  );
}

const columns: DataTableColumn<AuditEntry>[] = [
  { key: "occurred_at", header: "When", isRowHeader: true, render: (a) => <When iso={a.occurred_at} /> },
  {
    key: "actor",
    header: "Who",
    render: (a) => (
      <span className="inline-flex items-center gap-2">
        {who(a)}
        <span>
          <span className="text-ink">{a.actor_name ?? a.actor_type}</span>
          {a.actor_role ? <span className="text-caption text-ink-2"> · {a.actor_role}</span> : null}
        </span>
      </span>
    ),
  },
  { key: "action", header: "Action", render: (a) => <span className="font-mono text-caption">{a.action}</span> },
  {
    key: "target",
    header: "Target",
    render: (a) => (
      <span>
        {a.target_kind} <span className="font-mono text-caption text-ink-2" title={a.target_id ?? undefined}>{shortId(a.target_id)}</span>
      </span>
    ),
  },
  { key: "approval", header: "Approved by", render: (a) => (a.approver_name ? a.approver_name : <span className="text-ink-2">—</span>) },
  { key: "details", header: "Details", render: (a) => <span className="text-ink-2" title={JSON.stringify(a.details, null, 2)}>{a.reason ? `${a.reason} · ` : ""}{compact(a.details)}</span> },
];

function toQuery(f: Filters) {
  const q: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) if (v) q[k] = v;
  return q;
}

export function AuditView({ initialPage, staff }: { initialPage: AuditPage; staff: Staff[] }) {
  const [filters, setFilters] = useState<Filters>({});
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const query = useMemo(() => toQuery(filters), [filters]);
  const unfiltered = Object.keys(query).length === 0;

  const pages = useInfiniteQuery({
    queryKey: keys.audit(query),
    queryFn: ({ pageParam }) => req(api.GET("/v1/audit", { params: { query: { ...query, limit: PAGE, cursor: pageParam } } })),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
    initialData: unfiltered ? { pages: [initialPage], pageParams: [undefined] } : undefined,
  });

  const rows = pages.data?.pages.flatMap((p) => p.data) ?? [];

  const applyDates = (from: string, to: string) => {
    setFromDate(from);
    setToDate(to);
    setFilters((f) => ({
      ...f,
      from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
      to: to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined,
    }));
  };

  const set = (key: keyof Filters) => (value: string | null) => setFilters((f) => ({ ...f, [key]: value && value !== ANY ? value : undefined }));

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Select aria-label="Action" variant="toolbar" selectedKey={filters.action ?? ANY} onSelectionChange={set("action")} items={[{ id: ANY, label: "Any action" }, ...ACTIONS.map((a) => ({ id: a, label: a }))]} />
        <Select
          aria-label="Actor"
          variant="toolbar"
          selectedKey={filters.actor_id ?? ANY}
          onSelectionChange={set("actor_id")}
          items={[{ id: ANY, label: "Anyone" }, ...staff.map((s) => ({ id: s.id, label: s.name, description: s.active ? undefined : "Inactive" }))]}
        />
        <Select aria-label="Target" variant="toolbar" selectedKey={filters.target_kind ?? ANY} onSelectionChange={set("target_kind")} items={[{ id: ANY, label: "Any target" }, ...TARGET_KINDS.map((t) => ({ id: t, label: t }))]} />
        <TextField aria-label="From date" type="date" numeric value={fromDate} onChange={(v) => applyDates(v, toDate)} className="w-[170px]" />
        <TextField aria-label="To date" type="date" numeric value={toDate} onChange={(v) => applyDates(fromDate, v)} className="w-[170px]" />
        {!unfiltered ? (
          <Button variant="quiet" onPress={() => { setFilters({}); setFromDate(""); setToDate(""); }}>
            Clear filters
          </Button>
        ) : null}
      </div>

      <DataTable
        aria-label="Audit log"
        columns={columns}
        rows={rows}
        rowKey={(a) => a.id}
        isLoading={pages.isPending}
        className={pages.isPlaceholderData ? "opacity-60" : undefined}
        emptyState={<EmptyState variant="quiet" title="No entries match" hint="Widen the filters or the date range." />}
      />
      <InlineError error={pages.error} className="mt-4" />

      <div className="mt-4 flex items-center gap-4">
        {pages.hasNextPage ? (
          <Button onPress={() => pages.fetchNextPage()} isPending={pages.isFetchingNextPage}>
            Show older entries
          </Button>
        ) : null}
        <span className="text-caption text-ink-2 tabular">
          {rows.length} {rows.length === 1 ? "entry" : "entries"}
          {pages.hasNextPage ? " shown" : rows.length ? " · that is everything" : ""}
        </span>
      </div>
    </>
  );
}
