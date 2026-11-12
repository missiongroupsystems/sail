"use client";

import { BackButton, Button, Money, Skeleton, useLocale } from "@sail/ui";
import { useEffect, useMemo, useState } from "react";
import type { GuestRound, SnapshotLine } from "../api/types";
import { Catalogue } from "../components/Catalogue";
import { DiscountSheet } from "../components/DiscountSheet";
import { Frame } from "../components/Frame";
import { LineSheet } from "../components/LineSheet";
import { OrderMenu } from "../components/OrderMenu";
import { OrderSheet } from "../components/OrderSheet";
import { usePos } from "../components/PosContext";
import { RefundSheet } from "../components/RefundSheet";
import { RejectRoundSheet, ReopenSheet } from "../components/ReasonSheets";
import { ReprintSheet } from "../components/ReprintSheet";
import { useLateJobs, useManualRules, useOrder, useOrderPrintJobs, usePendingRounds, useReadyLineIds } from "../hooks/queries";
import { useOrderActions } from "../hooks/useOrderActions";
import { useNow } from "../lib/device";
import { formatElapsed, ORDER_TYPE_LABEL } from "../lib/format";
import { useNavStore } from "../state/nav";
import { useUiStore } from "../state/ui";

type SheetState = { kind: "line"; lineId: string } | { kind: "discount" } | { kind: "refund"; checkId?: string | null } | { kind: "reprint"; round: { number: number; firedAt: string | null } | null } | { kind: "reopen" } | { kind: "reject"; round: GuestRound } | null;

/** Order entry: rail + catalogue, the order sheet, and the sheets that hang off them. Closed orders stay readable for Reopen, Refund and receipts. */
export function OrderScreen({ orderId }: { orderId: string }) {
  const { money, clock } = useLocale();
  const { tablesById, station, offline } = usePos();
  const screen = useNavStore((s) => s.screen);
  const back = useNavStore((s) => s.back);
  const openBill = useNavStore((s) => s.openBill);
  const openPay = useNavStore((s) => s.openPay);
  const order = useOrder(orderId);
  const rules = useManualRules();
  const actions = useOrderActions(orderId);
  const activeSeat = useUiStore((s) => s.activeSeat[orderId] ?? null);
  const setActiveSeat = useUiStore((s) => s.setActiveSeat);
  const [sheet, setSheet] = useState<SheetState>(null);
  const now = useNow(1000);

  const snap = order.data;
  const closed = snap?.status === "completed";
  const rounds = usePendingRounds(station.outlet_id);
  const pendingRounds = useMemo(() => (rounds.data ?? []).filter((r) => r.order_id === orderId), [rounds.data, orderId]);
  const jobs = useOrderPrintJobs(station.outlet_id, orderId, Boolean(snap && snap.round_count > 0));
  const ready = useReadyLineIds(station.outlet_id, orderId, Boolean(snap && snap.round_count > 0));
  const late = useLateJobs(station.outlet_id);
  const lateJobIds = useMemo(() => new Set((late.data ?? []).map((j) => j.id)), [late.data]);

  // A cancelled order leaves the screen; a completed one stays readable (Reopen, Refund).
  useEffect(() => {
    if (snap && snap.status === "cancelled") back();
  }, [snap, back]);

  const from = screen.kind === "order" ? screen.from : "floor";
  const table = snap?.table_id ? tablesById.get(snap.table_id) : null;
  const title = snap
    ? [
        snap.order_type === "dine_in" ? `Table ${table?.name ?? "…"}` : snap.order_no,
        snap.pax ? `${snap.pax} ${snap.pax === 1 ? "guest" : "guests"}` : null,
        ORDER_TYPE_LABEL[snap.order_type],
        snap.customer_ref?.name ?? null,
        closed ? `Done ${snap.completed_at ? clock(snap.completed_at) : ""}` : snap.ready_by ? `ready by ${clock(snap.ready_by)}` : formatElapsed((now - new Date(snap.opened_at).getTime()) / 1000),
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  const line: SnapshotLine | null = sheet?.kind === "line" ? (snap?.lines.find((l) => l.id === sheet.lineId) ?? null) : null;

  const pay = () => {
    if (!snap) return;
    const open = snap.checks.filter((c) => c.status === "open");
    if (snap.checks.length === 1 && open[0]) openPay(orderId, open[0].id, "order");
    else openBill(orderId);
  };

  return (
    <Frame left={<BackButton label={from === "orders" ? "Orders" : "Floor"} onPress={back} />} title={title} right={snap ? <OrderMenu order={snap} actions={actions} onOpen={(k) => setSheet(k === "refund" ? { kind: "refund" } : k === "reopen" ? { kind: "reopen" } : { kind: "reprint", round: null })} /> : null}>
      {!snap ? (
        <div className="flex flex-1 gap-4 p-4">
          <Skeleton className="h-full w-[140px]" />
          <Skeleton className="h-full flex-1" />
          <Skeleton className="h-full w-[420px]" />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {closed ? (
            <section className="flex min-w-0 flex-1 flex-col items-center justify-center gap-6 px-8" aria-label="Order done">
              <div className="flex flex-col items-center gap-1">
                <p className="text-caption text-ink-2 uppercase tracking-[0.04em]">Done</p>
                <Money cents={snap.paid_total} size="display" className="text-ink" />
                <p className="text-body text-ink-2">
                  {snap.checks.length} {snap.checks.length === 1 ? "bill" : "bills"} · paid {snap.completed_at ? clock(snap.completed_at) : ""}
                  {snap.checks.some((c) => c.refunded_total > 0) ? " · partly refunded" : ""}
                </p>
              </div>
              <ul className="flex flex-col gap-2">
                {snap.checks.map((c) => (
                  <li key={c.id} className="flex min-h-14 items-center gap-3 rounded-tile bg-surface px-4 hairline">
                    <span className="min-w-0 flex-1 text-line text-ink">
                      {c.label}
                      <span className="text-caption text-ink-2">
                        {" · "}
                        {c.payments.filter((p) => p.status === "recorded").map((p) => `${p.tender} ${money(p.amount)}${p.tip_cents ? ` + tip ${money(p.tip_cents)}` : ""}`).join(", ")}
                        {c.refunded_total > 0 ? ` · refunded ${money(c.refunded_total)}` : ""}
                        {c.invoice_no ? ` · Invoice ${c.invoice_no}` : ""}
                      </span>
                    </span>
                    <Button size="md" variant="quiet" isDisabled={offline} onPress={() => void actions.printReceipt(c.id)}>
                      Receipt
                    </Button>
                    <Button size="md" variant="quiet" isDisabled={offline} onPress={() => void actions.issueInvoice(c.id)}>
                      {c.invoice_no ? "Invoice issued" : "Get invoice"}
                    </Button>
                    <Button size="md" variant="secondary" isDisabled={offline || c.status === "refunded" || c.paid_total === 0} onPress={() => setSheet({ kind: "refund", checkId: c.id })}>
                      Refund
                    </Button>
                  </li>
                ))}
              </ul>
              <p className="text-body text-ink-2">Reopen the order to change it. Same business day, Manager approval.</p>
            </section>
          ) : (
            <Catalogue order={snap} actions={actions} activeSeat={activeSeat} />
          )}
          <OrderSheet
            order={snap}
            actions={actions}
            rules={rules.data}
            activeSeat={activeSeat}
            onSeat={(seat) => setActiveSeat(orderId, seat)}
            onLine={(l) => setSheet({ kind: "line", lineId: l.id })}
            onDiscount={() => setSheet({ kind: "discount" })}
            onBill={() => openBill(orderId)}
            onPay={pay}
            onReprintRound={(round) => setSheet({ kind: "reprint", round })}
            pendingRounds={pendingRounds}
            onAcceptRound={(r) => void actions.acceptRound(r.id)}
            onRejectRound={(r) => setSheet({ kind: "reject", round: r })}
            jobs={jobs.data ?? []}
            lateJobIds={lateJobIds}
            readyLineIds={ready.data}
            onReopen={() => setSheet({ kind: "reopen" })}
            onRefund={() => setSheet({ kind: "refund" })}
          />
        </div>
      )}
      {snap ? <LineSheet order={snap} line={line && !line.optimistic ? line : null} onClose={() => setSheet(null)} actions={actions} /> : null}
      {snap ? <DiscountSheet isOpen={sheet?.kind === "discount"} onClose={() => setSheet(null)} order={snap} rules={rules.data} actions={actions} /> : null}
      {snap ? <RefundSheet isOpen={sheet?.kind === "refund"} onClose={() => setSheet(null)} order={snap} actions={actions} initialCheckId={sheet?.kind === "refund" ? (sheet.checkId ?? null) : null} /> : null}
      {snap ? <ReprintSheet isOpen={sheet?.kind === "reprint"} onClose={() => setSheet(null)} order={snap} actions={actions} round={sheet?.kind === "reprint" ? sheet.round : null} /> : null}
      <ReopenSheet isOpen={sheet?.kind === "reopen"} onClose={() => setSheet(null)} onReopen={(reason) => actions.reopen(reason)} />
      <RejectRoundSheet isOpen={sheet?.kind === "reject"} roundLabel={sheet?.kind === "reject" ? `${sheet.round.lines.length} ${sheet.round.lines.length === 1 ? "item" : "items"}${sheet.round.guest_name ? ` · ${sheet.round.guest_name}` : ""}` : null} onClose={() => setSheet(null)} onReject={(reason) => (sheet?.kind === "reject" ? actions.rejectRound(sheet.round.id, reason) : Promise.resolve(null))} />
    </Frame>
  );
}
