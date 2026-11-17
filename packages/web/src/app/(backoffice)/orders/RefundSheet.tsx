"use client";

import { Badge, Button, DescriptionList, InlineError, Money, MoneyField, Sheet, Steps, Switch, taxRows, TextField, cx, useLocale, refundableQuantity } from "@sail/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { label } from "@/components/backoffice/labels";
import { boKeys, CHECK_STATUS_LABEL, openPdf, shiftLabel, type CheckSnapshot, type Shift, type RefundCreated, type RefundQuote, type RefundRequest } from "@/components/backoffice/register";
import { Warnings } from "@/components/backoffice/Warnings";
import { idempotencyKey, req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { OrderSnapshot } from "@/lib/api/types";
import { keys } from "@/lib/query";
import { useFreshErrors } from "@/lib/fresh-errors";

type StepId = "bill" | "what" | "why" | "drawer" | "review";
type What = "full" | "lines" | "amount";

const ALL_STEPS: { id: StepId; label: string }[] = [
  { id: "bill", label: "Which bill" },
  { id: "what", label: "What" },
  { id: "why", label: "Why" },
  { id: "drawer", label: "Cash from" },
  { id: "review", label: "Review" },
];

/** Bills that still have something to give back, by the register's own status (never by subtracting amounts here). */
export function refundableChecks(checks: CheckSnapshot[]): CheckSnapshot[] {
  return checks.filter((c) => c.locked && c.paid_total > 0 && c.status !== "refunded");
}

/**
 * Refund stepper: bill → what → why → review from the register's
 * quote → "Refund $19.18". Every figure on the review step is the quote's; the
 * sheet never computes money. Manager, Finance or Admin (the caller gates it).
 */
export function RefundSheet({ order, checks, initialCheckId, isOpen, onClose }: { order: OrderSnapshot; checks: CheckSnapshot[]; initialCheckId: string | null; isOpen: boolean; onClose: () => void }) {
  const { money, clock } = useLocale();
  const qc = useQueryClient();
  const candidates = useMemo(() => refundableChecks(checks), [checks]);

  const [checkId, setCheckId] = useState<string | null>(null);
  const [step, setStep] = useState<StepId>("what");
  const [what, setWhat] = useState<What>("full");
  const [qty, setQty] = useState<Record<string, number>>({});
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [reasonId, setReasonId] = useState<string | null>(null);
  // Null until changed: then it follows whether the outlet has a receipt printer (review 4, T6).
  const [print, setPrint] = useState<boolean | null>(null);
  const [done, setDone] = useState<RefundCreated | null>(null);
  const [refundId, setRefundId] = useState(idempotencyKey);
  /** The open shift whose drawer pays cash back, or "card" to give back to the other payments only. */
  const [drawer, setDrawer] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const first = candidates.find((c) => c.id === initialCheckId) ?? (candidates.length === 1 ? candidates[0]! : null);
    setCheckId(first?.id ?? null);
    setStep(candidates.length > 1 && !first ? "bill" : "what");
    setWhat("full");
    setQty({});
    setAmount(null);
    setReason("");
    setReasonId(null);
    setPrint(null);
    setDone(null);
    setDrawer(null);
    setRefundId(idempotencyKey());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialCheckId]);

  const check = candidates.find((c) => c.id === checkId) ?? null;
  // The back office has no drawer of its own: a bill paid partly in cash asks which open shift's drawer pays it back.
  const cashPaid = !!check?.payments.some((p) => p.is_cash && p.status === "recorded");
  const cardPaid = !!check?.payments.some((p) => !p.is_cash && p.status === "recorded");
  const steps = ALL_STEPS.filter((s) => (s.id !== "bill" || candidates.length > 1) && (s.id !== "drawer" || cashPaid));
  const openShifts = useQuery({
    queryKey: boKeys.shifts(order.outlet_id, { status: "open" }),
    queryFn: () => req(api.GET("/v1/outlets/{id}/shifts", { params: { path: { id: order.outlet_id }, query: { status: "open" } } })).then((r) => r.data as unknown as Shift[]),
    enabled: isOpen && cashPaid,
  });
  const shiftsOpen = openShifts.data ?? [];
  const printers = useQuery({
    queryKey: boKeys.printers(order.outlet_id),
    queryFn: () => req(api.GET("/v1/printers", { params: { query: { outlet_id: order.outlet_id, include_archived: "true" } } })).then((r) => r.data),
    enabled: isOpen,
    staleTime: 60_000,
  });
  // With no receipt printer at the outlet the switch starts off, so a refund does not end on "the receipt did not print".
  const hasReceiptPrinter = (printers.data ?? []).some((p) => p.role === "receipt" && !p.archived);
  const printOn = print ?? hasReceiptPrinter;
  // A cash refund with no open shift has no drawer to come out of: said on the first step, not the third (review 4, T6).
  const noDrawer = cashPaid && openShifts.data !== undefined && shiftsOpen.length === 0;
  const noDrawerText = cardPaid && what !== "full" ? "No shift is open at this outlet, so no drawer can pay cash back. The refund goes back to the card only." : cardPaid ? "No shift is open at this outlet, so no drawer can pay cash back. Refund some items or an amount to the card only, or refund on a station once a shift is open." : "No shift is open at this outlet, so no drawer can pay cash back. Refund it on a station once a shift is open.";
  const noDrawerBlocks = noDrawer && !(cardPaid && what !== "full");
  // One open shift is chosen for the owner; none leaves the card as the only way back, when the bill has one.
  useEffect(() => {
    if (!openShifts.data || drawer) return;
    if (openShifts.data.length === 1) setDrawer(openShifts.data[0]!.id);
    else if (openShifts.data.length === 0 && cardPaid && what !== "full") setDrawer("card");
  }, [openShifts.data, drawer, cardPaid, what]);
  // A whole-bill refund cannot go to the card alone: choosing it again clears a card-only choice.
  useEffect(() => {
    if (what === "full") setDrawer((d) => (d === "card" ? null : d));
  }, [what]);
  const avoidCash = cashPaid && drawer === "card";
  const shiftId = cashPaid && drawer && drawer !== "card" ? drawer : undefined;
  const lineById = useMemo(() => new Map(order.lines.map((l) => [l.id, l])), [order.lines]);
  const billLines = useMemo(() => (check ? check.allocations.map((a) => ({ alloc: a, line: lineById.get(a.line_id) ?? null })).filter((x) => x.line && x.line.status !== "voided") : []), [check, lineById]);
  /** "paid $43.16 · $10.00 already refunded": the register's two figures, never their difference. */
  const paidSoFar = (c: CheckSnapshot) => `paid ${money(c.paid_total)}${c.refunded_total ? ` · ${money(c.refunded_total)} already refunded` : ""}`;

  const reasons = useQuery({
    queryKey: keys.voidReasons,
    queryFn: () => req(api.GET("/v1/void-reasons", { params: { query: {} } })).then((r) => r.data),
    enabled: isOpen,
    staleTime: 5 * 60_000,
  });
  const refundReasons = (reasons.data ?? []).filter((r) => r.for_refunds && !r.archived).sort((a, b) => a.sort - b.sort);

  const request: RefundRequest | null = useMemo(() => {
    if (what === "full") return { kind: "full" };
    if (what === "lines") {
      const lines = Object.entries(qty)
        .filter(([, q]) => q > 0)
        .map(([line_id, quantity]) => ({ line_id, quantity }));
      return lines.length ? { kind: "lines", lines } : null;
    }
    return amount && amount > 0 ? { kind: "amount", amount } : null;
  }, [what, qty, amount]);

  const quote = useQuery<RefundQuote, ApiError>({
    queryKey: ["refund-quote", checkId, request, avoidCash],
    queryFn: () => req(api.POST("/v1/checks/{id}/refunds/quote", { params: { path: { id: checkId! } }, body: { request: request!, ...(avoidCash ? { avoid_cash: true } : {}) } })).then((r) => r.data as unknown as RefundQuote),
    // An amount is checked as it is typed, so "more than was paid" is said beside the field, not only at Review.
    enabled: isOpen && (step === "review" || (step === "what" && what === "amount")) && checkId !== null && request !== null,
    retry: false,
    staleTime: 0,
  });

  const refund = useMutation<RefundCreated, ApiError>({
    mutationFn: async () => {
      const res = await api.POST("/v1/checks/{id}/refunds", {
        params: { path: { id: checkId! } },
        headers: { "Idempotency-Key": refundId },
        body: { refund_id: refundId, request: request!, reason: reason.trim(), print: printOn, ...(shiftId ? { shift_id: shiftId } : {}), ...(avoidCash ? { avoid_cash: true } : {}) },
      });
      const body = res.data as unknown as { refund: RefundCreated["refund"]; warnings: string[] };
      return { refund: body.refund, warnings: body.warnings };
    },
    onSuccess: async (r) => {
      setDone(r);
      await Promise.all([qc.invalidateQueries({ queryKey: keys.order(order.id) }), qc.invalidateQueries({ queryKey: ["refunds", order.id] }), qc.invalidateQueries({ queryKey: ["print-jobs"] }), qc.invalidateQueries({ queryKey: ["orders"] })]);
    },
  });
  const creditNote = useMutation<void, ApiError, { id: string; no: string }>({ mutationFn: ({ id, no }) => openPdf(`/v1/refunds/${id}/credit-note.pdf`, `${no}.pdf`) });

  const index = steps.findIndex((s) => s.id === step);
  const next = steps[index + 1]?.id;
  const prev = steps[index - 1]?.id;
  const canContinue = step === "bill" ? checkId !== null && !(noDrawer && !cardPaid) : step === "what" ? request !== null && !(what === "amount" && quote.isError) && !noDrawerBlocks : step === "why" ? reason.trim().length > 0 : step === "drawer" ? drawer !== null : false;

  const lineName = (id: string) => lineById.get(id)?.name ?? `Line ${id.slice(0, 8)}`;

  useFreshErrors(isOpen && order.id, null, refund, creditNote);
  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={(o) => !o && onClose()}
      isDismissable={!refund.isPending}
      width="lg"
      title={done ? `Refunded ${money(done.refund.totals.total)}` : "Refund"}
      description={done ? `${order.order_no} · ${check?.label ?? "Bill"}` : check ? `${order.order_no} · ${check.label} · ${paidSoFar(check)}` : order.order_no}
      footer={
        done ? (
          <Button variant="primary" onPress={onClose}>
            Close
          </Button>
        ) : (
          <>
            {prev ? (
              <Button variant="quiet" onPress={() => setStep(prev)} isDisabled={refund.isPending} className="mr-auto">
                Back
              </Button>
            ) : null}
            <Button variant="quiet" onPress={onClose} isDisabled={refund.isPending}>
              Cancel
            </Button>
            {step === "review" ? (
              <Button variant="primary" isDisabled={!quote.data || refund.isPending} isPending={refund.isPending} onPress={() => refund.mutate()}>
                {quote.data ? `Refund ${money(quote.data.totals.total)}` : "Refund"}
              </Button>
            ) : (
              <Button variant="primary" isDisabled={!canContinue || !next} onPress={() => next && setStep(next)}>
                Continue
              </Button>
            )}
          </>
        )
      }
    >
      {done ? (
        <div className="flex flex-col gap-6">
          <DescriptionList
            layout="grid"
            items={[
              { term: "Refund receipt", detail: <span className="font-mono">{done.refund.refund_receipt_no}</span> },
              { term: "Credit note", detail: done.refund.credit_note_no ? <span className="font-mono">{done.refund.credit_note_no}</span> : "Not invoiced" },
              { term: "Amount", detail: <Money cents={done.refund.totals.total} size="heading" />, numeric: true },
              { term: "Reason", detail: done.refund.reason },
            ]}
          />
          <div className="flex flex-wrap gap-2">
            {done.refund.credit_note_no ? (
              <Button onPress={() => creditNote.mutate({ id: done.refund.id, no: done.refund.credit_note_no! })} isPending={creditNote.isPending}>
                Download credit note PDF
              </Button>
            ) : null}
          </div>
          <Warnings warnings={done.warnings} />
          <InlineError error={creditNote.error} />
        </div>
      ) : candidates.length === 0 ? (
        <p className="text-ink-2">Nothing to refund: no bill on this order has a payment left to give back.</p>
      ) : (
        <div className="flex flex-col gap-6">
          <Steps steps={steps} current={step} onStepPress={(id) => setStep(id as StepId)} />

          {step === "bill" && noDrawer ? <p className="mb-3 text-ink-2">{noDrawerText}</p> : null}
          {step === "bill" ? (
            <ul className="flex flex-col gap-2" aria-label="Bills">
              {candidates.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => setCheckId(c.id)}
                    aria-pressed={checkId === c.id}
                    className={cx("press flex w-full items-baseline justify-between gap-4 rounded-tile px-4 py-3 text-left outline-none hairline hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-status-seated", checkId === c.id && "border-ink bg-surface-2")}
                  >
                    <span className="flex items-baseline gap-2">
                      <span className="text-line text-ink">{c.label}</span>
                      <Badge tone={c.status === "paid" ? "paid" : "bill"}>{label(CHECK_STATUS_LABEL, c.status)}</Badge>
                      {c.invoice_no ? <span className="font-mono text-caption text-ink-2">{c.invoice_no}</span> : null}
                    </span>
                    <span className="tabular text-caption text-ink-2">{paidSoFar(c)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {step === "what" && check ? (
            <div className="flex flex-col gap-4">
              {noDrawer ? <p className="text-ink-2">{noDrawerText}</p> : null}
              <div role="radiogroup" aria-label="What to refund" className="grid gap-2 sm:grid-cols-3">
                {(
                  [
                    ["full", "Whole bill", `Everything still refundable on ${check.label}; the register quotes the amount.`],
                    ["lines", "Some items", "Pick lines and quantities; modifiers follow their item."],
                    ["amount", "An amount", "Goodwill: spread across the bill's items."],
                  ] as const
                ).map(([id, title, hint]) => (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={what === id}
                    onClick={() => setWhat(id)}
                    className={cx("press flex flex-col items-start gap-1 rounded-tile px-4 py-3 text-left outline-none hairline hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-status-seated", what === id && "border-ink bg-surface-2")}
                  >
                    <span className="text-line text-ink">{title}</span>
                    <span className="text-caption text-ink-2">{hint}</span>
                  </button>
                ))}
              </div>
              {what === "lines" ? (
                <ul className="flex flex-col" aria-label="Items on the bill">
                  {billLines.map(({ alloc, line }) => {
                    const q = qty[alloc.line_id] ?? 0;
                    // Units this bill already refunded cannot be refunded again (the register reports them per bill).
                    const refunded = alloc.refunded_quantity ?? 0;
                    const max = refundableQuantity(line!.quantity, refunded);
                    return (
                      <li key={alloc.line_id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2 hairline-b">
                        <span className="min-w-0 flex-1">
                          <span className="text-ink">{line!.name}</span>
                          <span className="ml-2 text-caption text-ink-2 tabular">
                            {line!.quantity}× · <Money cents={alloc.total} size="caption" /> on this bill{alloc.share !== "1" && alloc.share !== "1/1" ? ` · share ${alloc.share}` : ""}
                            {refunded > 0 ? ` · ${refunded} already refunded` : ""}
                          </span>
                          {line!.modifiers.length ? <span className="block text-caption text-ink-2">{line!.modifiers.map((m) => m.name).join(", ")}</span> : null}
                        </span>
                        <span className="inline-flex items-center gap-1" role="group" aria-label={`Quantity of ${line!.name} to refund`}>
                          <Button variant="quiet" iconOnly aria-label="Fewer" isDisabled={q <= 0} onPress={() => setQty({ ...qty, [alloc.line_id]: q - 1 })} className="min-h-9 min-w-9 max-sm:min-h-11 max-sm:min-w-11">
                            −
                          </Button>
                          <span className="w-8 text-center tabular text-ink">{q}</span>
                          <Button variant="quiet" iconOnly aria-label="More" isDisabled={q >= max} onPress={() => setQty({ ...qty, [alloc.line_id]: q + 1 })} className="min-h-9 min-w-9 max-sm:min-h-11 max-sm:min-w-11">
                            +
                          </Button>
                        </span>
                      </li>
                    );
                  })}
                  {billLines.length === 0 ? <li className="py-2 text-ink-2">No items on this bill.</li> : null}
                </ul>
              ) : null}
              {what === "amount" ? (
                <>
                  <MoneyField label="Amount to refund" value={amount} onChange={setAmount} description={`${check.label} ${paidSoFar(check)}. The register spreads it across the bill's items and tenders, and refuses more than was paid.`} autoFocus className="max-w-[240px]" />
                  {request ? <InlineError error={quote.error} /> : null}
                </>
              ) : null}
            </div>
          ) : null}

          {step === "why" ? (
            <div className="flex flex-col gap-4">
              {refundReasons.length ? (
                <div className="flex flex-wrap gap-2" role="group" aria-label="Reasons">
                  {refundReasons.map((r) => (
                    <Button
                      key={r.id}
                      variant={reasonId === r.id ? "primary" : "secondary"}
                      onPress={() => {
                        setReasonId(r.id);
                        setReason(r.name);
                      }}
                    >
                      {r.name}
                    </Button>
                  ))}
                </div>
              ) : (
                <p className="text-caption text-ink-2">No refund reasons are configured in Settings; type one.</p>
              )}
              <TextField
                label="Reason"
                value={reason}
                onChange={(v) => {
                  setReason(v);
                  if (reasonId && v !== refundReasons.find((r) => r.id === reasonId)?.name) setReasonId(null);
                }}
                placeholder="Why the guest is getting money back"
                description="Required. It goes on the refund receipt and the audit trail."
                multiline
                rows={2}
                autoFocus={refundReasons.length === 0}
              />
            </div>
          ) : null}

          {step === "drawer" && check ? (
            <div className="flex flex-col gap-3">
              {openShifts.isPending ? <p className="text-ink-2">Looking for open shifts…</p> : null}
              {openShifts.data && shiftsOpen.length === 0 ? (
                <p className="text-ink-2">{noDrawerText}</p>
              ) : null}
              {shiftsOpen.length ? <p className="text-ink-2">{shiftsOpen.length === 1 ? "The cash comes out of the only open shift's drawer." : "Choose the open shift whose drawer pays the cash back."}</p> : null}
              <ul className="flex flex-col gap-2" aria-label="Cash from">
                {[...shiftsOpen.map((s) => ({ id: s.id, title: shiftLabel(s), detail: `${s.opened_by ? `opened by ${s.opened_by} · ` : ""}since ${clock(s.opened_at)}` })), ...(cardPaid && openShifts.data && what !== "full" ? [{ id: "card", title: "Back to the card only", detail: "Nothing is paid out in cash." }] : [])].map((o) => (
                  <li key={o.id}>
                    <button
                      type="button"
                      onClick={() => setDrawer(o.id)}
                      aria-pressed={drawer === o.id}
                      className={cx("press flex w-full items-baseline justify-between gap-4 rounded-tile px-4 py-3 text-left outline-none hairline hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-status-seated", drawer === o.id && "border-ink bg-surface-2")}
                    >
                      <span className="text-line text-ink">{o.title}</span>
                      <span className="text-caption text-ink-2">{o.detail}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <InlineError error={openShifts.error as ApiError | null} />
            </div>
          ) : null}

          {step === "review" && check ? (
            <div className="flex flex-col gap-5">
              {quote.isPending ? <p className="text-ink-2">Asking the register for the quote…</p> : null}
              <InlineError error={quote.error} />
              {quote.data ? (
                <>
                  <section>
                    <h3 className="pb-1 text-line text-ink hairline-b">Reversal</h3>
                    <ul className="flex flex-col">
                      {/* A row with no quantity and no price only moves a rounding cent of tax; the tax rows below show it. */}
                      {quote.data.lines.filter((l) => l.quantity !== 0 || l.base !== 0).map((l) => (
                        <li key={l.line_id} className="flex items-baseline justify-between gap-4 py-1.5 hairline-b">
                          <span className="text-ink">
                            {l.quantity ? <span className="tabular text-ink-2">{l.quantity}× </span> : <span className="text-caption text-ink-2">part of </span>}
                            {lineName(l.line_id)}
                          </span>
                          <Money cents={-l.base} />
                        </li>
                      ))}
                    </ul>
                    <DescriptionList
                      className="mt-2"
                      items={[
                        { term: "Items", detail: <Money cents={-quote.data.totals.base} />, numeric: true },
                        ...(quote.data.totals.discount ? [{ term: "Discounts given back", detail: <Money cents={quote.data.totals.discount} />, numeric: true }] : []),
                        ...(quote.data.totals.fee ? [{ term: "Fees", detail: <Money cents={-quote.data.totals.fee} />, numeric: true }] : []),
                        ...taxRows(quote.data.totals.taxes, order.totals.tax_mode).before.map((t) => ({ term: t.label, detail: <Money cents={-t.amount} />, numeric: true })),
                        { term: <span className="text-ink">Refund</span>, detail: <Money cents={-quote.data.totals.total} size="heading" />, numeric: true },
                        ...taxRows(quote.data.totals.taxes, order.totals.tax_mode).after.map((t) => ({ term: t.label, detail: <Money cents={-t.amount} />, numeric: true })),
                      ]}
                    />
                  </section>
                  <section>
                    <h3 className="pb-1 text-line text-ink hairline-b">Back to</h3>
                    <ul className="flex flex-col">
                      {quote.data.tenders.map((t) => (
                        <li key={t.payment_id} className="flex flex-wrap items-baseline justify-between gap-x-4 py-1.5 hairline-b">
                          <span className="text-ink">
                            {t.tender}
                            {t.is_cash ? null : <span className="ml-2 text-caption text-ink-2">Refund on the terminal, then confirm</span>}
                          </span>
                          <span className="tabular">
                            <Money cents={t.amount} />
                            {t.rounding_cents ? <span className="text-caption text-ink-2"> (rounding {money(t.rounding_cents, { signed: true })})</span> : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <DescriptionList
                      className="mt-2"
                      items={[
                        ...(quote.data.cash_out ? [{ term: "Cash handed back", detail: <Money cents={quote.data.cash_out} />, numeric: true }] : []),
                        { term: "Left on the bill after this refund", detail: <Money cents={quote.data.remaining_after.total} />, numeric: true },
                      ]}
                    />
                  </section>
                  <DescriptionList layout="grid" items={[{ term: "Reason", detail: reason.trim() }, ...(shiftId && quote.data.cash_out ? [{ term: "Cash from", detail: shiftLabel(shiftsOpen.find((s) => s.id === shiftId) ?? { name: null, station_id: null }) }] : []), { term: "Documents", detail: check.invoice_no ? `Refund receipt and a credit note against ${check.invoice_no}` : "Refund receipt" }]} />
                  <Switch isSelected={printOn} onChange={setPrint} description="On the outlet's receipt printer. The refund is recorded either way.">
                    Print the refund receipt
                  </Switch>
                </>
              ) : null}
              <InlineError error={refund.error} />
            </div>
          ) : null}
        </div>
      )}
    </Sheet>
  );
}
