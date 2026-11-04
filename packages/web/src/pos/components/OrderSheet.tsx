"use client";

import { ActionDock, GroupHeader, LineRow, SeatStrip, TotalsBlock, formatCents, type TotalsRow } from "@sail/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ManualRule, OrderSnapshot, SnapshotLine } from "../api/types";
import type { useOrderActions } from "../hooks/useOrderActions";
import { formatClock, gstLabel } from "../lib/format";
import { useUiStore } from "../state/ui";
import { usePos } from "./PosContext";

export type OrderSheetProps = {
  order: OrderSnapshot;
  actions: ReturnType<typeof useOrderActions>;
  rules: ManualRule[] | undefined;
  activeSeat: number | null;
  onSeat: (seat: number | null) => void;
  onLine: (line: SnapshotLine) => void;
  onDiscount: () => void;
  onBill: () => void;
  onPay: () => void;
};

/** "pricing" after 150 ms of waiting for the register (design 7.8). */
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
 * The order sheet (design 4.3): lines grouped NEW / HELD / SENT rounds, the
 * totals block with every adjustment by name, and the action dock.
 */
export function OrderSheet({ order, actions, rules, activeSeat, onSeat, onLine, onDiscount, onBill, onPay }: OrderSheetProps) {
  const { station, offline, staff } = usePos();
  const pricing = usePricing(order.id);

  const live = order.lines.filter((l) => l.status !== "voided");
  const newLines = [...live.filter((l) => l.status === "pending")].reverse();
  const held = live.filter((l) => l.status === "held");
  const rounds = useMemo(() => {
    const m = new Map<number, SnapshotLine[]>();
    for (const l of order.lines) if (l.fire_round != null && (l.status === "fired" || l.status === "voided")) (m.get(l.fire_round) ?? m.set(l.fire_round, []).get(l.fire_round)!).push(l);
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [order.lines]);
  const removed = order.lines.filter((l) => l.status === "voided" && l.fire_round == null);

  // Flash a row whose register amount changed; slide in a row we have not seen (design 7.7).
  const prevAmounts = useRef(new Map<string, number>());
  const seen = useRef(new Set<string>());
  const flashes = new Set<string>();
  const entering = new Set<string>();
  for (const l of order.lines) {
    const prev = prevAmounts.current.get(l.id);
    if (prev !== undefined && prev !== l.amounts.total && !l.optimistic) flashes.add(l.id);
    if (!seen.current.has(l.id)) entering.add(l.id);
  }
  useEffect(() => {
    prevAmounts.current = new Map(order.lines.map((l) => [l.id, l.amounts.total]));
    for (const l of order.lines) seen.current.add(l.id);
  });

  const sendable = live.filter((l) => l.status === "pending" && !l.optimistic).length;
  const seats = Math.max(order.pax ?? 0, ...live.map((l) => l.seat_no ?? 0), 1);

  const inclusive = order.totals.tax_mode === "inclusive";
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
        onRemove: manual && !a.frozen ? () => void actions.removeDiscount(manual.id, a.name, rule?.min_role ?? "server") : undefined,
        removeDisabled: offline,
      };
    }),
    { key: "gst", label: gstLabel(order.totals.gst_bps, inclusive), cents: order.totals.gst_total, kind: "gst" },
    { key: "total", label: "Total", cents: order.totals.total, kind: "total" },
  ];

  const row = (l: SnapshotLine, status: "new" | "held" | "sent" | "voided") => (
    <LineRow
      key={l.id}
      quantity={l.quantity}
      name={l.name}
      modifiers={l.modifiers.map((m) => (m.quantity > 1 ? `${m.name} ×${m.quantity}` : m.name))}
      notes={l.notes}
      seat={station.seats_enabled ? l.seat_no : null}
      amountCents={l.optimistic ? null : l.amounts.total}
      status={l.optimistic ? "pending" : status}
      voidReason={l.void_reason}
      flash={flashes.has(l.id)}
      entering={entering.has(l.id)}
      onPress={status === "voided" ? undefined : () => onLine(l)}
    />
  );

  return (
    <section className="flex h-full w-[420px] shrink-0 flex-col hairline-l bg-surface" aria-label="Order">
      {station.seats_enabled && order.order_type === "dine_in" ? <SeatStrip seats={seats} active={activeSeat} onChange={onSeat} onAddSeat={() => onSeat(seats + 1)} className="hairline-b" /> : null}
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {live.length === 0 && rounds.length === 0 ? <p className="px-4 pt-6 text-body text-ink-2">No items yet. Tap a tile to add the first one.</p> : null}
        {newLines.length ? (
          <>
            <GroupHeader label="New" />
            {newLines.map((l) => row(l, "new"))}
          </>
        ) : null}
        {held.length ? (
          <>
            <GroupHeader label="Held" action={{ label: "Release all", onPress: () => void actions.releaseHeld(), isDisabled: offline }} />
            {held.map((l) => row(l, "held"))}
          </>
        ) : null}
        {rounds.map(([round, lines]) => (
          <div key={round}>
            <GroupHeader label={`Sent ${lines[0]?.fired_at ? formatClock(lines[0].fired_at) : ""}`} detail={`round ${round}`} />
            {lines.map((l) => row(l, l.status === "voided" ? "voided" : "sent"))}
          </div>
        ))}
        {removed.length ? (
          <>
            <GroupHeader label="Removed" />
            {removed.map((l) => row(l, "voided"))}
          </>
        ) : null}
      </div>
      <div className="hairline-t">
        <TotalsBlock rows={rows} pricing={pricing} />
      </div>
      <ActionDock
        offline={offline}
        primary={
          sendable > 0
            ? { id: "send", label: `Send ${sendable} ▸`, ariaLabel: `Send ${sendable} to kitchen`, onPress: () => void actions.send(), isDisabled: pricing && sendable === 0 }
            : { id: "pay", label: `Pay ${formatCents(order.balance)} ▸`, ariaLabel: `Pay ${formatCents(order.balance)}`, onPress: onPay, isDisabled: live.length === 0 }
        }
        secondaries={[
          { id: "hold", label: "Hold", onPress: () => void actions.holdAllNew(), isDisabled: sendable === 0 },
          { id: "discount", label: "Discount", onPress: onDiscount, isDisabled: live.length === 0, needsApproval: rules ? rules.every((r) => !roleOk(staff.role, r.min_role)) : false },
          { id: "bill", label: "Bill", onPress: onBill, mutates: false },
        ]}
      />
    </section>
  );
}

const RANK: Record<string, number> = { server: 10, cashier: 20, manager: 30, finance: 40, admin: 50 };
function roleOk(role: string, min: string) {
  return (RANK[role] ?? 0) >= (RANK[min] ?? 0);
}
