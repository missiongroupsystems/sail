"use client";

import { ScrollText } from "lucide-react";
import { AttributionChip, Button, DataTable, EmptyState, InlineError, initialsOf, outletOwnName, Select, type DataTableColumn, useLocale, DateField } from "@sail/ui";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { createContext, useContext, useMemo, useState } from "react";
import { req } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { AuditEntry, AuditPage, Outlet, Staff } from "@/lib/api/types";
import { auditActionLabel, auditTargetLabel } from "@/lib/format";
import { useUrlState } from "@/lib/url-state";
import { keys } from "@/lib/query";
import { useSession } from "@/lib/session-context";

const ANY = "__any__";
const PAGE = 50;

/** Actions the register records in this phase (server routes). Later phases extend the list. */
// Every action and target kind the register audits, not only settings ones (live-test E-L13).
const ACTIONS = [
  "merchants.update_settings", "brands.create", "brands.update", "outlets.create", "outlets.update", "stations.create", "stations.update", "stations.pairing_code",
  "staff.create", "staff.update", "staff.invite", "staff.reset_password", "staff.revoke_access", "products.create", "products.update", "products.bulk_price",
  "modifier_groups.create", "modifier_groups.update", "menus.create", "menus.update", "pricing_rules.create_version", "pricing_rules.archive", "tax_rates.set",
  "stock.mark_sold_out", "stock.restore", "tables.rotate_qr_token", "orders.open", "orders.cancel", "orders.reopen", "adjustments.apply_manual", "adjustments.remove",
  "payments.record", "payments.cancel", "refunds.create", "overrides.grant", "shifts.open", "shifts.close", "business_days.close", "imports.apply", "imports.applied",
  "auth.sign_in", "auth.sign_out", "stock.set_daily_cap", "categories.create", "categories.update", "stations.unpair",
  "lines.void_fired", "lines.add_open_price", "orders.move_table", "orders.change_type", "payments.void", "documents.issue_invoice", "rounds.accept", "rounds.reject",
  "tables.qr_sheet", "tables.rotate_all_qr_tokens", "availability.create", "availability.update", "availability.delete", "imports.create", "customers.upsert",
  "tax_classes.create", "tax_classes.update", "tax_rates.delete", "printers.create", "printers.update", "print_jobs.reprint", "print_jobs.reroute", "print_jobs.test",
];
const TARGET_KINDS = ["merchant", "brand", "outlet", "station", "staff", "order", "check", "payment", "order_line", "product", "report_category", "modifier_group", "menu", "pricing_rule", "availability_rule", "table", "tax_class", "customer", "import_job", "shift", "business_day", "printer", "relay"];

/** Keys the register writes in minor units: shown as money, never as raw cents. Not `entered_value`: a percentage is in basis points. */
// Also the drawer's figures (expected, counted, variance) and the bill's (balance, net, tax), which the register writes in cents (E-L13).
const MONEY_KEY = /(^|_)(amount|total|price|tip|tips|float|change|rounding|cents|expected|counted|variance|balance|net|gross|tax|fee|discount|due|threshold)(_cents)?$/;

type Filters = { action?: string; actor_id?: string; target_kind?: string; from?: string; to?: string };

/** Keys an owner has no use for: ids and internal keys (the target column already names what changed). */
const HIDDEN_KEY = /(^|_)(id|ids|key)$|^(order_no|sections_replaced|archived|seeded|rule_kind)$/;
/** Words for the keys whose own name reads poorly. */
const KEY_WORDS: Record<string, string> = { action: "For", rule_name: "Rule", entered_value: "Value", order_type: "Type", invoice_no: "Invoice", refund_receipt_no: "Receipt", reversed_payments: "Payments reversed", tip_cents: "Tip", rounding_cents: "Rounding", pin_changed: "PIN changed", provider_ref: "Provider reference", takeaway_ref: "Takeaway reference" };
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An entry's details in an owner's words (live-test final2 A P-A3): amounts as money, an entered percentage as "15%",
 * no ids or internal keys, true flags as words and false ones left out, the target's own name not repeated.
 */
export function compact(entry: Pick<AuditEntry, "details" | "target_label" | "value_kind">, money: (cents: number) => string, locale?: string, stamp?: (iso: string) => string): string {
  // Basis points as the viewer's locale writes a percentage ("12.5%", "12,5 %").
  const percent = (bps: number) => new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 }).format(bps / 10_000);
  const parts: string[] = [];
  let nested = 0;
  for (const [k, v] of Object.entries(entry.details)) {
    if (v === null || v === undefined || v === false || HIDDEN_KEY.test(k)) continue;
    // No rounding or tip at all says nothing ("Rounding: $0.00" on every card payment).
    if (v === 0 && /(^|_)(rounding|tip|tips)(_cents)?$/.test(k)) continue;
    if (typeof v === "object") {
      nested++;
      continue;
    }
    if (typeof v === "string" && (UUID.test(v) || v === entry.target_label)) continue;
    const words = KEY_WORDS[k] ?? `${k.replace(/_cents$/, "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())}`;
    if (v === true) {
      parts.push(words);
      continue;
    }
    let shown: string;
    // An override names the action it approved: in words ("Refunded"), never the register's key.
    if (k === "action" && typeof v === "string" && /^[a-z_]+\.[a-z_]+$/.test(v)) shown = auditActionLabel(v);
    else if (k === "entered_value" && typeof v === "number") shown = entry.value_kind === "percent" ? percent(v) : entry.value_kind === "amount" ? money(v) : String(v);
    else if (typeof v === "number" && Number.isInteger(v) && MONEY_KEY.test(k)) shown = money(v);
    else if (typeof v === "string" && /^[a-z]+(_[a-z]+)+$/.test(v)) shown = v.replace(/_/g, " ");
    // An instant ("effective_from") in the merchant's time and words, never as the register stores it (review 5, V8).
    else if (typeof v === "string" && ISO_INSTANT.test(v) && stamp) shown = stamp(v);
    else shown = String(v);
    parts.push(k === "rule_name" ? shown : `${words}: ${shown}`);
  }
  if (nested) parts.push(`+${nested} more`);
  const text = parts.join(" · ");
  return text.length > 96 ? `${text.slice(0, 95)}…` : text || "—";
}

/** The action in words; archiving or restoring through an update says so ("Archived menu"). */
export function actionLabel(a: Pick<AuditEntry, "action" | "target_kind" | "details">): string {
  const archived = a.details.archived;
  // Only an update that does nothing but archive or restore reads as one; a wider update keeps its own words.
  const onlyArchive = Object.keys(a.details).every((k) => ["archived", "name", "sections_replaced"].includes(k)) && a.details.sections_replaced !== true;
  if (typeof archived === "boolean" && onlyArchive) return `${archived ? "Archived" : "Restored"} ${auditTargetLabel(a.target_kind).toLowerCase()}`;
  // Staff are deactivated, not "changed" (review 3, P4).
  if (a.action === "staff.update" && typeof a.details.active === "boolean") return a.details.active ? "Reactivated staff" : "Deactivated staff";
  // A fee applied or removed by hand is a fee, not a discount (review 5, V8).
  if (a.details.rule_kind === "fee" && a.action === "adjustments.apply_manual") return "Applied a fee";
  if (a.details.rule_kind === "fee" && a.action === "adjustments.remove") return "Removed a fee";
  return auditActionLabel(a.action);
}

/** Targets whose label already says what they are ("P-0007 · Bill 1", "Table 7", a person's name). */
const SELF_NAMED = new Set(["order", "check", "payment", "order_line", "table", "staff"]);

/** The initials set on each staff record, so the audit's chips match Team and the side rail (E-N13). */
const StaffInitials = createContext<Map<string, string>>(new Map());
/** Each outlet's own name, when the list covers more than one outlet: order numbers and channels repeat outlet by outlet. */
const TargetOutlets = createContext<Map<string, string>>(new Map());
const BY_OUTLET = new Set(["order", "channel_link"]);

/** "P-0001 · Market" and "Channel · Market" where the outlet tells two rows apart; the target alone otherwise. */
function OutletOf({ entry: a }: { entry: AuditEntry }) {
  const name = useContext(TargetOutlets).get(a.outlet_id ?? "");
  return name && BY_OUTLET.has(a.target_kind) ? <span className="text-ink-2"> · {name}</span> : null;
}

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
  const { money, locale, fullStamp } = useLocale();
  return (
    <span className="text-ink-2 break-words">
      {a.reason ? `${a.reason} · ` : ""}
      {compact(a, (c) => money(c), locale, (iso) => fullStamp(iso))}
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
        {/* The name on one line; the role at the time is in its tooltip, not repeated on every row. */}
        {a.actor_name || !["station", "relay", "agent", "guest"].includes(a.actor_type) ? (
          <span className="min-w-0 truncate whitespace-nowrap text-ink" title={[a.actor_name, a.actor_role].filter(Boolean).join(" · ")}>
            {a.actor_name ?? a.actor_type}
          </span>
        ) : null}
      </span>
    ),
  },
  {
    key: "action",
    header: "Action",
    render: (a) => <span className="text-ink">{actionLabel(a)}</span>,
  },
  {
    key: "target",
    header: "Target",
    // The register's words for the target: "P-0007 · Bill 1", "Product Kopi"; a target that no longer exists by its kind alone.
    render: (a) => (
      <span className="block min-w-0 break-words">
        {/* "Station 2" names its kind already: never "Station Station 2". */}
        {a.target_label && (SELF_NAMED.has(a.target_kind) || a.target_label.toLowerCase().startsWith(`${auditTargetLabel(a.target_kind).toLowerCase()} `)) ? (
          <>
            <span className="text-ink tabular">{a.target_label}</span>
            <OutletOf entry={a} />
          </>
        ) : (
          <>
            <span className={a.target_label ? "text-ink-2" : "text-ink"}>{auditTargetLabel(a.target_kind)}</span>
            {a.target_label ? <span className="text-ink"> {a.target_label}</span> : null}
            <OutletOf entry={a} />
          </>
        )}
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

const dayStart = (d: string) => (d ? new Date(`${d}T00:00:00`).toISOString() : undefined);
const dayEnd = (d: string) => (d ? new Date(`${d}T23:59:59.999`).toISOString() : undefined);

export type AuditInitial = { action: string | null; actor: string | null; target: string | null; from: string | null; to: string | null };

export function AuditView({ initialPage, staff, outlets, initial }: { initialPage: AuditPage; staff: Staff[]; /** The outlets the list covers: the brand in scope's, or the one chosen. */ outlets: Outlet[]; initial?: AuditInitial }) {
  // The filters live in the address, as on the other pages, so a refresh or a shared link keeps them.
  const [filters, setFilters] = useState<Filters>(() => ({ action: initial?.action ?? undefined, actor_id: initial?.actor ?? undefined, target_kind: initial?.target ?? undefined, from: dayStart(initial?.from ?? ""), to: dayEnd(initial?.to ?? "") }));
  const [fromDate, setFromDate] = useState(initial?.from ?? "");
  const [toDate, setToDate] = useState(initial?.to ?? "");
  useUrlState({ action: filters.action, actor: filters.actor_id, target: filters.target_kind, from: fromDate, to: toDate });
  // The list is the brand in scope: entries at its outlets, and the merchant-wide ones. The register filters, page by page.
  const { scope, brands } = useSession();
  const brandName = brands.find((b) => b.id === scope.brandId)?.name;
  const outletNames = useMemo(() => {
    const covered = scope.outletId ? outlets.filter((o) => o.id === scope.outletId) : outlets;
    return new Map(covered.length > 1 ? covered.map((o) => [o.id, outletOwnName(o.name, brandName)]) : []);
  }, [outlets, scope.outletId, brandName]);
  const filtered = useMemo(() => toQuery(filters), [filters]);
  const unfiltered = Object.keys(filtered).length === 0;
  const query = useMemo(() => ({ ...filtered, ...(scope.brandId ? { brand_id: scope.brandId } : {}) }), [filtered, scope.brandId]);

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
      from: dayStart(from),
      to: dayEnd(to),
    }));
  };

  const set = (key: keyof Filters) => (value: string | null) => setFilters((f) => ({ ...f, [key]: value && value !== ANY ? value : undefined }));

  const initials = useMemo(() => new Map(staff.filter((m) => m.initials).map((m) => [m.id, m.initials!])), [staff]);
  return (
    <StaffInitials.Provider value={initials}>
    <TargetOutlets.Provider value={outletNames}>
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
          {pages.hasNextPage ? " shown" : ""}
        </span>
      </div>
    </TargetOutlets.Provider>
    </StaffInitials.Provider>
  );
}
