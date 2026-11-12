"use client";

import { AmountPad, BackButton, Badge, Button, formatBpsText, Money, Skeleton, TenderGrid, TextField, useLocale } from "@sail/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button as AriaButton } from "react-aria-components";
import { ApiError, idempotencyKey, toApiError } from "@/lib/api";
import type { CheckPayment, CheckSnapshot, OrderSnapshot, PaymentFigures, PaymentIntent, TenderType } from "../api/types";
import { Frame } from "../components/Frame";
import { usePos } from "../components/PosContext";
import { ReceiptChooser } from "../components/ReceiptChooser";
import { VoidPaymentSheet } from "../components/ReasonSheets";
import { useMerchant, useOrder, usePaymentIntents, useTenderTypes } from "../hooks/queries";
import { likelyTendered, useCashDenominations } from "../lib/cash";
import { roleAtLeast, useOrderActions } from "../hooks/useOrderActions";
import { useNavStore } from "../state/nav";
import { useUiStore } from "../state/ui";
import { billLabel, billRows, shareText } from "./BillScreen";

type Preview = { figures: PaymentFigures; left: number } | null;

/** No tip, a percentage the register works out (basis points), or an amount typed on the keypad (minor units). */
type Tip = { kind: "none" } | { kind: "percent"; bps: number } | { kind: "amount"; digits: string };
const TIP_PERCENTAGES = [1500, 1800, 2000];
/** What the register's dry run and payment are told about the tip. */
const tipFields = (tip: Tip): { tip_bps?: number; tip_cents?: number } => (tip.kind === "percent" ? { tip_bps: tip.bps } : tip.kind === "amount" ? { tip_cents: Number(tip.digits || "0") } : {});

/**
 * Payment: the bill on the left, methods, the amount prefilled
 * with the balance, cash with a dry run for rounding and change, card with the
 * amount at 34pt and the terminal instruction, then the done screen. A payment method linked to a terminal sends
 * the amount there and waits for the terminal's answer on the event stream; a recorded payment can be voided. Where the
 * merchant offers tips, a tip is picked as a percentage or typed; the register's dry run turns it into the tip and the
 * total the guest hands over, and the payment records that figure.
 */
export function PayScreen({ orderId, checkId }: { orderId: string; checkId: string }) {
  const { money } = useLocale();
  const { station, tablesById, offline, staff } = usePos();
  const screen = useNavStore((s) => s.screen);
  const back = useNavStore((s) => s.back);
  const go = useNavStore((s) => s.go);
  const openBill = useNavStore((s) => s.openBill);
  const order = useOrder(orderId);
  const tenders = useTenderTypes(station.outlet_id);
  const intents = usePaymentIntents(orderId);
  const denominations = useCashDenominations();
  const merchant = useMerchant();
  const actions = useOrderActions(orderId);
  const snap = order.data;
  const check = snap?.checks.find((c) => c.id === checkId) ?? null;

  const [tenderId, setTenderId] = useState<string | null>(null);
  const [digits, setDigits] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [tipPad, setTipPad] = useState(false);
  const [tendered, setTendered] = useState<number | null>(null);
  const [reference, setReference] = useState("");
  const [tip, setTip] = useState<Tip>({ kind: "none" });
  // The last add's Undo belongs to the order screen, not to the payment.
  useEffect(() => useUiStore.getState().clearUndo(), []);
  const [preview, setPreview] = useState<Preview>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ check: CheckSnapshot; order: OrderSnapshot; figures: PaymentFigures } | null>(null);
  const paymentId = useRef(idempotencyKey());
  /** The terminal payment being waited for; its state comes from the register, refreshed by the event stream. */
  const [waitingId, setWaitingId] = useState<string | null>(null);
  const [terminalNote, setTerminalNote] = useState<{ text: string; alert: boolean } | null>(null);
  const [voiding, setVoiding] = useState<CheckPayment | null>(null);
  /** The dry run on the wire, if any. A payment waits for it: answered after the payment, a dry run is refused 409. */
  const previewInFlight = useRef<Promise<unknown> | null>(null);
  /** Set the moment Pay is pressed, before React re-renders: a dry-run timer that fires in between sends nothing. */
  const paying = useRef(false);

  const list: TenderType[] = useMemo(() => tenders.data ?? [], [tenders.data]);
  const tender = list.find((t) => t.id === tenderId) ?? list[0] ?? null;
  const balance = check?.balance ?? 0;
  const amount = digits === null ? balance : Number(digits || "0");
  const part = amount > 0 && amount < balance;
  const canPay = roleAtLeast(staff.role, "cashier");
  const onTerminal = Boolean(tender?.provider);
  // Tips go on cash and card payments, never on a house account or a voucher.
  const tipsOffered = Boolean(merchant.data?.settings.tips_enabled) && Boolean(tender && (tender.is_cash || tender.is_terminal || tender.provider));
  const tipping = tipsOffered && (tip.kind === "percent" || (tip.kind === "amount" && Number(tip.digits || "0") > 0));
  const mine = useMemo(() => (intents.data ?? []).filter((i) => i.check_id === checkId), [intents.data, checkId]);
  // Resumed after a reload or from another screen: a payment still on the terminal for this bill is waited for here.
  const pending = mine.find((i) => i.state === "pending") ?? null;
  const pendingId = pending?.id ?? null;
  const watching = waitingId ?? pendingId;
  const watched: PaymentIntent | null = mine.find((i) => i.id === watching) ?? null;
  const voidWaiting = (paymentRowId: string) => mine.some((i) => i.payment_id === paymentRowId && i.void_requested_at && !i.provider_voided_at);

  // A bill that disappeared (unsplit elsewhere) or an order that closed leaves the screen.
  useEffect(() => {
    if (snap && !done && (!check || snap.status === "cancelled")) back();
  }, [snap, check, done, back]);
  useEffect(() => {
    if (!tenderId && list[0]) setTenderId(list[0].id);
  }, [list, tenderId]);
  // Adopt that payment: its method is shown with "Waiting for the terminal", and its outcome (an expiry included) is
  // still reported here once it is no longer pending.
  const pendingTenderId = pending?.tender_type_id ?? null;
  useEffect(() => {
    if (!pendingId || waitingId) return;
    setWaitingId(pendingId);
    if (pendingTenderId) setTenderId(pendingTenderId);
  }, [pendingId, pendingTenderId, waitingId]);
  // Inputs changed: this is a new attempt, so a new idempotency key.
  useEffect(() => {
    paymentId.current = idempotencyKey();
  }, [tenderId, amount, tendered, reference, tip]);

  // The terminal answered: approved shows the paid screen once the bill shows the payment; anything else says why.
  const refetchOrder = order.refetch;
  useEffect(() => {
    if (!watched || watched.state === "pending") return;
    if (watched.state === "approved") {
      const after = snap?.checks.find((c) => c.id === checkId);
      const payment = after?.payments.find((p) => p.id === watched.payment_id);
      if (!snap || !after || !payment) {
        void refetchOrder();
        return;
      }
      setDone({ check: after, order: snap, figures: { ...payment, change_due: 0 } });
    } else {
      const text = watched.state === "declined" ? "Declined on the terminal. Try again or take another payment method." : watched.outcome_reason === "bill_changed" ? "The bill changed while the terminal was waiting, so the payment was given back. Send it again." : watched.state === "expired" ? "The terminal did not answer in time. Send it again or take another payment method." : "Cancelled. Nothing was charged.";
      // A cancel staff asked for is news, not a problem: a decline, an expiry or a changed bill is an alert.
      setTerminalNote({ text, alert: watched.outcome_reason !== "cancelled" });
    }
    setWaitingId(null);
    paymentId.current = idempotencyKey();
  }, [watched, snap, checkId, refetchOrder]);

  const runPreview = useCallback(
    (t: TenderType, amt: number, tnd: number | null, tipped: { tip_bps?: number; tip_cents?: number }): (() => void) | undefined => {
      if (!check || amt <= 0) {
        setPreview(null);
        return undefined;
      }
      // A dry run already sent when the inputs change, or when the payment is taken, still answers; its answer is ignored.
      let dropped = false;
      const timer = setTimeout(async () => {
        if (paying.current) return;
        try {
          setPreviewError(null);
          const request = actions.previewPayment(check.id, { tender_type_id: t.id, amount: amt, ...(tnd != null ? { tendered: tnd } : {}), ...tipped });
          previewInFlight.current = request;
          const res = await request.finally(() => {
            if (previewInFlight.current === request) previewInFlight.current = null;
          });
          if (!res || dropped) return;
          const after = res.data.checks.find((c) => c.id === check.id);
          setPreview({ figures: res.payment, left: after?.balance ?? 0 });
        } catch (e) {
          if (dropped) return;
          const err = toApiError(e);
          setPreview(null);
          setPreviewError(err.remedy ? `${err.message}. ${err.remedy}` : err.message);
        }
      }, 200);
      return () => {
        dropped = true;
        clearTimeout(timer);
      };
    },
    [actions, check],
  );

  // The register previews cash rounding and change, the tip, and the balance left after a part payment, on every change.
  // A dry run still waiting when the inputs change, or when the payment is taken, is dropped with the effect.
  const tipKey = tipping ? JSON.stringify(tipFields(tip)) : "";
  useEffect(() => {
    if (!tender || !check || done || busy) return;
    const tipped = tipKey ? (JSON.parse(tipKey) as { tip_bps?: number; tip_cents?: number }) : {};
    if (tender.is_cash || (part && !tender.provider) || tipKey) return runPreview(tender, amount, tender.is_cash ? tendered : null, tipped);
    setPreview(null);
    setPreviewError(amount > balance ? "Amount above the balance. Enter the balance or a smaller part payment." : null);
    return undefined;
  }, [tender, check, amount, tendered, part, balance, done, busy, runPreview, tipKey]);

  const selectTender = (id: string) => {
    // Tapping the method already chosen changes nothing; clearing its dry run here left "Checking with the register…" up for good.
    if (id === tender?.id) return;
    setTenderId(id);
    setTendered(null);
    setPreview(null);
    setTerminalNote(null);
  };

  /** The tip the register worked out in its dry run; a payment with a tip waits for it, so what is recorded is what was shown. */
  const tipCents = tipping ? (preview?.figures.tip_cents ?? null) : 0;

  const sendToTerminal = async () => {
    if (!check || !tender || amount <= 0 || busy) return;
    setBusy(true);
    setTerminalNote(null);
    try {
      if (tipCents === null) return;
      const intent = await actions.startTerminal(check, { intent_id: paymentId.current, tender_type_id: tender.id, amount, ...(tipCents ? { tip_cents: tipCents } : {}) });
      if (intent) setWaitingId(intent.id);
    } finally {
      setBusy(false);
    }
  };

  const voidPayment = async (reason: string) => {
    if (!voiding) return false;
    const res = await actions.voidPayment(voiding, reason);
    if (!res) return false;
    // A by-hand payment is reversed now and the bill is open again; a terminal one waits for the provider.
    if (res.void.status === "voided") setDone(null);
    setVoiding(null);
    return true;
  };

  const pay = async () => {
    if (!check || !tender || amount <= 0 || busy) return;
    setBusy(true);
    paying.current = true;
    const id = paymentId.current;
    try {
      await previewInFlight.current?.catch(() => undefined);
      if (tipCents === null) return;
      const res = await actions.pay(check, { payment_id: id, tender_type_id: tender.id, amount, ...(tender.is_cash && tendered != null ? { tendered } : {}), ...(tipCents ? { tip_cents: tipCents } : {}), ...(reference.trim() ? { reference: reference.trim() } : {}) }, tender.name);
      if (res) {
        const after = res.data.checks.find((c) => c.id === check.id) ?? check;
        setDone({ check: after, order: res.data, figures: res.payment });
      }
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
    } finally {
      paying.current = false;
      setBusy(false);
    }
  };

  const leave = useCallback(() => {
    const from = screen.kind === "pay" ? screen.from : "floor";
    const current = order.data;
    if (!current || current.status === "completed" || current.status === "cancelled") go({ kind: from });
    else if (current.checks.some((c) => c.status === "open")) openBill(orderId);
    else go({ kind: "order", orderId, from });
  }, [go, openBill, order.data, orderId, screen]);

  if (!snap || !check || !tender) {
    return (
      <Frame left={<BackButton label="Bill" onPress={back} />} title="Pay">
        <div className="flex flex-1 gap-4 p-4">
          <Skeleton className="h-full w-[420px]" />
          <Skeleton className="h-full flex-1" />
        </div>
      </Frame>
    );
  }

  const table = snap.table_id ? tablesById.get(snap.table_id) : null;
  const where = snap.order_type === "dine_in" ? `Table ${table?.name ?? ""}` : snap.order_no;
  const linesById = new Map(snap.lines.map((l) => [l.id, l]));

  if (done) {
    const paidAmount = done.figures.amount ?? amount;
    const change = done.figures.change_due;
    return (
      <Frame
        left={<BackButton label={screen.kind === "pay" && screen.returnTo === "bill" ? "Bill" : where} onPress={leave} />}
        title={`${done.check.label} · ${where}`}
        right={
          done.figures.id && !voidWaiting(done.figures.id) ? (
            <Button size="md" variant="quiet" onPress={() => setVoiding(done.figures as CheckPayment)}>
              Void payment
            </Button>
          ) : null
        }
      >
        <VoidPaymentSheet label={voiding ? `${money(voiding.amount)} by ${voiding.tender}` : null} onTerminal={voiding ? mine.some((i) => i.payment_id === voiding.id) : false} isOpen={voiding !== null} onClose={() => setVoiding(null)} onVoid={voidPayment} />
        <ReceiptChooser
          autoReturnMs={voiding ? 0 : undefined}
          order={done.order}
          check={done.check}
          actions={actions}
          heading={`Paid · ${done.check.label} · ${money(paidAmount)}`}
          sub={[done.figures.tip_cents ? `Tip ${money(done.figures.tip_cents)}` : null, tender.is_cash && change > 0 ? `Change ${money(change)}` : done.figures.rounding_cents ? `Cash rounding ${money(done.figures.rounding_cents)}` : null].filter(Boolean).join(" · ") || null}
          onDone={leave}
          doneLabel={done.order.status === "completed" ? (screen.kind === "pay" && screen.from === "orders" ? "Back to orders" : "Back to floor") : done.order.checks.some((c) => c.status === "open") ? "Next bill" : "Back to the order"}
        />
      </Frame>
    );
  }

  // Every figure here is the register's dry run (rounding, change, balance left) or the person's own entry (amount, cash given). Nothing is added up on the iPad.
  const figures = preview?.figures ?? null;
  const rounding = tender.is_cash && figures?.rounding_cents ? figures.rounding_cents : 0;
  const change = tender.is_cash && figures && tendered != null ? figures.change_due : null;
  const left = preview?.left ?? null;
  // What the guest hands over: the amount, cash rounding and tip, as the register's dry run returned it.
  const due = figures?.due_cents ?? amount;
  const verb = tender.is_cash ? `Take ${money(tendered ?? due)} cash` : onTerminal ? `Send ${money(due)} to the terminal` : tender.is_terminal ? (part || tipping ? `Take ${money(due)} by ${tender.name}` : `Paid by ${tender.name}`) : `Take ${money(due)} by ${tender.name}`;
  const label = `${verb}${part && left != null ? ` · ${money(left)} left` : ""} ▸`;
  // Too little cash for the rounded amount comes back from the dry run as a validation error, which blocks the button with its remedy.
  // Cash and a tip wait for the dry run, so the button never shows a figure the register has not confirmed.
  const waitingForRegister = (tender.is_cash || tipping) && !figures;
  const blocked = offline || busy || amount <= 0 || Boolean(previewError) || waitingForRegister || watched?.state === "pending";
  const tipText = tipping && figures ? money(figures.tip_cents ?? 0) : null;

  return (
    <Frame left={<BackButton label={screen.kind === "pay" && screen.returnTo === "bill" ? "Bill" : where} onPress={back} />} title={`${billLabel(check)} · ${where}`}>
      <div className="flex min-h-0 flex-1">
        <section className="flex w-[420px] shrink-0 flex-col hairline-r bg-surface" aria-label="Bill">
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {check.allocations.map((a) => {
              const l = linesById.get(a.line_id);
              if (!l) return null;
              return (
                <div key={a.line_id} className="flex items-start gap-2 py-1.5">
                  <span className="w-6 shrink-0 text-line tabular text-ink">{l.quantity}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-line text-ink">
                      <span className="truncate">{l.name}</span>
                      {shareText(a.share) ? <span className="rounded-chip bg-surface-2 px-1.5 text-caption text-ink-2 tabular">{shareText(a.share)}</span> : null}
                    </span>
                    {l.modifiers.length ? <span className="block truncate pl-3 text-body text-ink-2">· {l.modifiers.map((m) => m.name).join(", ")}</span> : null}
                  </span>
                  <Money cents={a.base} size="line" className="text-ink" />
                </div>
              );
            })}
          </div>
          <dl className="px-4 pt-2 pb-4 hairline-t">
            <Row label="Subtotal" cents={check.totals.subtotal} />
            {billRows(check, snap.totals.tax_mode).map((r) => (
              <Row key={r.key} label={r.label} cents={r.cents} total={r.kind === "total"} />
            ))}
            {check.paid_total === 0 ? <Row label="Paid" cents={0} /> : null}
          </dl>
          {check.payments.some((p) => p.status === "recorded") ? (
            <ul className="px-4 pb-4" aria-label="Payments on this bill">
              {check.payments
                .filter((p) => p.status === "recorded")
                .map((p) => (
                  <li key={p.id} className="flex min-h-11 items-center gap-3">
                    <span className="min-w-0 flex-1 truncate text-body text-ink">
                      {p.tender}
                      {p.tip_cents ? <span className="text-caption text-ink-2"> · tip {money(p.tip_cents)}</span> : null}
                    </span>
                    <Money cents={p.amount} size="body" className="text-ink" />
                    {voidWaiting(p.id) ? (
                      <Badge tone="bill">Voiding on terminal</Badge>
                    ) : check.refunded_total === 0 ? (
                      <Button size="md" variant="quiet" onPress={() => setVoiding(p)} isDisabled={offline} aria-label={`Void ${money(p.amount)} by ${p.tender}`}>
                        Void
                      </Button>
                    ) : null}
                  </li>
                ))}
            </ul>
          ) : null}
          <VoidPaymentSheet label={voiding ? `${money(voiding.amount)} by ${voiding.tender}` : null} onTerminal={voiding ? mine.some((i) => i.payment_id === voiding.id) : false} isOpen={voiding !== null} onClose={() => setVoiding(null)} onVoid={voidPayment} />
        </section>

        <section className="flex min-w-0 flex-1 flex-col px-6 py-4" aria-label="Payment">
          <div className="flex items-baseline gap-4">
            <span className="text-line text-ink-2">Balance</span>
            <Money cents={balance} size="amount-xl" className="text-ink" />
          </div>

          <TenderGrid tenders={list} selectedId={tender.id} onSelect={selectTender} isDisabled={busy} className="mt-4" />
          {watched?.state === "pending" && !onTerminal ? (
            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-tile bg-surface px-4 py-3 hairline" role="status">
              <p className="min-w-0 flex-1 text-body text-ink">A terminal payment of {money(watched.amount)} is waiting for the guest. Another payment can be taken once it is paid or cancelled.</p>
              <Button size="md" variant="secondary" onPress={() => selectTender(watched.tender_type_id)}>
                Show the terminal payment
              </Button>
            </div>
          ) : null}

          <div className="mt-5 flex items-center gap-4">
            <span className="text-line text-ink-2">Amount</span>
            <AriaButton
              onPress={() => {
                setEditing((e) => !e);
                setTipPad(false);
                if (digits === null) setDigits(String(balance));
              }}
              aria-label={`Amount ${money(amount)}, tap to edit`}
              aria-pressed={editing}
              className="press pos-touch min-h-14 rounded-tile bg-surface-2 px-5 text-title tabular text-ink outline-none data-[pressed]:scale-[0.98] data-[focus-visible]:outline-2 data-[focus-visible]:outline-status-seated"
            >
              {money(amount)}
            </AriaButton>
            {digits !== null && amount !== balance ? (
              <Button size="md" variant="quiet" onPress={() => setDigits(null)}>
                Full balance
              </Button>
            ) : null}
            {part ? <span className="text-body text-ink-2">Part payment</span> : null}
          </div>
          {editing ? (
            <div className="mt-3 self-start rounded-tile bg-surface px-4 py-3 hairline">
              <AmountPad digits={digits ?? String(balance)} onChange={(d) => setDigits(d)} mode="cents" hint="Tap the amount again to close" />
            </div>
          ) : null}

          {tipsOffered ? (
            <div className="mt-4 flex flex-wrap items-center gap-2" role="group" aria-label="Tip">
              <span className="mr-2 text-caption text-ink-2 uppercase tracking-[0.04em]">Tip</span>
              <Button size="lg" variant={tip.kind === "none" ? "primary" : "secondary"} aria-pressed={tip.kind === "none"} isDisabled={busy} onPress={() => {
                  setTip({ kind: "none" });
                  setTipPad(false);
                }}>
                No tip
              </Button>
              {TIP_PERCENTAGES.map((bps) => (
                <Button key={bps} size="lg" variant={tip.kind === "percent" && tip.bps === bps ? "primary" : "secondary"} aria-pressed={tip.kind === "percent" && tip.bps === bps} aria-label={`Tip ${formatBpsText(bps)}`} isDisabled={busy} onPress={() => {
                    setTip({ kind: "percent", bps });
                    setTipPad(false);
                  }} className="tabular">
                  {formatBpsText(bps)}
                </Button>
              ))}
              <Button
                size="lg"
                variant={tip.kind === "amount" ? "primary" : "secondary"}
                aria-pressed={tip.kind === "amount"}
                aria-expanded={tipPad}
                isDisabled={busy}
                onPress={() => {
                  setTip(tip.kind === "amount" ? tip : { kind: "amount", digits: "" });
                  setTipPad((o) => !o);
                  setEditing(false);
                }}
                className="tabular"
              >
                {tip.kind === "amount" && Number(tip.digits || "0") > 0 ? money(Number(tip.digits)) : "Other amount"}
              </Button>
            </div>
          ) : null}
          {tipsOffered && tipPad && tip.kind === "amount" ? (
            <div className="mt-3 self-start rounded-tile bg-surface px-4 py-3 hairline">
              <AmountPad digits={tip.digits} onChange={(d) => setTip({ kind: "amount", digits: d })} mode="cents" hint="The tip. Tap the tip button again to close" />
            </div>
          ) : null}

          {tender.is_cash ? (
            <div className="mt-5 flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Cash given">
                <span className="mr-2 text-caption text-ink-2 uppercase tracking-[0.04em]">Cash</span>
                <Button size="lg" variant={tendered === null ? "primary" : "secondary"} onPress={() => setTendered(null)} aria-pressed={tendered === null}>
                  Exact
                </Button>
                {likelyTendered(due, denominations).map((n) => (
                  <Button key={n} size="lg" variant={tendered === n ? "primary" : "secondary"} onPress={() => setTendered(n)} aria-pressed={tendered === n} className="tabular">
                    {money(n, { dropZeroFraction: true })}
                  </Button>
                ))}
              </div>
              <p className="text-body text-ink-2 tabular" role="status" aria-live="polite">
                {figures ? (
                  <>
                    {rounding !== 0 ? `Cash rounding ${money(rounding)}` : part ? `Part payment of ${money(amount)}` : "No cash rounding"}
                    {tipText ? ` · tip ${tipText}` : ""}
                    {change != null && tendered != null ? ` · change ${money(change)}` : ""}
                  </>
                ) : previewError ? (
                  <span className="text-status-alert">{previewError}</span>
                ) : (
                  "Checking with the register…"
                )}
              </p>
            </div>
          ) : (
            <div className="mt-5 flex flex-col gap-3">
              {onTerminal && watched?.state === "pending" ? (
                <div role="status" aria-live="polite" className="flex flex-col gap-3">
                  <Money cents={watched.amount} size="amount-xl" className="text-ink" />
                  <p className="text-line text-ink">Waiting for the terminal. Ask the guest to tap or insert their card.</p>
                  <Button size="lg" variant="secondary" className="self-start" onPress={() => void actions.cancelTerminal(watched.id)}>
                    Cancel on terminal
                  </Button>
                </div>
              ) : onTerminal ? (
                <>
                  <Money cents={due} size="amount-xl" className="text-ink" />
                  <p className="text-line text-ink">
                    The terminal asks the guest for {money(due)}
                    {tipText ? `, including a ${tipText} tip` : ""}. The bill updates when they have paid.
                  </p>
                  {terminalNote ? (
                    <p className={`text-body ${terminalNote.alert ? "text-status-alert" : "text-ink-2"}`} role={terminalNote.alert ? "alert" : "status"}>
                      {terminalNote.text}
                    </p>
                  ) : null}
                </>
              ) : tender.is_terminal ? (
                <>
                  <Money cents={due} size="amount-xl" className="text-ink" />
                  <p className="text-line text-ink">
                    Take {money(due)} by {tender.name}
                    {tipText ? `, including a ${tipText} tip` : ""}, then tap {part || tipping ? "Take" : "Paid"}.
                  </p>
                </>
              ) : (
                <p className="text-line text-ink">Record {money(amount)} to {tender.name}.</p>
              )}
              {tipping && !figures && !previewError ? (
                <p className="text-body text-ink-2" role="status" aria-live="polite">
                  Checking the tip with the register…
                </p>
              ) : null}
              {onTerminal ? null : <TextField label={tender.requires_reference ? "Reference" : "Reference (optional)"} isRequired={tender.requires_reference} value={reference} onChange={setReference} inputClassName="min-h-14 text-line" className="max-w-[360px]" maxLength={80} mono />}
              {previewError ? (
                <p className="text-body text-status-alert" role="alert">
                  {previewError}
                </p>
              ) : null}
            </div>
          )}

          <div className="flex-1" />
          <div className="flex items-center justify-end gap-2">
            {!canPay ? <Badge tone="bill">Manager approval</Badge> : null}
            <Button size="lg" variant="primary" isDisabled={blocked} isPending={busy} onPress={onTerminal ? sendToTerminal : pay} className="min-h-16 min-w-[280px] px-6 text-heading">
              {offline ? "Offline" : label}
            </Button>
          </div>
        </section>
      </div>
    </Frame>
  );
}

function Row({ label, cents, total }: { label: string; cents: number; total?: boolean }) {
  return (
    <div className={total ? "mt-1 flex items-center justify-between gap-3 pt-2 hairline-t" : "flex min-h-7 items-center justify-between gap-3"}>
      <dt className={total ? "text-title text-ink" : "text-body text-ink-2"}>{label}</dt>
      <dd>
        <Money cents={cents} size={total ? "title" : "body"} className="text-ink" />
      </dd>
    </div>
  );
}
