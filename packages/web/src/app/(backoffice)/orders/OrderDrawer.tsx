"use client";

import { Badge, DescriptionList, InlineError, Money, SectionHeading, Sheet, Skeleton } from "@sail/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { label, LINE_STATUS_LABEL, ORDER_STATUS_LABEL, ORDER_TYPE_LABEL, CHANNEL_LABEL } from "@/components/backoffice/labels";
import { req } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { OrderSnapshot, OutletEvent } from "@/lib/api/types";
import { formatDayClock, formatFullStamp, shortId } from "@/lib/format";
import { keys } from "@/lib/query";
import { statusTone, whoFor } from "./OrdersView";

/** Fetch the outlet's event log in pages and keep the ones about this aggregate. The API has no per-aggregate filter yet. */
async function eventsFor(outletId: string, aggregateId: string): Promise<OutletEvent[]> {
  const out: OutletEvent[] = [];
  let after = 0;
  for (let i = 0; i < 20; i++) {
    const page = await req(api.GET("/v1/outlets/{id}/events", { params: { path: { id: outletId }, query: { after, limit: 1000 } } }));
    out.push(...page.data.filter((e) => e.aggregate.id === aggregateId));
    if (!page.has_more || page.data.length === 0) break;
    after = page.data[page.data.length - 1]!.seq;
  }
  return out;
}

export function OrderDrawer({ orderId, outletId, tableName, onClose }: { orderId: string | null; outletId: string | null; tableName: (id: string | null) => string; onClose: () => void }) {
  const order = useQuery({
    queryKey: keys.order(orderId ?? ""),
    queryFn: () => req(api.GET("/v1/orders/{id}", { params: { path: { id: orderId! } } })).then((r) => r.data as unknown as OrderSnapshot),
    enabled: orderId !== null,
  });
  const events = useQuery({
    queryKey: [...keys.outletEvents(outletId ?? ""), orderId],
    queryFn: () => eventsFor(outletId!, orderId!),
    enabled: orderId !== null && outletId !== null,
  });
  const audit = useQuery({
    queryKey: keys.audit({ target_id: orderId ?? undefined }),
    queryFn: () => req(api.GET("/v1/audit", { params: { query: { target_id: orderId!, limit: 100 } } })).then((r) => r.data),
    enabled: orderId !== null,
  });

  const o = order.data;
  const lines = useMemo(() => (o?.lines ?? []).slice().sort((a, b) => (a.seat_no ?? 0) - (b.seat_no ?? 0) || a.sort - b.sort), [o]);

  return (
    <Sheet isOpen={orderId !== null} onOpenChange={(open) => !open && onClose()} width="lg" title={o ? <span className="font-mono">{o.order_no}</span> : "Order"} description={o ? `${label(ORDER_TYPE_LABEL, o.order_type)} · ${label(CHANNEL_LABEL, o.channel)} · opened ${formatDayClock(o.opened_at)}${o.opened_by.name ? ` by ${o.opened_by.name}` : ""}` : undefined}>
      {order.isPending ? <Skeleton lines={8} /> : null}
      <InlineError error={order.error} />
      {o ? (
        <div className="flex flex-col gap-8">
          <DescriptionList
            layout="grid"
            items={[
              { term: "Status", detail: <Badge tone={statusTone(o.status)}>{label(ORDER_STATUS_LABEL, o.status)}</Badge> },
              { term: o.order_type === "dine_in" ? "Table" : "Customer", detail: `${whoFor(o, tableName)}${o.pax ? ` · ${o.pax} pax` : ""}` },
              { term: "Business date", detail: o.business_date, numeric: true },
              { term: "Pricing", detail: o.pricing_status === "frozen" ? "Frozen at first payment" : "Live" },
              ...(o.ready_by ? [{ term: "Ready by", detail: formatDayClock(o.ready_by) }] : []),
              ...(o.delivery_address ? [{ term: "Delivery address", detail: o.delivery_address }] : []),
              ...(o.notes ? [{ term: "Notes", detail: o.notes }] : []),
              { term: "Version", detail: `v${o.version} · ${o.round_count} ${o.round_count === 1 ? "round" : "rounds"}`, numeric: true },
            ]}
          />

          <section>
            <SectionHeading title="Lines" aside={`${lines.length}`} />
            <ul className="flex flex-col">
              {lines.map((l) => (
                <li key={l.id} className={`flex flex-col gap-0.5 py-2 hairline-b ${l.status === "voided" ? "text-ink-2 line-through" : ""}`}>
                  <div className="flex items-baseline gap-3">
                    <span className="w-8 shrink-0 tabular text-ink-2">{l.quantity}×</span>
                    <span className="min-w-0 flex-1 text-ink">
                      {l.name}
                      {l.seat_no ? <span className="ml-2 text-caption text-ink-2 no-underline">Seat {l.seat_no}</span> : null}
                      <Badge className="ml-2" tone={l.status === "fired" ? "sent" : l.status === "voided" ? "alert" : l.status === "held" ? "bill" : "neutral"}>
                        {label(LINE_STATUS_LABEL, l.status)}
                      </Badge>
                    </span>
                    <span className="inline-flex flex-col items-end">
                      <Money cents={l.amounts.total} />
                      {l.amounts.discount ? <Money cents={l.amounts.discount} className="text-caption text-ink-2" /> : null}
                    </span>
                  </div>
                  {l.modifiers.length ? <p className="pl-11 text-caption text-ink-2">{l.modifiers.map((m) => `${m.quantity > 1 ? `${m.quantity}× ` : ""}${m.name}`).join(", ")}</p> : null}
                  {l.notes ? <p className="pl-11 text-caption text-ink-2">“{l.notes}”</p> : null}
                  {l.void_reason ? <p className="pl-11 text-caption text-status-alert no-underline">Voided: {l.void_reason}</p> : null}
                  <p className="pl-11 text-caption text-ink-2 tabular">
                    {l.unit_price ? <Money cents={l.unit_price} size="caption" /> : "open price"} each{l.fired_at ? ` · sent ${formatDayClock(l.fired_at)}` : ""}
                    {l.added_by ? ` · ${l.added_by}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <SectionHeading title="Adjustments" aside={`${o.adjustments.length}`} />
            {o.adjustments.length === 0 ? (
              <p className="mt-2 text-ink-2">No fees or discounts on this order.</p>
            ) : (
              <ul className="flex flex-col">
                {o.adjustments.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2 hairline-b">
                    <span className="text-ink">{a.name}</span>
                    <Badge tone={a.kind === "fee" ? "sent" : "seated"}>{a.kind}</Badge>
                    <span className="text-caption text-ink-2">
                      v{a.rule_version}
                      {a.capped ? " · capped" : ""}
                      {a.frozen ? " · frozen" : ""}
                      {a.applied_by ? ` · by ${a.applied_by}` : ""}
                      {a.approved_by ? ` · approved by ${a.approved_by}` : ""}
                      {a.reason ? ` · ${a.reason}` : ""}
                    </span>
                    <Money cents={a.total} signed className="ml-auto" />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <SectionHeading title="Totals" />
            <DescriptionList
              className="mt-1"
              items={[
                { term: "Subtotal", detail: <Money cents={o.totals.subtotal} />, numeric: true },
                { term: "Discounts", detail: <Money cents={o.totals.discount_total} />, numeric: true },
                { term: "Fees", detail: <Money cents={o.totals.fee_total} />, numeric: true },
                { term: o.totals.tax_mode === "inclusive" ? "GST (included)" : "GST", detail: <Money cents={o.totals.gst_total} />, numeric: true },
                { term: <span className="text-ink">Total</span>, detail: <Money cents={o.totals.total} size="heading" />, numeric: true },
                { term: "Paid", detail: <Money cents={o.paid_total} />, numeric: true },
                { term: "Balance", detail: <Money cents={o.balance} />, numeric: true },
              ]}
            />
          </section>

          <section>
            <SectionHeading title="Events" aside={events.data ? `${events.data.length}` : "loading"} />
            {events.isPending ? <Skeleton lines={3} className="mt-2" /> : null}
            <InlineError error={events.error} className="mt-2" />
            {events.data && events.data.length === 0 ? <p className="mt-2 text-ink-2">No events for this order in the outlet log.</p> : null}
            <ol className="flex flex-col">
              {(events.data ?? []).map((e) => (
                <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2 hairline-b">
                  <span className="tabular whitespace-nowrap text-ink-2" title={formatFullStamp(e.occurred_at)}>
                    {formatDayClock(e.occurred_at)}
                  </span>
                  <span className="font-mono text-caption text-ink">{e.type}</span>
                  <span className="text-caption text-ink-2">
                    seq {e.seq} · v{e.aggregate.version}
                    {typeof e.actor === "object" && e.actor && "name" in e.actor && e.actor.name ? ` · ${String(e.actor.name)}` : ""}
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <section>
            <SectionHeading title="Audit" aside={audit.data ? `${audit.data.length}` : "loading"} />
            {audit.isPending ? <Skeleton lines={3} className="mt-2" /> : null}
            <InlineError error={audit.error} className="mt-2" />
            {audit.data && audit.data.length === 0 ? <p className="mt-2 text-ink-2">No audit entries name this order.</p> : null}
            <ol className="flex flex-col">
              {(audit.data ?? []).map((a) => (
                <li key={a.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2 hairline-b">
                  <span className="tabular whitespace-nowrap text-ink-2" title={formatFullStamp(a.occurred_at)}>
                    {formatDayClock(a.occurred_at)}
                  </span>
                  <span className="font-mono text-caption text-ink">{a.action}</span>
                  <span className="text-caption text-ink-2">
                    {a.actor_name ?? a.actor_type}
                    {a.actor_role ? ` (${a.actor_role})` : ""}
                    {a.approver_name ? ` · approved by ${a.approver_name}` : ""}
                    {a.reason ? ` · ${a.reason}` : ""}
                  </span>
                  <span className="font-mono text-caption text-ink-2">{shortId(a.id)}</span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      ) : null}
    </Sheet>
  );
}
