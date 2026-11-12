"use client";

import { AmountPad, BackButton, Badge, Button, Money, Skeleton, TenderGrid, TextField, useLocale } from "@sail/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button as AriaButton } from "react-aria-components";
import { ApiError, idempotencyKey, toApiError } from "@/lib/api";
import type { CheckSnapshot, OrderSnapshot, PaymentFigures, TenderType } from "../api/types";
import { Frame } from "../components/Frame";
import { usePos } from "../components/PosContext";
import { ReceiptChooser } from "../components/ReceiptChooser";
import { useOrder, useTenderTypes } from "../hooks/queries";
import { likelyTendered, useCashDenominations } from "../lib/cash";
import { roleAtLeast, useOrderActions } from "../hooks/useOrderActions";
import { useNavStore } from "../state/nav";
import { billLabel, billRows, shareText } from "./BillScreen";

type Preview = { figures: PaymentFigures; left: number } | null;

/**
 * Payment (design 4.5): the bill on the left, methods, the amount prefilled
 * with the balance, cash with a dry run for rounding and change, card with the
 * amount at 34pt and the terminal instruction, then the done screen.
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
  const denominations = useCashDenominations();
  const actions = useOrderActions(orderId);
  const snap = order.data;
  const check = snap?.checks.find((c) => c.id === checkId) ?? null;

  const [tenderId, setTenderId] = useState<string | null>(null);
  const [digits, setDigits] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [tendered, setTendered] = useState<number | null>(null);
  const [reference, setReference] = useState("");
  const [preview, setPreview] = useState<Preview>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ check: CheckSnapshot; order: OrderSnapshot; figures: PaymentFigures } | null>(null);
  const paymentId = useRef(idempotencyKey());
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

  // A bill that disappeared (unsplit elsewhere) or an order that closed leaves the screen.
  useEffect(() => {
    if (snap && !done && (!check || snap.status === "cancelled")) back();
  }, [snap, check, done, back]);
  useEffect(() => {
    if (!tenderId && list[0]) setTenderId(list[0].id);
  }, [list, tenderId]);
  // Inputs changed: this is a new attempt, so a new idempotency key.
  useEffect(() => {
    paymentId.current = idempotencyKey();
  }, [tenderId, amount, tendered, reference]);

  const runPreview = useCallback(
    (t: TenderType, amt: number, tnd: number | null): (() => void) | undefined => {
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
          const request = actions.previewPayment(check.id, { tender_type_id: t.id, amount: amt, ...(tnd != null ? { tendered: tnd } : {}) });
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

  // The register previews cash rounding and change, and the balance left after a part payment, on every change (design 4.5).
  // A dry run still waiting when the inputs change, or when the payment is taken, is dropped with the effect.
  useEffect(() => {
    if (!tender || !check || done || busy) return;
    if (tender.is_cash || part) return runPreview(tender, amount, tender.is_cash ? tendered : null);
    setPreview(null);
    setPreviewError(amount > balance ? "Amount above the balance. Enter the balance or a smaller part payment." : null);
    return undefined;
  }, [tender, check, amount, tendered, part, balance, done, busy, runPreview]);

  const selectTender = (id: string) => {
    setTenderId(id);
    setTendered(null);
    setPreview(null);
  };

  const pay = async () => {
    if (!check || !tender || amount <= 0 || busy) return;
    setBusy(true);
    paying.current = true;
    const id = paymentId.current;
    try {
      await previewInFlight.current?.catch(() => undefined);
      const res = await actions.pay(check, { payment_id: id, tender_type_id: tender.id, amount, ...(tender.is_cash && tendered != null ? { tendered } : {}), ...(reference.trim() ? { reference: reference.trim() } : {}) }, tender.name);
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
      <Frame left={<BackButton label={screen.kind === "pay" && screen.returnTo === "bill" ? "Bill" : where} onPress={leave} />} title={`${done.check.label} · ${where}`}>
        <ReceiptChooser
          order={done.order}
          check={done.check}
          actions={actions}
          heading={`Paid · ${done.check.label} · ${money(paidAmount)}`}
          sub={tender.is_cash && change > 0 ? `Change ${money(change)}` : done.figures.rounding_cents ? `Cash rounding ${money(done.figures.rounding_cents)}` : null}
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
  const verb = tender.is_cash ? `Take ${money(tendered ?? amount)} cash` : tender.is_terminal ? (part ? `Take ${money(amount)} by ${tender.name}` : `Paid by ${tender.name}`) : `Take ${money(amount)} by ${tender.name}`;
  const label = `${verb}${part && left != null ? ` · ${money(left)} left` : ""} ▸`;
  // Too little cash for the rounded amount comes back from the dry run as a validation error, which blocks the button with its remedy.
  const blocked = offline || busy || amount <= 0 || Boolean(previewError);

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
                  <Money cents={a.total} size="line" className="text-ink" />
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
        </section>

        <section className="flex min-w-0 flex-1 flex-col px-6 py-4" aria-label="Payment">
          <div className="flex items-baseline gap-4">
            <span className="text-line text-ink-2">Balance</span>
            <Money cents={balance} size="amount-xl" className="text-ink" />
          </div>

          <TenderGrid tenders={list} selectedId={tender.id} onSelect={selectTender} isDisabled={busy} className="mt-4" />

          <div className="mt-5 flex items-center gap-4">
            <span className="text-line text-ink-2">Amount</span>
            <AriaButton
              onPress={() => {
                setEditing((e) => !e);
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

          {tender.is_cash ? (
            <div className="mt-5 flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Cash given">
                <span className="mr-2 text-caption text-ink-2 uppercase tracking-[0.04em]">Cash</span>
                <Button size="lg" variant={tendered === null ? "primary" : "secondary"} onPress={() => setTendered(null)} aria-pressed={tendered === null}>
                  Exact
                </Button>
                {likelyTendered(amount, denominations).map((n) => (
                  <Button key={n} size="lg" variant={tendered === n ? "primary" : "secondary"} onPress={() => setTendered(n)} aria-pressed={tendered === n} className="tabular">
                    {money(n, { dropZeroFraction: true })}
                  </Button>
                ))}
              </div>
              <p className="text-body text-ink-2 tabular" role="status" aria-live="polite">
                {figures ? (
                  <>
                    {rounding !== 0 ? `Cash rounding ${money(rounding)}` : part ? `Part payment of ${money(amount)}` : "No cash rounding"}
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
              {tender.is_terminal ? (
                <>
                  <Money cents={amount} size="amount-xl" className="text-ink" />
                  <p className="text-line text-ink">Charge {money(amount)} on the terminal, then tap Paid.</p>
                </>
              ) : (
                <p className="text-line text-ink">Record {money(amount)} to {tender.name}.</p>
              )}
              <TextField label={tender.requires_reference ? "Reference" : "Reference (optional)"} isRequired={tender.requires_reference} value={reference} onChange={setReference} inputClassName="min-h-14 text-line" className="max-w-[360px]" maxLength={80} mono />
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
            <Button size="lg" variant="primary" isDisabled={blocked} isPending={busy} onPress={pay} className="min-h-16 min-w-[280px] px-6 text-heading">
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
