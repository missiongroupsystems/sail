"use client";

import { Check, ChefHat, Circle, CircleX, Inbox, Send, Truck, type LucideIcon } from "lucide-react";
import { Badge, DataTable, FilterTabs, EmptyState, InlineError, Money, Select, TextField, type DataTableColumn, useLocale, DateField } from "@sail/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useBusinessDate } from "@/lib/business-date";
import { label, ORDER_STATUS_LABEL, ORDER_TYPES, ORDER_TYPE_LABEL } from "@/components/backoffice/labels";
import { OutletChoice, useOutletChoice } from "@/components/backoffice/OutletChoice";
import { req } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { OrderSnapshot, Outlet } from "@/lib/api/types";
import type { Scope } from "@/lib/cookies";
import { keys } from "@/lib/query";
import { StatTile, StatTiles } from "@/components/backoffice/StatTiles";
import { OrderDrawer } from "./OrderDrawer";

const OPEN_STATUSES = new Set(["open", "fired", "ready", "out_for_delivery"]);

const ANY = "__any__";
type Range = "today" | "all";

export function statusTone(status: string): "neutral" | "seated" | "sent" | "bill" | "paid" | "alert" {
  switch (status) {
    case "open":
      return "seated";
    case "fired":
      return "sent";
    case "ready":
    case "out_for_delivery":
      return "bill";
    case "completed":
      return "paid";
    case "cancelled":
      return "alert";
    default:
      return "neutral";
  }
}

/** An icon for each order status, so a pill is never colour alone. */
export function statusIcon(status: string): LucideIcon | undefined {
  return ({ open: Circle, fired: Send, ready: ChefHat, out_for_delivery: Truck, completed: Check, cancelled: CircleX } as Record<string, LucideIcon>)[status];
}

type StatusTab = "all" | "open" | "completed" | "cancelled";

function useDebounced(value: string, ms = 250): string {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function whoFor(o: OrderSnapshot, tableName: (id: string | null) => string): string {
  if (o.order_type === "dine_in") return tableName(o.table_id);
  const ref = o.customer_ref;
  return ref?.name || ref?.mobile || "—";
}

/** Orders: today and all, per outlet, with a read-only detail drawer. Amounts are the register's. */
export function OrdersView({ outlets, scope, initialOutletId }: { outlets: Outlet[]; scope: Scope; initialOutletId: string | null }) {
  const { clock, dayClock } = useLocale();
  const { outletId, setOutletId } = useOutletChoice(outlets, scope, initialOutletId);
  const today = useBusinessDate(outletId);
  const [range, setRange] = useState<Range>("today");
  // Status is a tab the register filters by; the chosen tab shows how many rows came back.
  const [statusTab, setStatusTab] = useState<StatusTab>("all");
  const [orderType, setOrderType] = useState<string | null>(null);
  const [date, setDate] = useState("");
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const dq = useDebounced(q.trim());

  const filters = useMemo(
    () => ({
      // The tab is a filter the register applies, so it covers every order, not only the 200 returned.
      ...(statusTab === "open" ? { open_only: "true" as const } : statusTab === "all" ? {} : { status: statusTab }),
      order_type: orderType ?? undefined,
      business_date: range === "today" ? (today ?? undefined) : date || undefined,
      q: dq || undefined,
    }),
    [statusTab, orderType, range, date, dq, today],
  );

  const orders = useQuery({
    queryKey: keys.orders(outletId ?? "", filters),
    queryFn: () =>
      req(api.GET("/v1/outlets/{id}/orders", { params: { path: { id: outletId! }, query: { ...filters, order_type: filters.order_type as (typeof ORDER_TYPES)[number] | undefined, limit: 200 } } })).then((r) => r.data as unknown as OrderSnapshot[]),
    enabled: outletId !== null && (range !== "today" || today !== null),
    placeholderData: keepPreviousData,
    refetchInterval: range === "today" ? 15_000 : false,
  });
  const tables = useQuery({
    queryKey: keys.tables(outletId ?? ""),
    queryFn: () => req(api.GET("/v1/tables", { params: { query: { outlet_id: outletId!, include_archived: "true" } } })).then((r) => r.data),
    enabled: outletId !== null,
    staleTime: 60_000,
  });
  const tableName = (id: string | null) => (id ? tables.data?.find((t) => t.id === id)?.name ?? "Table" : "—");

  const columns: DataTableColumn<OrderSnapshot>[] = [
    { key: "order_no", header: "Order", isRowHeader: true, render: (o) => <span className="font-medium text-ink">{o.order_no}</span> },
    { key: "opened_at", header: "Opened", sortable: true, render: (o) => <span className="tabular whitespace-nowrap" title={dayClock(o.opened_at)}>{range === "today" ? clock(o.opened_at) : dayClock(o.opened_at)}</span> },
    { key: "order_type", header: "Type", sortable: true, render: (o) => label(ORDER_TYPE_LABEL, o.order_type) },
    { key: "status", header: "Status", sortable: true, render: (o) => <Badge tone={statusTone(o.status)} icon={statusIcon(o.status)}>{label(ORDER_STATUS_LABEL, o.status)}</Badge> },
    {
      key: "who",
      header: "Table / customer",
      render: (o) => (
        // One line, so a row is 44px: the covers follow the table in grey.
        <span className="whitespace-nowrap">
          <span className="text-ink">{whoFor(o, tableName)}</span>
          {o.pax ? <span className="text-ink-2"> · {o.pax} pax</span> : null}
        </span>
      ),
    },
    { key: "lines", header: "Items", numeric: true, render: (o) => o.lines.filter((l) => l.status !== "voided").reduce((n, l) => n + l.quantity, 0) },
    { key: "total", header: "Total", numeric: true, sortable: true, sortValue: (o) => o.totals.total, render: (o) => <Money cents={o.totals.total} /> },
        // "Paid" only for money that was paid: a cancelled order, or one with nothing on it yet, has no balance to settle (C-8, E-L12).
    { key: "balance", header: "Balance", numeric: true, render: (o) => (o.status === "cancelled" ? <span className="text-ink-2">Cancelled</span> : o.balance !== 0 ? <Money cents={o.balance} className="font-medium text-status-sent" /> : o.paid_total > 0 ? <span className="text-ink-2">Paid</span> : <span className="text-ink-2">—</span>) },
  ];

  const shown = orders.data ?? [];
  // Counts of the rows on screen; no amount is worked out here.
  const openCount = shown.filter((o) => OPEN_STATUSES.has(o.status)).length;
  const completedCount = shown.filter((o) => o.status === "completed").length;
  const covers = shown.filter((o) => o.status !== "cancelled").reduce((n, o) => n + (o.pax ?? 0), 0);

  return (
    <>
      {outlets.length > 0 ? (
        <StatTiles className="mb-6">
          <StatTile label="Orders shown" value={orders.data ? shown.length : "—"} caption={range === "today" ? "today, with the filters below" : "with the filters below"} />
          <StatTile label="Open" value={orders.data ? openCount : "—"} />
          <StatTile label="Completed" value={orders.data ? completedCount : "—"} />
          <StatTile label="Covers" value={orders.data ? covers : "—"} />
        </StatTiles>
      ) : null}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <OutletChoice outlets={outlets} scope={scope} outletId={outletId} onChange={setOutletId} />
        <FilterTabs<Range>
          aria-label="Range"
          className="self-center"
          selectedId={range}
          onSelect={setRange}
          options={[
            { id: "today", label: "Today" },
            { id: "all", label: "All orders" },
          ]}
        />
        {range === "all" ? <DateField aria-label="Business date" value={date} onChange={setDate} className="w-[200px]" /> : null}
        <FilterTabs<StatusTab>
          aria-label="Status"
          className="self-center"
          selectedId={statusTab}
          onSelect={setStatusTab}
          options={(["all", "open", "completed", "cancelled"] as const).map((id) => ({ id, label: id === "all" ? "All" : id === "open" ? "Open" : id === "completed" ? "Completed" : "Cancelled", count: id === statusTab && orders.data ? shown.length : undefined }))}
        />
        <Select aria-label="Order type" variant="toolbar" size="sm" selectedKey={orderType ?? ANY} onSelectionChange={(k) => setOrderType(k === ANY ? null : k)} items={[{ id: ANY, label: "Any type" }, ...ORDER_TYPES.map((t) => ({ id: t, label: ORDER_TYPE_LABEL[t]! }))]} />
        <TextField size="sm" aria-label="Search orders" type="search" value={q} onChange={setQ} placeholder="Order number or customer" className="w-[240px]" />
      </div>

      {outlets.length === 0 ? (
        <EmptyState title="No outlets yet" hint="Orders belong to an outlet. Add an outlet first." />
      ) : (
        <DataTable
          aria-label="Orders"
          columns={columns}
          rows={shown}
          rowKey={(o) => o.id}
          isLoading={orders.isPending}
          className={orders.isPlaceholderData ? "opacity-60" : undefined}
          onRowAction={(o) => setOpenId(o.id)}
          emptyState={<EmptyState variant="centred" icon={Inbox} title={range === "today" ? "No orders today" : "No orders match"} hint={range === "today" ? "Orders appear here as stations open them." : "Try another date or clear the filters."} />}
        />
      )}
      <InlineError error={orders.error} className="mt-4" />
      <p className="mt-4 text-caption text-ink-2 tabular">
        {shown.length} {shown.length === 1 ? "order" : "orders"}
        {range === "today" ? " · refreshes every 15 s" : " · up to 200 shown"}
      </p>

      <OrderDrawer orderId={openId} outletId={outletId} tableName={tableName} onClose={() => setOpenId(null)} />
    </>
  );
}
