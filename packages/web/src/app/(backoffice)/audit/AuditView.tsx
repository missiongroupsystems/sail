"use client";

import { ScrollText } from "lucide-react";
import { AttributionChip, Button, DataTable, EmptyState, InlineError, initialsOf, Select, type DataTableColumn, useLocale, DateField } from "@sail/ui";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { createContext, useContext, useMemo, useState } from "react";
import { req } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { AuditEntry, AuditPage, Staff } from "@/lib/api/types";
import { auditActionLabel, auditTargetLabel, shortId } from "@/lib/format";
import { keys } from "@/lib/query";

const ANY = "__any__";
const PAGE = 50;

/** Actions the register records in this phase (server routes). Later phases extend the list. */
// Every action and target kind the register audits, not only settings ones (live-test E-L13).
const ACTIONS = [
  "merchants.update_settings", "brands.create", "brands.update", "outlets.create", "outlets.update", "stations.create", "stations.update", "stations.pairing_code",
  "staff.create", "staff.update", "staff.invite", "staff.reset_password", "staff.revoke_access", "products.create", "products.update", "products.bulk_price",
  "modifier_groups.create", "modifier_groups.update", "menus.create", "menus.update", "pricing_rules.create_version", "pricing_rules.archive", "tax_rates.set",
  "stock.mark_sold_out", "stock.restore", "tables.rotate_qr_token", "orders.open", "orders.cancel", "orders.reopen", "adjustments.apply_manual", "adjustments.remove",
  "payments.record", "payments.cancel", "refunds.create", "overrides.grant", "shifts.open", "shifts.close", "business_days.close", "imports.apply",
  "auth.sign_in", "auth.sign_out", "stock.set_daily_cap", "categories.create", "categories.update", "stations.unpair",
];
const TARGET_KINDS = ["merchant", "brand", "outlet", "station", "staff", "order", "check", "payment", "product", "report_category", "modifier_group", "menu", "pricing_rule", "table", "tax_class", "shift", "business_day", "printer", "relay"];

/** Keys the register writes in minor units: shown as money, never as raw cents. Not `entered_value`: a percentage is in basis points. */
// Also the drawer's figures (expected, counted, variance) and the bill's (balance, net, tax), which the register writes in cents (E-L13).
const MONEY_KEY = /(^|_)(amount|total|price|tip|tips|float|change|rounding|cents|expected|counted|variance|balance|net|gross|tax|fee|discount|due|threshold)(_cents)?$/;

type Filters = { action?: string; actor_id?: string; target_kind?: string; from?: string; to?: string };

function compact(details: Record<string, unknown>, money: (cents: number) => string): string {
  const parts = Object.entries(details)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
    .map(([k, v]) => `${k.replace(/_cents$/, "").replace(/_/g, " ")}: ${typeof v === "number" && Number.isInteger(v) && MONEY_KEY.test(k) ? money(v) : String(v)}`);
  const nested = Object.entries(details).filter(([, v]) => v && typeof v === "object").length;
  if (nested) parts.push(`+${nested} more`);
  const text = parts.join(" · ");
  return text.length > 96 ? `${text.slice(0, 95)}…` : text || "—";
}

/** The initials set on each staff record, so the audit's chips match Team and the side rail (E-N13). */
const StaffInitials = createContext<Map<string, string>>(new Map());

function Who({ entry: a }: { entry: AuditEntry }) {
  const initials = useContext(StaffInitials);
  return who(a, a.actor_id ? initials.get(a.actor_id) : undefined);
}

function who(a: AuditEntry, set?: string) {
  if (a.actor_type === "agent") return <AttributionChip who={{ kind: "assistant", forName: a.on_behalf_of ?? undefined }} />;
  if (a.actor_type === "guest") return <AttributionChip who={{ kind: "guest" }} />;
  if (a.actor_type === "station" || a.actor_type === "relay") return <AttributionChip who={{ kind: "system", label: a.actor_type === "station" ? "Station" : "Print relay" }} />;
  return <AttributionChip who={{ kind: "person", initials: set ?? initialsOf(a.actor_name) }} />;
}

function Details({ entry: a }: { entry: AuditEntry }) {
  const { money } = useLocale();
  return (
    <span className="text-ink-2 break-words" title={JSON.stringify(a.details, null, 2)}>
      {a.reason ? `${a.reason} · ` : ""}
      {compact(a.details, (c) => money(c))}
    </span>
  );
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
      <span className="flex min-w-0 items-center gap-2">
        <Who entry={a} />
        {/* A station or relay without a name is said once, by its chip. */}
        {/* The name on one line, the role in grey after it, so a row is one line high. */}
        {a.actor_name || !["station", "relay", "agent", "guest"].includes(a.actor_type) ? (
          <span className="min-w-0 truncate whitespace-nowrap text-ink" title={[a.actor_name, a.actor_role].filter(Boolean).join(" · ")}>
            {a.actor_name ?? a.actor_type}
            {a.actor_role ? <span className="text-ink-2"> · {a.actor_role}</span> : null}
          </span>
        ) : null}
      </span>
    ),
  },
  { key: "action", header: "Action", render: (a) => <span className="text-ink" title={a.action}>{auditActionLabel(a.action)}</span> },
  {
    key: "target",
    header: "Target",
    render: (a) => (
      <span className="block min-w-0 whitespace-nowrap">
        <span className="text-ink">{auditTargetLabel(a.target_kind)}</span>
        {a.target_id ? <span className="text-ink-3 tabular" title={a.target_id}> {shortId(a.target_id)}</span> : null}
      </span>
    ),
  },
  { key: "approval", header: "Approved by", render: (a) => (a.approver_name ? <span className="whitespace-nowrap">{a.approver_name}</span> : <span className="text-ink-2">—</span>) },
  { key: "details", header: "Details", render: (a) => <Details entry={a} /> },
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

  const initials = useMemo(() => new Map(staff.filter((m) => m.initials).map((m) => [m.id, m.initials!])), [staff]);
  return (
    <StaffInitials.Provider value={initials}>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select aria-label="Action" variant="toolbar" size="sm" selectedKey={filters.action ?? ANY} onSelectionChange={set("action")} items={[{ id: ANY, label: "Any action" }, ...ACTIONS.map((a) => ({ id: a, label: auditActionLabel(a) }))]} />
        <Select
          aria-label="Actor"
          variant="toolbar" size="sm"
          selectedKey={filters.actor_id ?? ANY}
          onSelectionChange={set("actor_id")}
          items={[{ id: ANY, label: "Anyone" }, ...staff.map((s) => ({ id: s.id, label: s.name, description: s.active ? undefined : "Inactive" }))]}
        />
        <Select aria-label="Target" variant="toolbar" size="sm" selectedKey={filters.target_kind ?? ANY} onSelectionChange={set("target_kind")} items={[{ id: ANY, label: "Any target" }, ...TARGET_KINDS.map((t) => ({ id: t, label: auditTargetLabel(t) }))]} />
        <DateField aria-label="From date" prefix="From" value={fromDate} onChange={(v) => applyDates(v, toDate)} className="w-[240px]" />
        <DateField aria-label="To date" prefix="To" value={toDate} onChange={(v) => applyDates(fromDate, v)} className="w-[240px]" />
        {!unfiltered ? (
          <Button size="sm" variant="quiet" onPress={() => { setFilters({}); setFromDate(""); setToDate(""); }}>
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
        emptyState={<EmptyState variant="centred" icon={ScrollText} title="No entries match" hint="Widen the filters or the date range." />}
      />
      <InlineError error={pages.error} className="mt-4" />

      <div className="mt-4 flex items-center gap-4">
        {pages.hasNextPage ? (
          <Button onPress={() => pages.fetchNextPage()} isPending={pages.isFetchingNextPage}>
            Show older entries
          </Button>
        ) : null}
        <span className="text-[13px] text-ink-2 tabular">
          {rows.length} {rows.length === 1 ? "entry" : "entries"}
          {pages.hasNextPage ? " shown" : rows.length ? " · that is everything" : ""}
        </span>
      </div>
    </StaffInitials.Provider>
  );
}
