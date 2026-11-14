"use client";

import { AmountPad, Button, Icon, Money, QuantityStepper, ReasonPicker, Sheet, taxRows, TextField, type PickedReason, useLocale } from "@sail/ui";
import { Check, ChevronRight, KeyRound } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Button as AriaButton } from "react-aria-components";
import { idempotencyKey, toApiError } from "@/lib/api";
import type { CheckSnapshot, OrderSnapshot, RefundQuote, RefundRequest, RefundResult } from "../api/types";
import { useVoidReasons } from "../hooks/queries";
import { roleAtLeast, type OrderActions } from "../hooks/useOrderActions";
import { usePos } from "./PosContext";
import { GREY_PILL, PANEL } from "./styles";

type Step = "bill" | "what" | "why" | "backto" | "review" | "done";
type What = "full" | "lines" | "amount";

const STEPS: { id: Step; label: string }[] = [
  { id: "bill", label: "Which bill" },
  { id: "what", label: "What" },
  { id: "why", label: "Why" },
  { id: "backto", label: "Back to" },
  { id: "review", label: "Review" },
];

export type RefundSheetProps = {
  isOpen: boolean;
  onClose: () => void;
  order: OrderSnapshot;
  actions: OrderActions;
  /** Start on this bill (from a paid bill's own Refund button). */
  initialCheckId?: string | null;
};

/**
 * The refund stepper: which bill, what, why, back to which tenders,
 * review of the register's quote, then "Refund $19.18" or "Manager approval".
 * The summary on the right follows every step.
 */
export function RefundSheet({ isOpen, onClose, order, actions, initialCheckId }: RefundSheetProps) {
  const { money } = useLocale();
  const { staff, offline } = usePos();
  const reasonsQuery = useVoidReasons();
  const refundable = useMemo(() => order.checks.filter((c) => c.paid_total > 0 && c.status !== "refunded"), [order.checks]);

  const [step, setStep] = useState<Step>("bill");
  const [checkId, setCheckId] = useState<string | null>(null);
  const [what, setWhat] = useState<What>("full");
  const [qty, setQty] = useState<Record<string, number>>({});
  const [digits, setDigits] = useState("");
  const [reason, setReason] = useState<PickedReason | null>(null);
  const [note, setNote] = useState("");
  const [split, setSplit] = useState<Record<string, number> | null>(null);
  const [editingTender, setEditingTender] = useState<string | null>(null);
  const [tenderDigits, setTenderDigits] = useState("");
  const [reference, setReference] = useState("");
  const [quote, setQuote] = useState<RefundQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RefundResult | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // One refund id per opening of the sheet: a retry after a timeout replays, never refunds twice.
  const refundId = useRef(idempotencyKey());

  useEffect(() => {
    if (!isOpen) return;
    refundId.current = idempotencyKey();
    const first = initialCheckId ?? (refundable.length === 1 ? refundable[0]!.id : null);
    setCheckId(first);
    setStep(first ? "what" : "bill");
    setWhat("full");
    setQty({});
    setDigits("");
    setReason(null);
    setNote("");
    setSplit(null);
    setEditingTender(null);
    setReference("");
    setQuote(null);
    setQuoteError(null);
    setResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialCheckId]);

  const check: CheckSnapshot | null = order.checks.find((c) => c.id === checkId) ?? null;
  const hasTip = Boolean(check?.payments.some((p) => p.status === "recorded" && p.tip_cents > 0));
  const linesById = useMemo(() => new Map(order.lines.map((l) => [l.id, l])), [order.lines]);

  const request: RefundRequest | null = useMemo(() => {
    if (what === "full") return { kind: "full" };
    if (what === "lines") {
      const lines = Object.entries(qty)
        .filter(([, n]) => n > 0)
        .map(([line_id, quantity]) => ({ line_id, quantity }));
      return lines.length ? { kind: "lines", lines } : null;
    }
    const amount = Number(digits || "0");
    return amount > 0 ? { kind: "amount", amount } : null;
  }, [what, qty, digits]);

  const tenderSplit = useMemo(() => (split ? Object.entries(split).map(([payment_id, amount]) => ({ payment_id, amount })).filter((t) => t.amount > 0) : undefined), [split]);

  // Nothing picked: the last quote no longer applies, so no tender, hand-back or total of it stays on screen (B-N3).
  useEffect(() => {
    if (request) return;
    if (timer.current) clearTimeout(timer.current);
    setQuote(null);
    setQuoteError(null);
    setQuoting(false);
  }, [request]);

  // The register quotes every change: per line, service charge, tax, rounding and the tender split.
  useEffect(() => {
    if (!isOpen || !check || !request || step === "bill" || step === "done") return;
    if (timer.current) clearTimeout(timer.current);
    setQuoting(true);
    timer.current = setTimeout(async () => {
      try {
        const q = await actions.quoteRefund(check.id, request, tenderSplit);
        setQuote(q);
        setQuoteError(null);
      } catch (e) {
        const err = toApiError(e);
        setQuote(null);
        setQuoteError(err.remedy ? `${err.message}. ${err.remedy}` : err.message);
      } finally {
        setQuoting(false);
      }
    }, 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [isOpen, check, request, tenderSplit, step, actions]);

  const reasons = useMemo(() => {
    const all = reasonsQuery.data ?? [];
    const forRefunds = all.filter((r) => r.for_refunds);
    return (forRefunds.length ? forRefunds : all).map((r) => ({ id: r.id, name: r.name }));
  }, [reasonsQuery.data]);

  const reasonText = reason ? `${reason.text}${note.trim() ? ` · ${note.trim()}` : ""}` : "";
  const total = quote?.totals.total ?? 0;
  const canRefund = roleAtLeast(staff.role, "manager");
  const next = (): Step | null => {
    switch (step) {
      case "bill":
        return checkId ? "what" : null;
      case "what":
        return request ? "why" : null;
      case "why":
        return reason ? "backto" : null;
      case "backto":
        return quote ? "review" : null;
      default:
        return null;
    }
  };
  const prev = (): Step | null => {
    const order_: Step[] = ["bill", "what", "why", "backto", "review"];
    const i = order_.indexOf(step);
    if (i <= 0) return null;
    const p = order_[i - 1]!;
    if (p === "bill" && initialCheckId) return null;
    return p;
  };

  const submit = async () => {
    if (!check || !request || !quote || !reason) return;
    setBusy(true);
    const res = await actions.refund(check, { refund_id: refundId.current, request, ...(tenderSplit ? { tender_split: tenderSplit } : {}), reason: reasonText, ...(reference.trim() ? { reference: reference.trim() } : {}), print: true }, total, quote.tip ?? 0);
    setBusy(false);
    if (res) {
      setResult(res);
      setStep("done");
    }
  };

  const nothingPicked = (what === "lines" && !Object.values(qty).some((n) => n > 0)) || (what === "amount" && !digits);
  const footer =
    step === "done" ? (
      <>
        {result ? (
          <Button size="lg" variant="secondary" isDisabled={offline} onPress={() => void actions.printRefundReceipt(result.refund.id)} className="mr-auto">
            Print receipt
          </Button>
        ) : null}
        <Button size="lg" variant="primary" onPress={onClose}>
          Done
        </Button>
      </>
    ) : (
      <>
        {prev() ? (
          <Button size="lg" variant="quiet" onPress={() => setStep(prev()!)} isDisabled={busy} className="mr-auto">
            Back
          </Button>
        ) : null}
        {step === "review" ? (
          <Button
            size="lg"
            variant="primary"
            isDisabled={offline || busy || quoting || !quote || total <= 0}
            isPending={busy}
            onPress={submit}
            aria-label={offline ? undefined : canRefund ? undefined : `Refund ${money(total)}, Manager approval`}
          >
            {/* The amount is the label; a needed approval follows it on the same line as a light key chip, as on the order dock. */}
            <span>{offline ? "Offline" : `Refund ${money(total)}`}</span>
            {!canRefund && !offline ? (
              <span className="inline-flex items-center gap-1 rounded-chip bg-on-primary/15 px-1.5 text-[12px] leading-[20px] font-medium text-on-primary">
                <Icon icon={KeyRound} size={12} />
                Manager
              </span>
            ) : null}
          </Button>
        ) : (
          <Button size="lg" variant="primary" isDisabled={!next() || busy} onPress={() => setStep(next()!)}>
            {step === "bill" ? "Choose this bill" : step === "what" ? (request ? "Next: why" : what === "lines" ? "Pick at least one item" : what === "amount" ? "Enter an amount" : "Next") : step === "why" ? (reason ? "Next: back to" : "Pick a reason") : quoteError ? "Fix the amounts" : "Review"}
          </Button>
        )}
      </>
    );

  return (
    <Sheet labelledClose isOpen={isOpen} onOpenChange={(o) => (!o ? onClose() : undefined)} title={step === "done" && result ? "Refunded" : "Refund"} description={check ? `${check.label} · paid ${money(check.paid_total)}` : "Pick the bill to refund from"} width="lg" isDismissable={!busy} footer={footer} className="bg-bg! sm:max-w-[min(1100px,calc(100%-16px))]!">
      {step === "done" && result ? (
        // Refund done: the result centred, a grey line over the amount in large type, the receipt number, and
        // where the money went in small rows under it.
        <div className="flex min-h-full flex-col items-center justify-center gap-2 py-10 text-center">
          <span aria-hidden className="mb-2 flex size-14 items-center justify-center rounded-full bg-status-paid-tint text-status-paid">
            <Icon icon={Check} size={24} />
          </span>
          <p className="text-[16px] text-ink-2">Refunded · {check?.label}</p>
          <Money cents={result.refund.totals.total} size="amount-xl" className="font-heading text-[40px] leading-tight font-semibold text-ink" />
          {result.refund.refund_receipt_no ? <p className="text-body text-ink-2 tabular">Refund receipt {result.refund.refund_receipt_no}</p> : null}
          {result.refund.credit_note_no ? <p className="text-body text-ink-2 tabular">Credit note {result.refund.credit_note_no}</p> : null}
          <dl className="mt-4 flex w-full max-w-[380px] flex-col gap-1 rounded-tile bg-surface-2 px-4 py-3 text-left text-[14.5px]">
            <Line label="Reason" value={result.refund.reason} />
            {result.refund.quote.tenders.map((t) => (
              <Fragment key={t.payment_id}>
                <Line label={`Back to ${t.tender}`} value={money(t.amount)} />
                {t.tip_cents ? <Line label="Tip given back" value={money(t.tip_cents)} /> : null}
              </Fragment>
            ))}
            {result.refund.quote.cash_out > 0 ? <Line label="Cash handed back" value={money(result.refund.quote.cash_out)} /> : result.refund.quote.given_back != null ? <Line label="Handed back in all" value={money(result.refund.quote.given_back)} /> : null}
          </dl>
          {result.refund.quote.tenders.some((t) => !t.is_cash) ? <p className="text-body text-ink-2">Card refunds are made on the terminal.</p> : null}
        </div>
      ) : (
        <div className="flex items-start gap-4">
          <div className={PANEL + " min-w-0 flex-1 p-5"}>
            {/* A progress row, not buttons: the steps are moved through with Next and Back. */}
            <ol className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]" aria-label="Steps">
              {STEPS.filter((s) => s.id !== "bill" || !initialCheckId).map((s, i) => (
                <li key={s.id} aria-current={s.id === step ? "step" : undefined} className={`inline-flex items-center gap-2 ${s.id === step ? "font-semibold text-ink" : "text-ink-3"}`}>
                  {i > 0 ? <Icon icon={ChevronRight} size={13} className="text-ink-3" /> : null}
                  {i + 1}. {s.label}
                </li>
              ))}
            </ol>

            {step === "bill" ? (
              <div className="flex flex-col gap-2">
                {refundable.length === 0 ? <p className="text-body text-ink-2">Nothing has been paid on this order yet, so there is nothing to refund.</p> : null}
                {refundable.map((c) => (
                  <AriaButton key={c.id} onPress={() => setCheckId(c.id)} aria-pressed={checkId === c.id} className={`press pos-touch flex min-h-16 w-full items-center justify-between gap-3 rounded-tile bg-surface px-4 text-left text-ink outline-none data-[pressed]:scale-[0.98] data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus ${checkId === c.id ? "shadow-[inset_0_0_0_2px_var(--ink)]" : "shadow-[inset_0_0_0_1px_var(--line-strong)] data-[hovered]:bg-surface-2"}`}>
                    <span>
                      <span className="block text-line">{c.label}{c.seat_no != null ? ` · Seat ${c.seat_no}` : ""}</span>
                      <span className="block text-caption opacity-80">
                        {c.payments.filter((p) => p.status === "recorded").map((p) => `${p.tender} ${money(p.amount)}`).join(" · ")}
                        {c.refunded_total > 0 ? ` · refunded ${money(c.refunded_total)}` : ""}
                      </span>
                    </span>
                    <Money cents={c.paid_total} size="line" />
                  </AriaButton>
                ))}
              </div>
            ) : null}

            {step === "what" && check ? (
              <div className="flex flex-col gap-4">
                <div className="grid grid-cols-3 gap-2" role="group" aria-label="What to refund">
                  {(["full", "lines", "amount"] as What[]).map((w) => (
                    <Button key={w} size="lg" variant={what === w ? "primary" : "quiet"} aria-pressed={what === w} onPress={() => setWhat(w)} className={"min-h-14" + (what === w ? "" : " " + GREY_PILL)}>
                      {w === "full" ? "Whole bill" : w === "lines" ? "Some items" : "An amount"}
                    </Button>
                  ))}
                </div>
                {what === "lines" ? (
                  <ul className="flex flex-col gap-1">
                    {check.allocations.map((a) => {
                      const l = linesById.get(a.line_id);
                      if (!l || l.status === "voided") return null;
                      // What the register says is still refundable from this bill; a line refunded in full is not offered again.
                      const left = l.quantity - (a.refunded_quantity ?? 0);
                      if (left <= 0) return null;
                      const n = qty[a.line_id] ?? 0;
                      return (
                        <li key={a.line_id} className={`flex min-h-16 items-center gap-3 rounded-tile px-3 ${n > 0 ? "shadow-[inset_0_0_0_1.5px_var(--ink)]" : ""}`}>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-line text-ink">
                              {l.name}
                              {a.share !== "1" ? <span className="ml-2 rounded-chip bg-surface px-1.5 text-caption text-ink-2 tabular">{a.share}</span> : null}
                            </span>
                            <span className="block text-caption text-ink-2 tabular">
                              {l.quantity} on the order{a.refunded_quantity ? ` · ${a.refunded_quantity} already refunded` : ""} · {money(a.base)} on this bill
                            </span>
                          </span>
                          <QuantityStepper value={n} onChange={(v) => setQty({ ...qty, [a.line_id]: v })} min={0} max={left} label={`${l.name} quantity to refund`} />
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
                {what === "amount" ? (
                  <div className="flex justify-center">
                    <AmountPad digits={digits} onChange={setDigits} mode="cents" hint={`Paid ${money(check.paid_total)}${check.refunded_total > 0 ? ` · ${money(check.refunded_total)} already refunded` : ""} · goodwill, spread across the bill`} />
                  </div>
                ) : null}
                {what === "full" ? <p className="text-body text-ink-2">Everything paid on {check.label} goes back, including service charge, tax, cash rounding{hasTip ? " and the tip" : ""}, as the register works them out.</p> : hasTip ? <p className="text-body text-ink-2">The tip stays with the bill unless you choose Whole bill.</p> : null}
              </div>
            ) : null}

            {step === "why" ? (
              <div className="flex flex-col gap-4">
                {reason ? (
                  <div className="flex items-center justify-between gap-3 rounded-tile bg-surface-2 px-4 py-3">
                    <span className="text-line text-ink">{reason.text}</span>
                    <Button variant="quiet" size="md" onPress={() => setReason(null)}>
                      Change
                    </Button>
                  </div>
                ) : (
                  <ReasonPicker reasons={reasons} onPick={setReason} />
                )}
                <TextField label="Add a note (optional)" value={note} onChange={setNote} inputClassName="min-h-14 text-line" maxLength={Math.max(0, Math.min(160, 200 - (reason?.text.length ?? 0) - 3))} />
              </div>
            ) : null}

            {step === "backto" && check ? (
              <div className="flex flex-col gap-3">
                <p className="text-body text-ink-2">Prefilled from the register's quote: the refund goes back to the original payments, within what each one took. Tap an amount to change it.</p>
                {quoteError ? <p className="text-body text-status-alert">{quoteError}</p> : null}
                <ul className="flex flex-col gap-2">
                  {(quote?.payments ?? check.payments.filter((p) => p.status === "recorded").map((p) => ({ payment_id: p.id, tender: p.tender, is_cash: p.is_cash, amount: p.amount, refunded: 0 }))).map((p) => {
                    const suggested = quote?.tenders.find((t) => t.payment_id === p.payment_id);
                    const amount = split?.[p.payment_id] ?? suggested?.amount ?? 0;
                    const editing = editingTender === p.payment_id;
                    return (
                      <li key={p.payment_id} className="rounded-tile bg-surface-2 px-4 py-3">
                        <div className="flex items-center justify-between gap-3">
                          <span className="min-w-0">
                            <span className="block text-line text-ink">{p.tender}</span>
                            <span className="block text-caption text-ink-2 tabular">
                              paid {money(p.amount)}
                              {p.refunded > 0 ? ` · already refunded ${money(p.refunded)}` : ""}
                              {!p.is_cash ? " · Refund on the terminal, then tap Refunded" : suggested?.rounding_cents ? ` · cash rounding ${money(suggested.rounding_cents)}` : ""}
                            </span>
                          </span>
                          <AriaButton
                            onPress={() => {
                              setEditingTender(editing ? null : p.payment_id);
                              setTenderDigits(String(amount));
                            }}
                            aria-label={`Refund ${money(amount)} to ${p.tender}, tap to change`}
                            className="press pos-touch min-h-12 rounded-tile bg-surface px-4 text-title tabular text-ink outline-none hairline data-[pressed]:scale-[0.98]"
                          >
                            {money(amount)}
                          </AriaButton>
                        </div>
                        {editing ? (
                          <div className="mt-3 flex flex-col items-center gap-2">
                            <AmountPad
                              digits={tenderDigits}
                              onChange={(d) => {
                                setTenderDigits(d);
                                const base = Object.fromEntries((quote?.tenders ?? []).map((t) => [t.payment_id, t.amount]));
                                setSplit({ ...base, ...(split ?? {}), [p.payment_id]: Number(d || "0") });
                              }}
                              mode="cents"
                            />
                            <Button size="md" variant="quiet" onPress={() => setEditingTender(null)}>
                              Done
                            </Button>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
                {split ? (
                  <Button size="md" variant="quiet" onPress={() => setSplit(null)} className="self-start">
                    Back to the register's split
                  </Button>
                ) : null}
                {(quote?.tenders ?? []).some((t) => !t.is_cash) ? <TextField label="Terminal reference (optional)" value={reference} onChange={setReference} inputClassName="min-h-14 text-line" className="max-w-[360px]" maxLength={80} mono /> : null}
              </div>
            ) : null}

            {step === "review" && quote && check ? (
              <div className="flex flex-col gap-3">
                <ul className="flex flex-col">
                  {quote.lines.map((l) => (
                    <li key={l.line_id} className="flex items-center justify-between gap-3 py-1.5">
                      <span className="text-line text-ink">
                        {l.quantity} {linesById.get(l.line_id)?.name ?? "Item"}
                      </span>
                      {/* The line's menu price; discounts, fees and tax reversed are the rows below, so the column adds up. */}
                      <Money cents={-l.base} size="line" className="text-ink" />
                    </li>
                  ))}
                  {quote.lines.length === 0 ? (
                    <li className="flex items-center justify-between gap-3 py-1.5">
                      <span className="text-line text-ink">Goodwill amount</span>
                      <Money cents={-quote.totals.base} size="line" className="text-ink" />
                    </li>
                  ) : null}
                </ul>
                <dl className="pt-2 hairline-t">
                  {quote.totals.discount !== 0 ? <Line label="Discounts reversed" value={money(-quote.totals.discount)} /> : null}
                  {quote.totals.fee !== 0 ? <Line label="Service and fees" value={money(-quote.totals.fee)} /> : null}
                  {taxRows(quote.totals.taxes, order.totals.tax_mode).before.map((t) => (
                    <Line key={t.key} label={t.label} value={money(-t.amount)} />
                  ))}
                  <div className="mt-1 flex items-center justify-between gap-3 pt-2 hairline-t">
                    <dt className="text-title text-ink">Refund</dt>
                    <dd>
                      <Money cents={quote.totals.total} size="title" className="text-ink" />
                    </dd>
                  </div>
                  {taxRows(quote.totals.taxes, order.totals.tax_mode).after.map((t) => (
                    <Line key={t.key} label={t.label} value={money(-t.amount)} />
                  ))}
                </dl>
                <TenderRows quote={quote} />
                <p className="text-body text-ink-2">Reason: {reasonText}</p>
                {!canRefund ? <p className="text-body text-ink-2">Refunds need a Manager. The approval sheet opens with this summary.</p> : null}
              </div>
            ) : null}
          </div>

          <aside className={PANEL + " w-[320px] shrink-0 p-5"} aria-label="Refund summary">
            <h3 className="font-heading text-[16px] font-semibold text-ink">The register's quote</h3>
            <dl className="mt-3 flex flex-col gap-2 text-[14.5px]">
              <Line label="Bill" value={check ? check.label : "—"} />
              <Line label="What" value={what === "full" ? "Whole bill" : what === "lines" ? ((n) => `${n} ${n === 1 ? "item" : "items"}`)(Object.values(qty).filter((n) => n > 0).length) : digits ? money(Number(digits)) : "An amount"} />
              <Line label="Why" value={reasonText || "—"} />
              <Line label="Back to" value={quote ? quote.tenders.map((t) => `${t.tender} ${money(t.amount)}`).join(", ") || "—" : "—"} />
              {quote && what === "full" && quote.tip ? <Line label="Tip given back" value={money(quote.tip)} /> : null}
            </dl>
            <div className="mt-4 flex items-center justify-between border-t border-rule pt-3">
              <span className="font-heading text-[17px] font-semibold text-ink">Refund</span>
              {/* Nothing picked yet: no figure, rather than the last quote's (live-test B-F13). */}
              {nothingPicked ? <span className="text-title text-ink-3">—</span> : quoting ? <span className="text-caption text-ink-2">Checking…</span> : <Money cents={total} size="title" className="font-heading text-ink" />}
            </div>
            {quote && !quoting && quote.given_back != null && quote.given_back !== total ? (
              <div className="mt-1 flex items-center justify-between text-[14.5px]">
                <span className="text-ink-2">Handed back</span>
                <Money cents={quote.given_back} size="body" className="text-ink" />
              </div>
            ) : null}
            {quoteError && step !== "backto" ? <p className="mt-2 text-caption text-status-alert">{quoteError}</p> : null}
          </aside>
        </div>
      )}
    </Sheet>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-ink-2">{label}</dt>
      <dd className="min-w-0 text-right text-ink tabular">{value}</dd>
    </div>
  );
}

/**
 * Where the refund goes, as the register quoted it: each payment's amount, its tip given back as its own row (a
 * whole-bill refund only), cash rounding, then what is handed back in all and in cash. Nothing is added up here.
 */
function TenderRows({ quote }: { quote: RefundQuote }) {
  const { money } = useLocale();
  return (
    <dl className="flex flex-col gap-1 rounded-tile bg-surface-2 px-4 py-3 text-[14.5px]" aria-label="Given back">
      {quote.tenders.map((t) => (
        <Fragment key={t.payment_id}>
          <Line label={`${t.tender}${!t.is_cash ? " · refund on the terminal, then tap Refunded" : ""}`} value={money(t.amount)} />
          {t.tip_cents ? <Line label="Tip given back" value={money(t.tip_cents)} /> : null}
          {t.rounding_cents ? <Line label="Cash rounding" value={money(t.rounding_cents)} /> : null}
        </Fragment>
      ))}
      {/* "In all" only where it is more than one row's figure; cash only where it differs from that (no row says the same amount twice). */}
      {quote.given_back != null && (quote.tenders.length > 1 || quote.tenders.some((t) => t.tip_cents || t.rounding_cents)) ? <Line label="Handed back in all" value={money(quote.given_back)} /> : null}
      {quote.cash_out > 0 && (quote.given_back == null || quote.cash_out !== quote.given_back || quote.tenders.length > 1) ? <Line label="Cash handed back" value={money(quote.cash_out)} /> : null}
    </dl>
  );
}
