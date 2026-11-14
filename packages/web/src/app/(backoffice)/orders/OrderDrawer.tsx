"use client";

import { Check, Circle, RotateCcw } from "lucide-react";
import { BusinessDay, Badge, Button, DescriptionList, Dialog, Group, InlineError, Money, Sheet, SheetSection, Skeleton, taxRows, TextField, useLocale, ValueRows, kindTone } from "@sail/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useBusinessDate } from "@/lib/business-date";
import { label, LINE_STATUS_LABEL, ORDER_STATUS_LABEL, ORDER_TYPE_LABEL, CHANNEL_LABEL } from "@/components/backoffice/labels";
import { isWaiting, JobRowActions, JobStatus } from "@/components/backoffice/PrintJobActions";
import { boKeys, can, CHECK_STATUS_LABEL, formatElapsed, openPdf, PRINT_JOB_KIND_LABEL, rolesFor, type CheckSnapshot, type InvoiceIssued, type Refund } from "@/components/backoffice/register";
import { Warnings } from "@/components/backoffice/Warnings";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { OrderSnapshot } from "@/lib/api/types";
import { keys } from "@/lib/query";
import { useSession } from "@/lib/session-context";
import { statusIcon, statusTone, whoFor } from "./OrdersView";
import { RefundSheet, refundableChecks } from "./RefundSheet";
import { useFreshErrors } from "@/lib/fresh-errors";
import { eventLabel } from "@/lib/format";

const REFUND_KIND_LABEL: Record<string, string> = { full: "Whole bill", lines: "Some items", amount: "An amount" };

/**
 * The order drawer: lines, adjustments, bills, refunds,
 * tickets, events and audit, read-only for Servers. Other roles get the actions
 * their role allows; the register enforces every one of them again.
 */
export function OrderDrawer({ orderId, outletId, tableName, onClose }: { orderId: string | null; outletId: string | null; tableName: (id: string | null) => string; onClose: () => void }) {
  const { dayClock, fullStamp, money } = useLocale();
  const { me } = useSession();
  const qc = useQueryClient();
  const readOnly = me.role === "server" || !me.role;
  const canRefund = !readOnly && can(me, "refunds.create");
  const canReopen = !readOnly && can(me, "orders.reopen");
  const canInvoice = !readOnly && can(me, "documents.issue_invoice");
  const canPrint = !readOnly && can(me, "receipts.print");
  const canReprint = !readOnly && can(me, "print_jobs.reprint");

  const [refund, setRefund] = useState<{ checkId: string | null } | null>(null);
  const [reopen, setReopen] = useState(false);
  const [reopenReason, setReopenReason] = useState("");
  const [note, setNote] = useState<{ text: string; warnings: string[] } | null>(null);
  useEffect(() => setNote(null), [orderId]);

  const order = useQuery({
    queryKey: keys.order(orderId ?? ""),
    queryFn: () => req(api.GET("/v1/orders/{id}", { params: { path: { id: orderId! } } })).then((r) => r.data as unknown as OrderSnapshot),
    enabled: orderId !== null,
  });
  const events = useQuery({
    queryKey: [...keys.outletEvents(outletId ?? ""), orderId],
    queryFn: () => req(api.GET("/v1/outlets/{id}/events", { params: { path: { id: outletId! }, query: { aggregate_id: orderId!, limit: 1000 } } })).then((r) => r.data),
    enabled: orderId !== null && outletId !== null,
  });
  const audit = useQuery({
    queryKey: keys.audit({ target_id: orderId ?? undefined }),
    queryFn: () => req(api.GET("/v1/audit", { params: { query: { target_id: orderId!, limit: 100 } } })).then((r) => r.data),
    enabled: orderId !== null,
  });
  const refunds = useQuery({
    queryKey: boKeys.orderRefunds(orderId ?? ""),
    queryFn: () => req(api.GET("/v1/orders/{id}/refunds", { params: { path: { id: orderId! } } })).then((r) => r.data as unknown as Refund[]),
    enabled: orderId !== null,
  });
  const jobs = useQuery({
    queryKey: boKeys.orderJobs(orderId ?? ""),
    queryFn: () => req(api.GET("/v1/outlets/{id}/print-jobs", { params: { path: { id: outletId! }, query: { order_id: orderId!, limit: 100 } } })).then((r) => r.data),
    enabled: orderId !== null && outletId !== null,
    refetchInterval: 15_000,
  });
  const printers = useQuery({
    queryKey: boKeys.printers(outletId ?? ""),
    queryFn: () => req(api.GET("/v1/printers", { params: { query: { outlet_id: outletId!, include_archived: "true" } } })).then((r) => r.data),
    enabled: orderId !== null && outletId !== null,
    staleTime: 60_000,
  });

  const o = order.data;
  const lines = useMemo(() => (o?.lines ?? []).slice().sort((a, b) => (a.seat_no ?? 0) - (b.seat_no ?? 0) || a.sort - b.sort), [o]);
  const checks = useMemo(() => ((o?.checks ?? []) as CheckSnapshot[]).slice().sort((a, b) => a.index - b.index), [o]);
  const refundable = useMemo(() => refundableChecks(checks), [checks]);
  // Reopening is for the register's current business day, not the browser's calendar day.
  const today = useBusinessDate(outletId);
  const sameDay = o ? o.business_date === today : false;

  const settle = async (text: string, warnings: string[] = []) => {
    setNote({ text, warnings });
    await Promise.all([qc.invalidateQueries({ queryKey: keys.order(orderId ?? "") }), qc.invalidateQueries({ queryKey: ["orders"] }), qc.invalidateQueries({ queryKey: ["print-jobs"] }), qc.invalidateQueries({ queryKey: ["audit"] }), qc.invalidateQueries({ queryKey: keys.outletEvents(outletId ?? "") })]);
  };

  const doReopen = useMutation<{ warnings: string[] }, ApiError, string>({
    mutationFn: (reason) => req(api.POST("/v1/orders/{id}/reopen", { params: { path: { id: orderId! } }, body: { reason } })),
    onSuccess: async (r) => {
      setReopen(false);
      await settle("Order reopened. Its payments are reversed and the bills are open again.", r.warnings);
    },
  });
  const printReceipt = useMutation<{ warnings: string[] }, ApiError, CheckSnapshot>({
    mutationFn: (c) => req(api.POST("/v1/checks/{id}/receipt/print", { params: { path: { id: c.id } }, body: {} })),
    onSuccess: (r, c) => settle(`Receipt for ${c.label} queued on the receipt printer.`, r.warnings),
  });
  const issueInvoice = useMutation<{ data: InvoiceIssued; warnings: string[] }, ApiError, CheckSnapshot>({
    mutationFn: (c) => req(api.POST("/v1/checks/{id}/invoice", { params: { path: { id: c.id } }, body: {} })),
    onSuccess: (r, c) => settle(r.data.reused ? `${c.label} already has invoice ${r.data.invoice_no}.` : `Invoice ${r.data.invoice_no} issued for ${c.label}.`, r.warnings),
  });
  const invoicePdf = useMutation<void, ApiError, CheckSnapshot>({ mutationFn: (c) => openPdf(`/v1/checks/${c.id}/invoice.pdf`, `${c.invoice_no ?? "invoice"}.pdf`) });
  const creditNotePdf = useMutation<void, ApiError, Refund>({ mutationFn: (r) => openPdf(`/v1/refunds/${r.id}/credit-note.pdf`, `${r.credit_note_no ?? "credit-note"}.pdf`) });
  const printRefund = useMutation<{ warnings: string[] }, ApiError, Refund>({
    mutationFn: (r) => req(api.POST("/v1/refunds/{id}/receipt/print", { params: { path: { id: r.id } }, body: {} })),
    onSuccess: (res, r) => settle(`Refund receipt ${r.refund_receipt_no} queued on the receipt printer.`, res.warnings),
  });

  const actionError = doReopen.error ?? printReceipt.error ?? issueInvoice.error ?? invoicePdf.error ?? creditNotePdf.error ?? printRefund.error;

  useFreshErrors(orderId, null, doReopen, printReceipt, issueInvoice, invoicePdf, creditNotePdf, printRefund);
  return (
    <Sheet
      isOpen={orderId !== null}
      onOpenChange={(open) => !open && onClose()}
      title={
        o ? (
          <span className="inline-flex flex-wrap items-center gap-2.5">
            {o.order_no}
            <Badge tone={statusTone(o.status)} icon={statusIcon(o.status)}>
              {label(ORDER_STATUS_LABEL, o.status)}
            </Badge>
          </span>
        ) : (
          "Order"
        )
      }
      description={
        o ? (
          <>
            {[label(ORDER_TYPE_LABEL, o.order_type), `${o.order_type === "dine_in" ? "Table " : ""}${whoFor(o, tableName)}${o.pax ? ` · ${o.pax} ${o.pax === 1 ? "guest" : "guests"}` : ""}`, label(CHANNEL_LABEL, o.channel), `opened ${dayClock(o.opened_at)}`, o.opened_by.name].filter(Boolean).join(" · ")}
            <span className="block text-caption text-ink-3">
              Business day <BusinessDay value={o.business_date} /> · {o.pricing_status === "frozen" ? "prices frozen at first payment" : "live pricing"} · v{o.version} · {o.round_count} {o.round_count === 1 ? "round" : "rounds"}
            </span>
          </>
        ) : undefined
      }
    >
      {order.isPending ? <Skeleton lines={8} /> : null}
      <InlineError error={order.error} />
      {o ? (
        <div className="flex flex-col gap-6">
          {o.ready_by || o.delivery_address || o.notes ? (
            <Group>
              <DescriptionList
                layout="grid"
                className="px-4 py-3.5"
                items={[
                  ...(o.ready_by ? [{ term: "Ready by", detail: dayClock(o.ready_by) }] : []),
                  ...(o.delivery_address ? [{ term: "Delivery address", detail: o.delivery_address }] : []),
                  ...(o.notes ? [{ term: "Notes", detail: o.notes }] : []),
                ]}
              />
            </Group>
          ) : null}

          {note ? (
            <div className="flex flex-col gap-2 rounded-[14px] bg-surface-2 px-4 py-3" role="status">
              <p className="text-body text-ink">{note.text}</p>
              <Warnings warnings={note.warnings} />
            </div>
          ) : null}
          <InlineError error={actionError} />
          {readOnly ? <p className="text-caption text-ink-2">Read-only for Servers. Refunds, reopening, receipts and invoices need a Cashier or higher.</p> : null}

          <SheetSection label="Totals">
            <Group>
              <ValueRows
                className="px-4 py-3"
                rows={[
                  { label: "Subtotal", value: <Money cents={o.totals.subtotal} /> },
                  { label: "Discounts", value: <Money cents={o.totals.discount_total} /> },
                  { label: "Fees", value: <Money cents={o.totals.fee_total} /> },
                  ...taxRows(o.totals.taxes, o.totals.tax_mode).before.map((t) => ({ label: t.label, value: <Money cents={t.amount} /> })),
                  { label: <span className="font-heading text-[15px] font-semibold">Total</span>, value: <Money cents={o.totals.total} size="heading" />, strong: true },
                  ...taxRows(o.totals.taxes, o.totals.tax_mode).after.map((t) => ({ label: t.label, value: <Money cents={t.amount} /> })),
                  { label: "Paid", value: <Money cents={o.paid_total} /> },
                  { label: <span className="font-heading text-[15px] font-semibold">Balance</span>, value: <Money cents={o.balance} size="heading" />, strong: true },
                ]}
              />
            </Group>
            {!readOnly ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button size="sm" onPress={() => setRefund({ checkId: null })} isDisabled={!canRefund || refundable.length === 0}>
                  Refund…
                </Button>
                {o.status === "completed" ? (
                  <Button
                    size="sm"
                    onPress={() => {
                      setReopenReason("");
                      setReopen(true);
                    }}
                    isDisabled={!canReopen || !sameDay}
                  >
                    Reopen order
                  </Button>
                ) : null}
                <span className="text-caption text-ink-2">{!canRefund ? rolesFor("refunds.create") : o.status === "completed" && !canReopen ? rolesFor("orders.reopen") : o.status === "completed" && !sameDay ? "Reopen: same business day only" : ""}</span>
              </div>
            ) : null}
          </SheetSection>

          <SheetSection label="Bills" aside={<span className="text-caption text-ink-3 tabular">{checks.length}</span>}>
            {checks.length === 0 ? <p className="text-ink-2">No bills yet.</p> : null}
            {checks.map((c) => {
              const paid = c.locked && c.paid_total > 0;
              return (
                <Group key={c.id}>
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3">
                    <span className="inline-flex flex-wrap items-baseline gap-2">
                      <span className="text-[14.5px] font-medium text-ink">{c.label}</span>
                      {c.seat_no ? <span className="text-caption text-ink-2">Seat {c.seat_no}</span> : null}
                      {c.invoice_no ? <span className="font-mono text-caption text-ink-2">Invoice {c.invoice_no}</span> : null}
                    </span>
                    <Badge tone={c.status === "paid" ? "paid" : c.status === "open" ? "neutral" : "bill"} icon={c.status === "paid" ? Check : c.status === "open" ? Circle : RotateCcw}>{label(CHECK_STATUS_LABEL, c.status)}</Badge>
                  </div>
                  {c.payments.length ? (
                    <ul className="flex flex-col gap-1 px-4 py-3">
                      {c.payments.map((p) => (
                        <li key={p.id} className={`flex flex-wrap items-baseline justify-between gap-x-4 text-caption ${p.status === "reversed" ? "text-ink-2 line-through" : "text-ink-2"}`}>
                          <span>
                            {p.tender}
                            {p.reference ? ` · ${p.reference}` : ""}
                            {p.recorded_by ? ` · ${p.recorded_by}` : ""} · {dayClock(p.created_at)}
                            {p.status === "reversed" ? " · reversed" : ""}
                          </span>
                          <span className="tabular">
                            <Money cents={p.amount} size="caption" />
                            {p.rounding_cents ? ` (rounding ${money(p.rounding_cents, { signed: true })})` : ""}
                            {p.tip_cents ? ` · tip ` : ""}
                            {p.tip_cents ? <Money cents={p.tip_cents} size="caption" /> : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <ValueRows
                    className="px-4 py-3"
                    rows={[
                      { label: "Paid", value: <Money cents={c.paid_total} /> },
                      ...(c.refunded_total ? [{ label: "Refunded", value: <Money cents={c.refunded_total} /> }] : []),
                      ...(c.balance ? [{ label: "Balance", value: <Money cents={c.balance} /> }] : []),
                      { label: <span className="font-heading text-[15px] font-semibold">Total</span>, value: <Money cents={c.totals.total} size="heading" />, strong: true },
                    ]}
                  />
                  {!readOnly && paid ? (
                    <div className="flex flex-wrap items-center gap-1 px-3 py-2">
                      <Button variant="quiet" className="min-h-9 px-2.5 text-caption" isDisabled={!canPrint} onPress={() => printReceipt.mutate(c)} isPending={printReceipt.isPending && printReceipt.variables?.id === c.id}>
                        Print receipt
                      </Button>
                      {c.invoice_no ? (
                        <Button variant="quiet" className="min-h-9 px-2.5 text-caption" onPress={() => invoicePdf.mutate(c)} isPending={invoicePdf.isPending && invoicePdf.variables?.id === c.id}>
                          Download invoice PDF
                        </Button>
                      ) : (
                        <Button variant="quiet" className="min-h-9 px-2.5 text-caption" isDisabled={!canInvoice} onPress={() => issueInvoice.mutate(c)} isPending={issueInvoice.isPending && issueInvoice.variables?.id === c.id}>
                          Get invoice
                        </Button>
                      )}
                      {refundable.some((r) => r.id === c.id) ? (
                        <Button variant="quiet" className="min-h-9 px-2.5 text-caption" isDisabled={!canRefund} onPress={() => setRefund({ checkId: c.id })}>
                          Refund…
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </Group>
              );
            })}
          </SheetSection>

          <SheetSection label="Lines" aside={<span className="text-caption text-ink-3 tabular">{lines.length}</span>}>
            {lines.length ? (
              <Group>
                <ul className="flex flex-col divide-y divide-rule-subtle">
                  {lines.map((l) => (
                    <li key={l.id} className={`flex flex-col gap-0.5 px-4 py-3 ${l.status === "voided" ? "text-ink-2 line-through" : ""}`}>
                      <div className="flex items-baseline gap-3">
                        <span className="w-8 shrink-0 tabular text-ink-2">{l.quantity}×</span>
                        <span className="min-w-0 flex-1 text-[14.5px] text-ink">
                          {l.name}
                          {l.seat_no ? <span className="ml-2 text-caption text-ink-2 no-underline">Seat {l.seat_no}</span> : null}
                          <Badge className="ml-2" tone={l.status === "fired" ? "sent" : l.status === "voided" ? "alert" : l.status === "held" ? "bill" : "neutral"}>
                            {label(LINE_STATUS_LABEL, l.status)}
                          </Badge>
                        </span>
                        <span className="inline-flex flex-col items-end">
                          <Money cents={l.amounts.base} />
                          {l.amounts.discount ? <Money cents={l.amounts.discount} className="text-caption text-ink-2" /> : null}
                        </span>
                      </div>
                      {l.modifiers.length ? <p className="pl-11 text-caption text-ink-2">{l.modifiers.map((m) => `${m.quantity > 1 ? `${m.quantity}× ` : ""}${m.name}`).join(", ")}</p> : null}
                      {l.notes ? <p className="pl-11 text-caption text-ink-2">“{l.notes}”</p> : null}
                      {l.void_reason ? <p className="pl-11 text-caption text-status-alert no-underline">Voided: {l.void_reason}</p> : null}
                      <p className="pl-11 text-caption text-ink-2 tabular">
                        {l.unit_price ? <Money cents={l.unit_price} size="caption" /> : "open price"} each{l.fired_at ? ` · sent ${dayClock(l.fired_at)}` : ""}
                        {l.added_by ? ` · ${l.added_by}` : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              </Group>
            ) : null}
          </SheetSection>

          <SheetSection label="Adjustments" aside={<span className="text-caption text-ink-3 tabular">{o.adjustments.length}</span>}>
            {o.adjustments.length === 0 ? (
              <p className="text-ink-2">No fees or discounts on this order.</p>
            ) : (
              <Group>
                <ul className="flex flex-col divide-y divide-rule-subtle">
                  {o.adjustments.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-3">
                      <span className="text-ink">{a.name}</span>
                      <Badge tone={kindTone(a.kind)}>{a.kind}</Badge>
                      <span className="text-caption text-ink-2">
                        v{a.rule_version}
                        {a.capped ? " · capped" : ""}
                        {a.frozen ? " · frozen" : ""}
                        {/* People by name, from the manual application: the adjustment itself holds their staff ids (live-test C-5). */}
                        {((m) => `${m?.applied_by ? ` · by ${m.applied_by}` : ""}${m?.approved_by ? ` · approved by ${m.approved_by}` : ""}`)(o.manual_applications.find((m) => m.id === a.manual_application_id) )}
                        {a.reason ? ` · ${a.reason}` : ""}
                      </span>
                      <Money cents={a.total} signed className="ml-auto" />
                    </li>
                  ))}
                </ul>
              </Group>
            )}
          </SheetSection>

          <SheetSection label="Refunds" aside={<span className="text-caption text-ink-3 tabular">{refunds.data ? `${refunds.data.length}` : "loading"}</span>}>
            <InlineError error={refunds.error} />
            {refunds.data && refunds.data.length === 0 ? <p className="text-ink-2">No refunds on this order.</p> : null}
            {(refunds.data ?? []).length ? (
              <Group>
                <ul className="flex flex-col divide-y divide-rule-subtle">
                  {(refunds.data ?? []).map((r) => (
                    <li key={r.id} className="flex flex-col gap-1 px-4 py-3">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                        <span className="inline-flex flex-wrap items-baseline gap-2">
                          <span className="font-mono text-ink">{r.refund_receipt_no}</span>
                          {r.credit_note_no ? <span className="font-mono text-caption text-ink-2">Credit note {r.credit_note_no}</span> : null}
                          <Badge>{label(REFUND_KIND_LABEL, r.kind)}</Badge>
                        </span>
                        <Money cents={-r.totals.total} />
                      </div>
                      <p className="text-caption text-ink-2">
                        {dayClock(r.created_at)}
                        {r.refunded_by ? ` · ${r.refunded_by}` : ""}
                        {r.approved_by ? ` · approved by ${r.approved_by}` : ""} · {r.reason}
                      </p>
                      {!readOnly ? (
                        <div className="-ml-2.5 flex flex-wrap items-center gap-1">
                          {r.credit_note_no ? (
                            <Button variant="quiet" className="min-h-9 px-2.5 text-caption" onPress={() => creditNotePdf.mutate(r)} isPending={creditNotePdf.isPending && creditNotePdf.variables?.id === r.id}>
                              Download credit note PDF
                            </Button>
                          ) : null}
                          <Button variant="quiet" className="min-h-9 px-2.5 text-caption" isDisabled={!canPrint} onPress={() => printRefund.mutate(r)} isPending={printRefund.isPending && printRefund.variables?.id === r.id}>
                            Reprint refund receipt
                          </Button>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </Group>
            ) : null}
          </SheetSection>

          <SheetSection label="Tickets" aside={<span className="text-caption text-ink-3 tabular">{jobs.data ? `${jobs.data.length}` : "loading"}</span>}>
            <InlineError error={jobs.error} />
            {jobs.data && jobs.data.length === 0 ? <p className="text-ink-2">Nothing printed for this order yet.</p> : null}
            {(jobs.data ?? []).length ? (
              <Group>
                <ul className="flex flex-col divide-y divide-rule-subtle">
                  {(jobs.data ?? []).map((j) => (
                    <li key={j.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2.5">
                      <span className="inline-flex min-w-0 flex-wrap items-baseline gap-2">
                        <span className="text-ink">{label(PRINT_JOB_KIND_LABEL, j.kind)}</span>
                        <span className="text-caption text-ink-2">
                          {(printers.data ?? []).find((p) => p.id === j.printer_id)?.name ?? "A removed printer"} · {dayClock(j.created_at)}
                          {j.copies > 1 ? ` · copy ${j.copy_no}/${j.copies}` : ""}
                          {isWaiting(j) ? ` · waiting ${formatElapsed(j.age_seconds)}` : ""}
                          {j.last_error ? ` · ${j.last_error}` : ""}
                        </span>
                        <JobStatus job={j} />
                      </span>
                      {canReprint ? <JobRowActions job={j} printers={printers.data ?? []} onDone={(text, warnings) => settle(text, warnings)} compact /> : null}
                    </li>
                  ))}
                </ul>
              </Group>
            ) : null}
          </SheetSection>

          <SheetSection label="Events" aside={<span className="text-caption text-ink-3 tabular">{events.data ? `${events.data.length}` : "loading"}</span>}>
            {events.isPending ? <Skeleton lines={3} /> : null}
            <InlineError error={events.error} />
            {events.data && events.data.length === 0 ? <p className="text-ink-2">No events for this order in the outlet log.</p> : null}
            {(events.data ?? []).length ? (
              <Group>
                <ol className="flex flex-col divide-y divide-rule-subtle">
                  {(events.data ?? []).map((e) => (
                    <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2.5">
                      <span className="tabular whitespace-nowrap text-ink-2" title={fullStamp(e.occurred_at)}>
                        {dayClock(e.occurred_at)}
                      </span>
                      <span className="text-caption text-ink" title={e.type}>{eventLabel(e.type)}</span>
                      <span className="text-caption text-ink-2">
                        seq {e.seq} · v{e.aggregate.version}
                        {typeof e.actor === "object" && e.actor && "name" in e.actor && e.actor.name ? ` · ${String(e.actor.name)}` : ""}
                        {e.reason && typeof e.reason === "object" && "text" in e.reason && e.reason.text ? ` · ${String(e.reason.text)}` : ""}
                      </span>
                    </li>
                  ))}
                </ol>
              </Group>
            ) : null}
          </SheetSection>

          <SheetSection label="Audit" aside={<span className="text-caption text-ink-3 tabular">{audit.data ? `${audit.data.length}` : "loading"}</span>}>
            {audit.isPending ? <Skeleton lines={3} /> : null}
            <InlineError error={audit.error} />
            {audit.data && audit.data.length === 0 ? <p className="text-ink-2">No audit entries name this order.</p> : null}
            {(audit.data ?? []).length ? (
              <Group>
                <ol className="flex flex-col divide-y divide-rule-subtle">
                  {(audit.data ?? []).map((a) => (
                    <li key={a.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2.5">
                      <span className="tabular whitespace-nowrap text-ink-2" title={fullStamp(a.occurred_at)}>
                        {dayClock(a.occurred_at)}
                      </span>
                      <span className="font-mono text-caption text-ink">{a.action}</span>
                      <span className="text-caption text-ink-2">
                        {a.actor_name ?? a.actor_type}
                        {a.actor_role ? ` (${a.actor_role})` : ""}
                        {a.approver_name ? ` · approved by ${a.approver_name}` : ""}
                        {a.reason ? ` · ${a.reason}` : ""}
                      </span>
                    </li>
                  ))}
                </ol>
              </Group>
            ) : null}
          </SheetSection>
        </div>
      ) : null}
      {o ? <RefundSheet order={o} checks={checks} initialCheckId={refund?.checkId ?? null} isOpen={refund !== null} onClose={() => setRefund(null)} /> : null}

      <Dialog
        isOpen={reopen}
        onOpenChange={(open) => !open && setReopen(false)}
        title={o ? `Reopen ${o.order_no}` : "Reopen order"}
        footer={
          <>
            <Button variant="quiet" onPress={() => setReopen(false)} isDisabled={doReopen.isPending}>
              Cancel
            </Button>
            <Button variant="primary" isDisabled={!reopenReason.trim()} isPending={doReopen.isPending} onPress={() => doReopen.mutate(reopenReason.trim())}>
              Reopen order
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 pt-2">
          <p>Reverses every payment on this order as events and unlocks its bills; the order is then recharged. Same business day only.</p>
          <TextField label="Reason" value={reopenReason} onChange={setReopenReason} placeholder="Wrong items were paid for" autoFocus />
          <InlineError error={doReopen.error} />
        </div>
      </Dialog>
    </Sheet>
  );
}
