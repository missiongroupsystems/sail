"use client";

import { AmountPad, Badge, Button, formatBpsText, Money, Skeleton, TenderGrid, TextField, useLocale } from "@sail/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button as AriaButton } from "react-aria-components";
import { ApiError, idempotencyKey, toApiError } from "@/lib/api";
import type { CheckPayment, CheckSnapshot, OrderSnapshot, PaymentFigures, PaymentIntent, TenderType } from "../api/types";
import { Frame } from "../components/Frame";
import { usePos } from "../components/PosContext";
import { GREY_PILL, PANEL } from "../components/styles";
import { ReceiptChooser } from "../components/ReceiptChooser";
import { VoidPaymentSheet } from "../components/ReasonSheets";
import { ReopenedNote } from "../components/ReopenedNote";
import { useMerchant, useOrder, usePaymentIntents, useShifts, useTenderTypes } from "../hooks/queries";
import { likelyTendered, useCashDenominations } from "../lib/cash";
import { roleAtLeast, useOrderActions } from "../hooks/useOrderActions";
import { useNavStore } from "../state/nav";
import { useUiStore } from "../state/ui";
import { billLabel, billRows, lineOrder, shareText } from "./BillScreen";

/** A dry run's answer with the inputs it was asked for, so an answer for the last inputs is never shown against new ones. */
type Preview = { figures: PaymentFigures; left: number; key: string } | null;
const previewKey = (tenderId: string, amount: number, tendered: number | null, tipped: { tip_bps?: number; tip_cents?: number }) => JSON.stringify([tenderId, amount, tendered, tipped.tip_bps ?? null, tipped.tip_cents ?? null]);
type PadTarget = "amount" | "cash" | "tip";

/** The register names the largest tip it would take when it refuses one; the cap is never worked out here. */
const tipRefused = (e: unknown) => e instanceof ApiError && e.details != null && e.details.max_tip_cents !== undefined;

/** A key typed onto a figure: the first key after the keypad (re)opens on a prefilled figure replaces it. */
function typed(current: string, next: string, fresh: boolean): string {
  if (!fresh || next.length <= current.length || !next.startsWith(current)) return next;
  return next.slice(current.length).replace(/^0+(?=\d)/, "");
}

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
  const openShifts = useShifts(station.outlet_id, "open");
  const actions = useOrderActions(orderId);
  const snap = order.data;
  const check = snap?.checks.find((c) => c.id === checkId) ?? null;

  const [tenderId, setTenderId] = useState<string | null>(null);
  const [digits, setDigits] = useState<string | null>(null);
  /** What the keypad types into, and whether the next key replaces the figure shown (a prefilled amount) instead of adding to it. */
  const [pad, setPad] = useState<{ target: PadTarget; fresh: boolean }>({ target: "amount", fresh: true });
  const padTo = (target: PadTarget) => setPad({ target, fresh: true });
  /** The keypad's Tip key: a tip the register refuses (more than the bill) brings the person back to it. */
  const tipKeyRef = useRef<HTMLButtonElement>(null);
  const backToTip = useCallback(() => {
    setPad({ target: "tip", fresh: true });
    setTimeout(() => tipKeyRef.current?.focus(), 0);
  }, []);

  const [tendered, setTendered] = useState<number | null>(null);
  const [reference, setReference] = useState("");
  const [tip, setTip] = useState<Tip>({ kind: "none" });
  // The last add's Undo belongs to the order screen, not to the payment.
  useEffect(() => useUiStore.getState().clearUndo(), []);
  const [preview, setPreview] = useState<Preview>(null);
  const [otherMethod, setOtherMethod] = useState(false);
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
          setPreview({ figures: res.payment, left: after?.balance ?? 0, key: previewKey(t.id, amt, tnd, tipped) });
        } catch (e) {
          if (dropped) return;
          const err = toApiError(e);
          setPreview(null);
          setPreviewError(err.remedy ? `${err.message}. ${err.remedy}` : err.message);
          if (tipRefused(err)) backToTip();
        }
      }, 200);
      return () => {
        dropped = true;
        clearTimeout(timer);
      };
    },
    [actions, check, backToTip],
  );

  // The register previews cash rounding and change, the tip, and the balance left after a part payment, on every change.
  // A dry run still waiting when the inputs change, or when the payment is taken, is dropped with the effect.
  const tipKey = tipping ? JSON.stringify(tipFields(tip)) : "";
  // Cash needs a drawer: with no shift open here the register would refuse, so the dry run is not sent and the screen says
  // why (live test D-N4). Cash handed over that is short of the amount is not sent either; the register's cash rounding can
  // only move the amount by less than one rounding step.
  const shiftOpen = (openShifts.data ?? []).some((s) => s.station_id === station.id || s.station_id === null);
  const noShift = Boolean(tender?.is_cash) && openShifts.isSuccess && !shiftOpen;
  const step = merchant.data?.settings.cash_rounding_increment ?? 0;
  const shortCash = Boolean(tender?.is_cash) && tendered != null && tendered + step < amount;
  const localStop = noShift ? "No shift is open here to take cash into. Open a shift (with its float) first, or take the payment by card." : shortCash ? "The cash handed over is less than the amount. Enter the cash given, or lower the amount for a part payment." : null;
  // Only the answer for what is on screen now: a cash note tapped a moment ago must not show the last answer's
  // change (it read $0.00 for an instant, live-test A-10) while its own dry run is on the wire.
  const currentKey = tender ? previewKey(tender.id, amount, tender.is_cash ? tendered : null, tipKey ? (JSON.parse(tipKey) as { tip_bps?: number; tip_cents?: number }) : {}) : "";
  const fresh = preview && preview.key === currentKey ? preview : null;
  useEffect(() => {
    if (!tender || !check || done || busy) return;
    if (localStop) {
      setPreview(null);
      setPreviewError(null);
      return undefined;
    }
    const tipped = tipKey ? (JSON.parse(tipKey) as { tip_bps?: number; tip_cents?: number }) : {};
    if (tender.is_cash || (part && !tender.provider) || tipKey) return runPreview(tender, amount, tender.is_cash ? tendered : null, tipped);
    setPreview(null);
    setPreviewError(amount > balance ? "Amount above the balance. Enter the balance or a smaller part payment." : null);
    return undefined;
  }, [tender, check, amount, tendered, part, balance, done, busy, runPreview, tipKey, localStop]);

  const selectTender = (id: string) => {
    if (id === watched?.tender_type_id) setOtherMethod(false);
    // Tapping the method already chosen changes nothing; clearing its dry run here left "Checking with the register…" up for good.
    if (id === tender?.id) return;
    setTenderId(id);
    setTendered(null);
    setPreview(null);
    setTerminalNote(null);
    if (pad.target !== "amount") padTo("amount");
  };

  /** The tip the register worked out in its dry run; a payment with a tip waits for it, so what is recorded is what was shown. */
  const tipCents = tipping ? (fresh?.figures.tip_cents ?? null) : 0;

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
      const res = await actions.pay(check, { payment_id: id, tender_type_id: tender.id, amount, ...(tender.is_cash && tendered != null ? { tendered } : {}), ...(tipCents ? { tip_cents: tipCents } : {}), ...(reference.trim() ? { reference: reference.trim() } : {}) }, tender.name, { onRefused: (e) => (tipRefused(e) ? backToTip() : undefined), dueCents: fresh?.figures.due_cents ?? null });
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
      <Frame sub={{ back: { label: "Bill", onPress: back }, title: "Pay" }}>
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
    // A part payment leaves this bill open: the screen says so, and its way on is the rest of the same bill.
    const partPaid = done.check.status === "open" && done.check.balance > 0;
    return (
      // No back or title row: the result is the screen. Leaving is the done button (or the 4 s auto-return).
      <Frame>
        <VoidPaymentSheet label={voiding ? `${money(voiding.amount)} by ${voiding.tender}` : null} onTerminal={voiding ? mine.some((i) => i.payment_id === voiding.id) : false} isOpen={voiding !== null} onClose={() => setVoiding(null)} onVoid={voidPayment} />
        <ReceiptChooser
          // With change to hand over, the screen stays until it is tapped: the figure must not vanish mid-count (A-N5).
          autoReturnMs={voiding || partPaid || (tender.is_cash && change > 0) ? 0 : undefined}
          order={done.order}
          check={done.check}
          actions={actions}
          caption={`${partPaid ? "Part paid" : "Paid"} · ${done.check.label} · ${where}`}
          amount={paidAmount}
          extra={
            done.figures.id && !voidWaiting(done.figures.id) ? (
              <Button size="lg" variant="quiet" onPress={() => setVoiding(done.figures as CheckPayment)} className="text-ink-2!">
                Void payment
              </Button>
            ) : null
          }
          sub={{
            main: tender.is_cash && change > 0 ? `Change ${money(change)}` : null,
            minor: [done.figures.tip_cents ? `Tip ${money(done.figures.tip_cents)}` : null, !(tender.is_cash && change > 0) && done.figures.rounding_cents ? `Cash rounding ${money(done.figures.rounding_cents)}` : null, done.figures.tip_cents && done.figures.due_cents != null ? `Charged ${money(done.figures.due_cents)}` : null].filter(Boolean).join(" · ") || null,
          }}
          onDone={
            partPaid
              ? () => {
                  setDone(null);
                  setDigits(null);
                  setTendered(null);
                  setTip({ kind: "none" });
                  padTo("amount");
                }
              : leave
          }
          doneLabel={partPaid ? `Pay the rest of ${done.check.label}` : done.order.status === "completed" ? (screen.kind === "pay" && screen.from === "orders" ? "Back to orders" : "Back to floor") : done.order.checks.some((c) => c.status === "open") ? "Next bill" : "Back to the order"}
        />
      </Frame>
    );
  }

  // Every figure here is the register's dry run (rounding, change, balance left) or the person's own entry (amount, cash given). Nothing is added up on the iPad.
  const figures = fresh?.figures ?? null;
  const rounding = tender.is_cash && figures?.rounding_cents ? figures.rounding_cents : 0;
  const change = tender.is_cash && figures && tendered != null ? figures.change_due : null;
  const left = fresh?.left ?? null;
  // What the guest hands over: the amount, cash rounding and tip, as the register's dry run returned it.
  const due = figures?.due_cents ?? amount;
  const verb = tender.is_cash ? `Take ${money(tendered ?? due)} cash` : onTerminal ? `Send ${money(due)} to the terminal` : tender.is_terminal ? (part || tipping ? `Take ${money(due)} by ${tender.name}` : `Paid by ${tender.name}`) : `Take ${money(due)} by ${tender.name}`;
  // A tip still being checked has no confirmed total yet: the button never shows the amount without it (D notes, B WebKit).
  const label = tipping && !figures && !localStop ? "Checking the tip…" : `${verb}${part && left != null ? ` · ${money(left)} left` : ""}`;
  // Too little cash for the rounded amount comes back from the dry run as a validation error, which blocks the button with its remedy.
  // Cash and a tip wait for the dry run, so the button never shows a figure the register has not confirmed.
  const waitingForRegister = (tender.is_cash || tipping) && !figures;
  // The terminal cannot take an approval, so a Server cannot send a card payment to it; every other method asks for one.
  const terminalNeedsCashier = onTerminal && !canPay;
  const blocked = offline || busy || amount <= 0 || Boolean(previewError) || Boolean(localStop) || waitingForRegister || watched?.state === "pending" || terminalNeedsCashier;
  const tipText = tipping && figures ? money(figures.tip_cents ?? 0) : null;

  // The keypad: which figure it types into, what it shows, and what a key does to it.
  const padTarget: PadTarget = pad.target === "cash" && !tender.is_cash ? "amount" : pad.target === "tip" && !tipsOffered ? "amount" : pad.target;
  const padDigitsShown = padTarget === "amount" ? (digits ?? String(balance)) : padTarget === "cash" ? (tendered != null ? String(tendered) : String(due)) : tip.kind === "amount" ? tip.digits : tip.kind === "percent" && figures?.tip_cents != null ? String(figures.tip_cents) : "";
  const padFresh = pad.fresh;
  const onPad = (next: string) => {
    const d = typed(padDigitsShown, next, padFresh);
    // Cleared to nothing, the figure goes back to its prefilled value, and the next key replaces it again.
    setPad({ target: padTarget, fresh: d === "" });
    // Cash typed above the balance is the cash handed over (A-N1): the register records the balance and gives change, and
    // the screen says exactly that instead of "will record" a figure it will not.
    if (padTarget === "amount" && tender.is_cash && d !== "" && Number(d) > balance) {
      setDigits(null);
      setTendered(Number(d));
      setPad({ target: "cash", fresh: false });
    } else if (padTarget === "amount") setDigits(d);
    else if (padTarget === "cash") setTendered(d ? Number(d) : null);
    else {
      // A new tip is a new dry run: the old figures must not be paid while it runs.
      setTip({ kind: "amount", digits: d });
      setPreview(null);
    }
  };
  // The balance needs no caption (the figure stands alone); a part payment, cash and the tip say what is typed.
  const padHint = padTarget === "amount" ? (part ? "Part payment" : null) : padTarget === "cash" ? (tendered == null ? "Exact" : "Cash handed over") : tip.kind === "percent" ? `${formatBpsText(tip.bps)} tip${tipText ? ` · ${tipText}` : ""}` : tip.kind === "amount" && Number(tip.digits || "0") > 0 ? "The tip" : "No tip · type an amount or pick one";
  const pill = (on: boolean) => (on ? "" : GREY_PILL);

  return (
    <Frame sub={{ back: { label: screen.kind === "pay" && screen.returnTo === "bill" ? "Bills" : where, onPress: back }, title: "Take payment", meta: `${billLabel(check)} · ${where}` }}>
      {/* Portrait: the bill sits above the payment panel at a fixed height, so the methods, keypad and take button keep their width. */}
      <div className="flex min-h-0 flex-1 gap-4 px-4 pb-4 max-[960px]:flex-col">
        <section className={PANEL + " flex w-[340px] shrink-0 flex-col overflow-hidden max-[1100px]:w-[280px] max-[960px]:max-h-[380px] max-[960px]:w-auto"} aria-label="Bill">
          <h2 className="flex h-12 shrink-0 items-center border-b border-rule px-4 font-heading text-[17px] font-semibold text-ink">{billLabel(check)}</h2>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2 max-[960px]:min-h-[108px]">
            {[...check.allocations].sort((a, b) => lineOrder(snap, a.line_id) - lineOrder(snap, b.line_id)).map((a) => {
              const l = linesById.get(a.line_id);
              if (!l) return null;
              return (
                <div key={a.line_id} className="flex items-start gap-3 py-1.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] text-ink">
                      {l.quantity > 1 ? <span className="tabular">{l.quantity} × </span> : null}
                      {l.name}
                      {shareText(a.share) ? <span className="text-ink-2 tabular"> · {shareText(a.share)}</span> : null}
                    </span>
                    {l.modifiers.length ? <span className="block truncate text-[13px] text-ink-2">{l.modifiers.map((m) => m.name).join(", ")}</span> : null}
                  </span>
                  <Money cents={a.base} size="body" className="text-[15px] text-ink" />
                </div>
              );
            })}
          </div>
          <dl className="shrink-0 border-t border-rule px-4 pt-2 pb-3">
            <Row label="Subtotal" cents={check.totals.subtotal} />
            {billRows(check, snap.totals.tax_mode).map((r) => (
              <Row key={r.key} label={r.label} cents={r.cents} total={r.kind === "total"} />
            ))}
          </dl>
          {check.payments.some((p) => p.status === "recorded") ? (
            <ul className="shrink-0 border-t border-rule-subtle px-4 py-1" aria-label="Payments on this bill">
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
          <ReopenedNote checks={[check]} className="mx-4 mb-3 shrink-0" />
          <VoidPaymentSheet label={voiding ? `${money(voiding.amount)} by ${voiding.tender}` : null} onTerminal={voiding ? mine.some((i) => i.payment_id === voiding.id) : false} isOpen={voiding !== null} onClose={() => setVoiding(null)} onVoid={voidPayment} />
        </section>

        {onTerminal && watched?.state === "pending" && !otherMethod ? (
          // While the terminal has it, the whole payment panel is the wait: what it asks for and the one way out.
          <div className={PANEL + " flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center"} role="status" aria-live="polite">
            <p className="font-heading text-[24px] leading-tight font-medium text-ink">Waiting for the terminal.</p>
            <Money cents={watched.due_cents} size="amount-xl" className="font-heading text-[40px] font-semibold text-ink" />
            <p className="max-w-[46ch] text-body text-ink-2">Ask the guest to tap or insert their card. This screen moves on by itself when the terminal answers.</p>
            <div className="mt-2 flex flex-wrap justify-center gap-2">
              <Button size="lg" variant="quiet" className={GREY_PILL} onPress={() => void actions.cancelTerminal(watched.id)}>
                Cancel on terminal
              </Button>
              {/* The methods stay reachable: another one says why it waits for this payment. */}
              <Button size="lg" variant="quiet" onPress={() => setOtherMethod(true)} className="text-ink-2!">
                Use another method
              </Button>
            </div>
          </div>
        ) : (
        <div className={PANEL + " flex min-h-0 min-w-0 flex-1 gap-5 p-5 max-[1100px]:gap-4 max-[1100px]:p-4"}>
          <section className="flex min-w-0 flex-1 flex-col" aria-label="Payment">
            {/* Everything above the take button scrolls, so the button never falls below the fold however much is open. */}
            <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 pb-3">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-[14.5px] text-ink-2">Balance</p>
                  <Money cents={balance} size="amount-xl" className="font-heading text-ink" />
                </div>
                <div className="flex flex-col items-start gap-1">
                  <span className="text-[14.5px] text-ink-2">Paying now</span>
                  <AriaButton
                    onPress={() => padTo("amount")}
                    aria-label={`Amount ${money(amount)}, tap to edit`}
                    aria-pressed={padTarget === "amount"}
                    className={
                      "press pos-touch flex min-h-14 min-w-[200px] items-center justify-end rounded-tile bg-surface-2 px-4 font-heading text-[24px] font-medium tabular text-ink outline-none transition-colors duration-[120ms] data-[pressed]:scale-[0.98] data-[pressed]:bg-surface-3 data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus"
                    }
                  >
                    {money(amount)}
                  </AriaButton>
                  {digits !== null && amount !== balance ? (
                    <Button size="md" variant="quiet" onPress={() => {
                        setDigits(null);
                        padTo("amount");
                      }} className="-mr-3 text-ink-2!">
                      Full balance{part ? " · this is a part payment" : ""}
                    </Button>
                  ) : null}
                </div>
              </div>

              <TenderGrid tenders={list} selectedId={tender.id} onSelect={selectTender} isDisabled={busy} className="mt-4" />
              {watched?.state === "pending" && !onTerminal ? (
                <div className="mt-3 flex flex-wrap items-center gap-3 rounded-tile bg-surface-2 px-4 py-3" role="status">
                  <p className="min-w-0 flex-1 text-body text-ink">A terminal payment of {money(watched.due_cents)} is waiting for the guest. Another payment can be taken once it is paid or cancelled.</p>
                  <Button size="md" variant="secondary" onPress={() => selectTender(watched.tender_type_id)}>
                    Show the terminal payment
                  </Button>
                </div>
              ) : null}

              {tender.is_cash ? (
                <div className="mt-4 flex flex-col gap-3">
                  <div role="group" aria-label="Cash given">
                    <p className="mb-2 text-[14px] text-ink-2">Cash handed over</p>
                    <div className="flex flex-wrap gap-2">
                      <Button size="md" variant={tendered === null ? "primary" : "quiet"} onPress={() => {
                        setTendered(null);
                        if (padTarget === "cash") padTo("cash");
                      }} aria-pressed={tendered === null} className={"min-h-12! " + pill(tendered === null)}>
                        Exact
                      </Button>
                      {likelyTendered(due, denominations).map((n) => (
                        <Button key={n} size="md" variant={tendered === n ? "primary" : "quiet"} onPress={() => {
                            setTendered(n);
                            if (padTarget === "cash") padTo("cash");
                          }} aria-pressed={tendered === n} className={"min-h-12! tabular " + pill(tendered === n)}>
                          {money(n, { dropZeroFraction: true })}
                        </Button>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-tile bg-surface-2 px-4 py-3 text-[15px] tabular" role="status" aria-live="polite">
                    {localStop ? (
                      <span className="text-status-alert">{localStop}</span>
                    ) : figures ? (
                      <dl className="flex flex-col gap-0.5">
                        {tendered != null ? <SummaryRow label="Cash handed over" cents={tendered} /> : null}
                        <SummaryRow label={part ? "Part payment the register will record" : "The register will record"} cents={amount} />
                        {rounding !== 0 ? <SummaryRow label="Cash rounding" cents={rounding} /> : null}
                        {tipping ? <SummaryRow label="Tip" cents={figures.tip_cents ?? 0} /> : null}
                        {change != null && tendered != null ? <SummaryRow label="Change to give" cents={change} strong /> : null}
                      </dl>
                    ) : previewError ? (
                      <span className="text-status-alert">{previewError}</span>
                    ) : (
                      <span className="text-ink-2">Checking with the register…</span>
                    )}
                  </div>
                </div>
              ) : (
                <div className="mt-4 flex flex-col gap-3">
                  {/* One plain hint line: the balance is already shown twice above, so no third large figure. */}
                  {onTerminal ? (
                    <div className="flex flex-col gap-1 rounded-tile bg-surface-2 px-4 py-3">
                      <p className="text-[15px] text-ink">
                        The terminal will be asked for <span className="font-semibold tabular">{money(due)}</span>
                        {tipText ? `, including a ${tipText} tip` : ""}. The bill updates when the guest has paid.
                      </p>
                      {terminalNeedsCashier ? (
                        <p className="text-body text-status-bill" role="status">
                          Card terminal payments need a Cashier or above. Switch user, or take the card by hand with a Cashier&rsquo;s approval.
                        </p>
                      ) : null}
                      {terminalNote ? (
                        <p className={`text-body ${terminalNote.alert ? "text-status-alert" : "text-ink-2"}`} role={terminalNote.alert ? "alert" : "status"}>
                          {terminalNote.text}
                        </p>
                      ) : null}
                    </div>
                  ) : tender.is_terminal ? (
                    <p className="rounded-tile bg-surface-2 px-4 py-3 text-[15px] text-ink">
                      Take <span className="font-semibold tabular">{money(due)}</span> by {tender.name}
                      {tipText ? `, including a ${tipText} tip` : ""}, then tap {part || tipping ? "Take" : "Paid"}.
                    </p>
                  ) : (
                    <p className="rounded-tile bg-surface-2 px-4 py-3 text-[15px] text-ink">Record {money(amount)} to {tender.name}.</p>
                  )}
                  {tipping && !figures && !previewError ? (
                    <p className="text-body text-ink-2" role="status" aria-live="polite">
                      Checking the tip with the register…
                    </p>
                  ) : null}
                  {onTerminal ? null : <TextField label={tender.requires_reference ? "Reference" : "Reference (optional)"} isRequired={tender.requires_reference} value={reference} onChange={setReference} inputClassName="min-h-14 text-line" maxLength={80} />}
                  {previewError ? (
                    <p className="text-body text-status-alert" role="alert">
                      {previewError}
                    </p>
                  ) : null}
                </div>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-2 pt-1">
              {/* A tender marked as needing approval asks a Manager (the register's paymentRole), whoever is signed in below that. */}
              {tender.requires_approval && !roleAtLeast(staff.role, "manager") ? <Badge tone="bill">Manager approval</Badge> : !canPay ? <Badge tone="bill">Cashier approval</Badge> : null}
              <Button size="lg" variant="primary" isDisabled={blocked} isPending={busy} onPress={onTerminal ? sendToTerminal : pay} className="min-h-14 flex-1 px-6 text-[17px]">
                {offline ? "Offline" : label}
              </Button>
            </div>
          </section>

          <aside className="flex w-[300px] shrink-0 flex-col gap-3 max-[1100px]:w-[256px]" aria-label="Keypad">
            {/* The row is there on every method (Amount alone where there is nothing else to type), so the keypad does not jump. */}
              <div className="flex min-h-[52px] items-center gap-0.5 rounded-chip bg-surface-2 p-1" role="group" aria-label="Keypad types">
                {(
                  [
                    { id: "amount", label: "Amount", show: true },
                    { id: "cash", label: "Cash given", show: tender.is_cash },
                    { id: "tip", label: "Tip", show: tipsOffered },
                  ] as const
                )
                  .filter((o) => o.show)
                  .map((o) => (
                    <AriaButton
                      key={o.id}
                      ref={o.id === "tip" ? tipKeyRef : undefined}
                      aria-pressed={padTarget === o.id}
                      aria-label={`Type the ${o.label.toLowerCase()}`}
                      // Looking at the tip keypad keeps a chosen percentage; typing a figure replaces it.
                      onPress={() => padTo(o.id)}
                      className={
                        "press pos-touch flex min-h-11 flex-1 items-center justify-center rounded-chip px-2 text-[14.5px] font-medium whitespace-nowrap outline-none transition-colors duration-[120ms] data-[pressed]:scale-[0.97] data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus " +
                        (padTarget === o.id ? "bg-surface text-ink shadow-segment" : "text-ink-2 data-[hovered]:text-ink")
                      }
                    >
                      {o.label}
                    </AriaButton>
                  ))}
              </div>
            {padTarget === "tip" ? (
              // The one tip control: the keypad's Tip mode, with the register's percentages above the keys (typing is any other amount).
              <div role="group" aria-label="Tip" className="grid grid-cols-4 gap-1.5">
                <Button size="md" variant={tip.kind === "none" ? "primary" : "quiet"} aria-pressed={tip.kind === "none"} isDisabled={busy} className={"min-h-11! px-1! whitespace-nowrap " + pill(tip.kind === "none")} onPress={() => {
                    setTip({ kind: "none" });
                    setPreview(null);
                    setPad({ target: "tip", fresh: true });
                  }}>
                  No tip
                </Button>
                {TIP_PERCENTAGES.map((bps) => {
                  const on = tip.kind === "percent" && tip.bps === bps;
                  return (
                    <Button key={bps} size="md" variant={on ? "primary" : "quiet"} aria-pressed={on} aria-label={`Tip ${formatBpsText(bps)}`} isDisabled={busy} onPress={() => {
                        setTip({ kind: "percent", bps });
                        setPreview(null);
                        setPad({ target: "tip", fresh: true });
                      }} className={"min-h-11! px-1! tabular " + pill(on)}>
                      {formatBpsText(bps)}
                    </Button>
                  );
                })}
              </div>
            ) : null}
            <AmountPad digits={padDigitsShown} onChange={onPad} mode="cents" display="field" hint={padHint ?? undefined} muted={padFresh} isDisabled={busy} />
          </aside>
        </div>
        )}
      </div>
    </Frame>
  );
}

function Row({ label, cents, total }: { label: string; cents: number; total?: boolean }) {
  return (
    <div className={total ? "mt-1.5 flex items-center justify-between gap-3 pt-2 hairline-t" : "flex min-h-6 items-center justify-between gap-3"}>
      <dt className={total ? "text-[15px] font-semibold text-ink" : "text-[13px] text-ink-2"}>{label}</dt>
      <dd>
        <Money cents={cents} size="body" className={total ? "text-[15px] font-semibold text-ink" : "text-[13px] text-ink"} />
      </dd>
    </div>
  );
}

/** A line of the cash summary: what the register will record, rounding, tip, and the change in bold. */
function SummaryRow({ label, cents, strong }: { label: string; cents: number; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[14.5px] text-ink-2">{label}</dt>
      <dd>
        <Money cents={cents} size="body" className={strong ? "text-[17px] font-semibold text-ink" : "text-[14.5px] text-ink"} />
      </dd>
    </div>
  );
}

