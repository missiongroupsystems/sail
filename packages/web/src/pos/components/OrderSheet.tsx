"use client";

import { ArrowRight, Pause, Percent, ReceiptText, Utensils } from "lucide-react";
import { ActionDock, Button, GroupHeader, Icon, LineRow, SeatStrip, taxRows, TotalsBlock, type TaxRow, type TotalsRow, useLocale } from "@sail/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import type { GuestRound, ManualRule, OrderSnapshot, PrintJob, SnapshotLine } from "../api/types";
import type { OrderActions } from "../hooks/useOrderActions";
import { useUiStore } from "../state/ui";
import { usePos } from "./PosContext";
import { jobsForRound } from "./ReprintSheet";
import { PANEL } from "./styles";

export type OrderSheetProps = {
  order: OrderSnapshot;
  actions: OrderActions;
  rules: ManualRule[] | undefined;
  activeSeat: number | null;
  onSeat: (seat: number | null) => void;
  onLine: (line: SnapshotLine) => void;
  onDiscount: () => void;
  onBill: () => void;
  onPay: () => void;
  /** Tap a sent round's header: Reprint. */
  onReprintRound: (round: { number: number; firedAt: string | null }) => void;
  /** QR rounds waiting for acceptance on this order. */
  pendingRounds: GuestRound[];
  onAcceptRound: (round: GuestRound) => void;
  onRejectRound: (round: GuestRound) => void;
  /** Print jobs for this order and the ids the register lists as late (⚠ instead of ✓). */
  jobs: PrintJob[];
  lateJobIds: Set<string>;
  /** Sent lines the kitchen display has bumped (ready). */
  readyLineIds?: Set<string>;
  /** Closed order (Reopen, Refund; receipts are per bill on the closed order's summary). */
  onReopen: () => void;
  onRefund: () => void;
};

/** "pricing" after 150 ms of waiting for the register. */
function usePricing(orderId: string): boolean {
  const n = useUiStore((s) => s.inFlight[orderId] ?? 0);
  const [pricing, setPricing] = useState(false);
  useEffect(() => {
    if (n > 0) {
      const t = setTimeout(() => setPricing(true), 150);
      return () => clearTimeout(t);
    }
    setPricing(false);
    return undefined;
  }, [n]);
  return pricing;
}

/**
 * The order sheet: lines grouped NEW / HELD / SENT rounds, guest
 * lines with a QR chip and a waiting QR round above them, print
 * status per sent round, the totals block with every adjustment by
 * name plus Paid and Balance once money has been taken, and the action dock.
 */
export function OrderSheet({ order, actions, rules, activeSeat, onSeat, onLine, onDiscount, onBill, onPay, onReprintRound, pendingRounds, onAcceptRound, onRejectRound, jobs, lateJobIds, readyLineIds, onReopen, onRefund }: OrderSheetProps) {
  const { money, clock } = useLocale();
  const { station, offline, staff } = usePos();
  const pricing = usePricing(order.id);
  const closed = order.status === "completed";

  const pendingLineIds = useMemo(() => new Set(pendingRounds.flatMap((r) => r.line_ids)), [pendingRounds]);
  const live = order.lines.filter((l) => l.status !== "voided");
  const newLines = [...live.filter((l) => l.status === "pending" && !pendingLineIds.has(l.id))].reverse();
  const held = live.filter((l) => l.status === "held" && !pendingLineIds.has(l.id));
  const rounds = useMemo(() => {
    const m = new Map<number, SnapshotLine[]>();
    for (const l of order.lines) if (l.fire_round != null && (l.status === "fired" || l.status === "voided")) (m.get(l.fire_round) ?? m.set(l.fire_round, []).get(l.fire_round)!).push(l);
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [order.lines]);
  const removed = order.lines.filter((l) => l.status === "voided" && l.fire_round == null);

  // A line shows its menu price (base, as the receipt prints it): every discount, fee and tax is a totals row below, so
  // the column adds up to the subtotal instead of counting service and tax twice. Flash a row whose price changed;
  // slide in a row we have not seen.
  const prevAmounts = useRef(new Map<string, number>());
  const seen = useRef(new Set<string>());
  const flashes = new Set<string>();
  const entering = new Set<string>();
  for (const l of order.lines) {
    const prev = prevAmounts.current.get(l.id);
    if (prev !== undefined && prev !== l.amounts.base && !l.optimistic) flashes.add(l.id);
    if (!seen.current.has(l.id)) entering.add(l.id);
  }
  useEffect(() => {
    prevAmounts.current = new Map(order.lines.map((l) => [l.id, l.amounts.base]));
    for (const l of order.lines) seen.current.add(l.id);
  });

  const sendable = live.filter((l) => l.status === "pending" && !l.optimistic && !pendingLineIds.has(l.id)).length;
  const seats = Math.max(order.pax ?? 0, ...live.map((l) => l.seat_no ?? 0), 1);

  const tax = taxRows(order.totals.taxes, order.totals.tax_mode);
  const taxRow = (t: TaxRow): TotalsRow => ({ key: t.key, label: t.label, cents: t.amount, kind: "tax" });
  const rows: TotalsRow[] = [
    { key: "subtotal", label: "Subtotal", cents: order.totals.subtotal, kind: "subtotal" },
    ...order.adjustments.map<TotalsRow>((a) => {
      const manual = order.manual_applications.find((m) => m.id === a.manual_application_id);
      const rule = rules?.find((r) => r.rule_key === a.rule_key);
      return {
        key: `adj:${a.id}`,
        label: a.name,
        cents: a.total,
        kind: "adjustment",
        note: a.frozen ? "frozen" : a.capped ? "capped" : null,
        onRemove: manual && !a.frozen && !closed ? () => void actions.removeDiscount(manual.id, a.name, rule?.min_role ?? "server") : undefined,
        removeDisabled: offline,
      };
    }),
    ...tax.before.map(taxRow),
    { key: "total", label: "Total", cents: order.totals.total, kind: "total" },
    ...tax.after.map(taxRow),
    ...(order.paid_total > 0 ? [{ key: "paid", label: "Paid", cents: order.paid_total, kind: "adjustment" as const, note: order.pricing_status === "frozen" ? "prices frozen" : null }] : []),
    // The balance is always under the total, the register's figure, equal to the total until money is taken.
    { key: "balance", label: "Balance", cents: order.balance, kind: "total" as const },
  ];

  /** ✓ printed, ◷ waiting or ⚠ not printed for a round, from the register's jobs. */
  const printStatusFor = (firedAt: string | null): "printed" | "waiting" | "late" | null => {
    const mine = jobsForRound(jobs, firedAt);
    if (!mine.length) return null;
    if (mine.some((j) => lateJobIds.has(j.id) || j.status === "failed")) return "late";
    if (mine.every((j) => j.status === "printed" || j.status === "rerouted")) return "printed";
    return "waiting";
  };

  const row = (l: SnapshotLine, status: "new" | "held" | "sent" | "voided", printStatus: "printed" | "waiting" | "late" | null = null) => (
    <LineRow
      key={l.id}
      quantity={l.quantity}
      name={l.name}
      modifiers={l.modifiers.map((m) => (m.quantity > 1 ? `${m.name} ×${m.quantity}` : m.name))}
      notes={l.notes}
      seat={station.seats_enabled ? l.seat_no : null}
      amountCents={l.optimistic ? null : l.amounts.base}
      status={l.optimistic ? "pending" : status}
      voidReason={l.void_reason}
      flash={flashes.has(l.id)}
      entering={entering.has(l.id)}
      printStatus={printStatus}
      ready={status === "sent" && (readyLineIds?.has(l.id) ?? false)}
      chip={l.source === "guest" ? "QR" : null}
      onPress={status === "voided" || closed ? undefined : () => onLine(l)}
    />
  );

  const canRefund = order.checks.some((c) => c.paid_total > 0 && c.status !== "refunded");
  const managerPlus = ["manager", "finance", "admin"].includes(staff.role);
  const empty = live.length === 0 && rounds.length === 0 && pendingRounds.length === 0 && order.paid_total === 0;

  return (
    <section className={PANEL + " flex h-full w-[400px] shrink-0 flex-col overflow-hidden max-[1100px]:w-[360px] max-[900px]:w-[340px]"} aria-label="Order">
      {station.seats_enabled && order.order_type === "dine_in" && !closed ? <SeatStrip seats={seats} active={activeSeat} onChange={onSeat} onAddSeat={() => onSeat(seats + 1)} className="shrink-0 border-b border-rule px-3" /> : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {empty ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
            <Icon icon={Utensils} size={22} className="text-ink-2" />
            <p className="max-w-[30ch] text-body text-ink-2">No items yet. Tap an item on the left to start this order.</p>
          </div>
        ) : null}
        {pendingRounds.map((r) => {
          const lines = live.filter((l) => r.line_ids.includes(l.id));
          return (
            <div key={r.id} className="mx-2 mt-2 rounded-tile bg-[color-mix(in_srgb,var(--status-seated)_8%,transparent)] pb-2">
              <div className="flex min-h-9 items-center justify-between gap-2 px-3 pt-2 pb-1">
                <span className="text-caption text-status-seated uppercase tracking-[0.04em]">
                  QR order · waiting for acceptance
                  <span className="normal-case tracking-normal text-ink-2"> · {clock(r.submitted_at)}{r.guest_name ? ` · ${r.guest_name}` : ""}</span>
                </span>
                <span className="flex gap-1">
                  <Button size="md" variant="quiet" isDisabled={offline} onPress={() => onRejectRound(r)} className="text-ink-2">
                    Reject
                  </Button>
                  <Button size="md" variant="primary" isDisabled={offline} onPress={() => onAcceptRound(r)}>
                    Accept
                  </Button>
                </span>
              </div>
              {lines.map((l) => row(l, "held"))}
              {r.notes ? <p className="px-4 text-caption text-ink-2 italic">{r.notes}</p> : null}
            </div>
          );
        })}
        {newLines.length ? (
          <>
            <GroupHeader label="New" detail="not sent yet" />
            {newLines.map((l) => row(l, "new"))}
          </>
        ) : null}
        {held.length ? (
          <>
            <GroupHeader label="Held" action={closed ? undefined : { label: "Release all", onPress: () => void actions.releaseHeld(), isDisabled: offline }} />
            {held.map((l) => row(l, "held"))}
          </>
        ) : null}
        {rounds.map(([round, lines]) => {
          const firedAt = lines[0]?.fired_at ?? null;
          const ps = printStatusFor(firedAt);
          return (
            <div key={round}>
              <GroupHeader label={`Sent ${firedAt ? clock(firedAt) : ""}`} detail={`round ${round}${ps === "late" ? " · ⚠ not printed" : ""}`} action={{ label: "Reprint", onPress: () => onReprintRound({ number: round, firedAt }), isDisabled: offline }} />
              {lines.map((l) => row(l, l.status === "voided" ? "voided" : "sent", ps))}
            </div>
          );
        })}
        {removed.length ? (
          <>
            <GroupHeader label="Removed" />
            {removed.map((l) => row(l, "voided"))}
          </>
        ) : null}
      </div>
      {/* An empty order has nothing to total: the figures appear with the first line. */}
      {empty ? null : (
        <div className="shrink-0 border-t border-rule px-1 pt-1">
          <TotalsBlock rows={rows} pricing={pricing} />
        </div>
      )}
      {closed ? (
        <ActionDock
          offline={offline}
          primary={{ id: "reopen", label: "Reopen", ariaLabel: "Reopen this order", onPress: onReopen, needsApproval: !managerPlus }}
          secondaries={[
            { id: "refund", label: "Refund", onPress: onRefund, isDisabled: !canRefund, needsApproval: !managerPlus },
          ]}
        />
      ) : (
        <ActionDock
          offline={offline}
          primary={
            sendable > 0
              ? { id: "send", label: `Send ${sendable}`, ariaLabel: `Send ${sendable} to kitchen`, onPress: () => void actions.send(), trailingIcon: ArrowRight }
              : live.length === 0
                ? // Nothing on the order yet: a disabled Send, not "Pay $0.00".
                  { id: "send", label: "Send", ariaLabel: "Send to kitchen", onPress: () => undefined, isDisabled: true, trailingIcon: ArrowRight }
                : { id: "pay", label: `Pay ${money(order.balance)}`, ariaLabel: `Pay ${money(order.balance)}`, onPress: onPay, isDisabled: live.length === 0 || order.balance <= 0, needsApproval: !["cashier", "manager", "finance", "admin"].includes(staff.role), approvalLabel: "Cashier approval" }
          }
          secondaries={[
            // Hold goes with Send: once nothing new is waiting, Pay takes the space so the dock fits the order column.
            ...(sendable > 0 ? [{ id: "hold", label: "Hold", icon: Pause, onPress: () => void actions.holdAllNew() }] : []),
            { id: "discount", label: "Discount", icon: Percent, onPress: onDiscount, isDisabled: live.length === 0 || order.pricing_status === "frozen", needsApproval: rules ? rules.every((r) => !roleOk(staff.role, r.min_role)) : false, approvalLabel: rules?.length ? `${lowestRole(rules.map((r) => r.min_role))} approval` : undefined },
            { id: "bill", label: "Bill", icon: ReceiptText, onPress: onBill, mutates: false, isDisabled: live.length === 0 },
          ]}
        />
      )}
    </section>
  );
}

const RANK: Record<string, number> = { server: 10, cashier: 20, manager: 30, finance: 40, admin: 50 };
/** The least of the roles, capitalised ("Cashier"), for an approval badge. */
function lowestRole(roles: string[]): string {
  const r = [...roles].sort((a, b) => (RANK[a] ?? 0) - (RANK[b] ?? 0))[0] ?? "manager";
  return `${r.charAt(0).toUpperCase()}${r.slice(1)}`;
}
function roleOk(role: string, min: string) {
  return (RANK[role] ?? 0) >= (RANK[min] ?? 0);
}
