"use client";

import { BackButton, Skeleton } from "@sail/ui";
import { useEffect, useState } from "react";
import type { SnapshotLine } from "../api/types";
import { Catalogue } from "../components/Catalogue";
import { DiscountSheet } from "../components/DiscountSheet";
import { Frame } from "../components/Frame";
import { LaterPhaseSheet } from "../components/LaterPhaseSheet";
import { LineSheet } from "../components/LineSheet";
import { OrderMenu } from "../components/OrderMenu";
import { OrderSheet } from "../components/OrderSheet";
import { usePos } from "../components/PosContext";
import { useManualRules, useOrder } from "../hooks/queries";
import { useOrderActions } from "../hooks/useOrderActions";
import { useNow } from "../lib/device";
import { formatClock, formatElapsed, ORDER_TYPE_LABEL } from "../lib/format";
import { useNavStore } from "../state/nav";
import { useUiStore } from "../state/ui";

type SheetState = { kind: "line"; lineId: string } | { kind: "discount" } | { kind: "bill" } | { kind: "pay" } | null;

/** Order entry (design 4.3): rail + catalogue, the order sheet, and the sheets that hang off them. */
export function OrderScreen({ orderId }: { orderId: string }) {
  const { tablesById } = usePos();
  const screen = useNavStore((s) => s.screen);
  const back = useNavStore((s) => s.back);
  const order = useOrder(orderId);
  const rules = useManualRules();
  const actions = useOrderActions(orderId);
  const activeSeat = useUiStore((s) => s.activeSeat[orderId] ?? null);
  const setActiveSeat = useUiStore((s) => s.setActiveSeat);
  const [sheet, setSheet] = useState<SheetState>(null);
  const now = useNow(1000);

  const snap = order.data;
  // Closed orders leave the screen: cancelled from here, or completed on another station.
  useEffect(() => {
    if (snap && (snap.status === "cancelled" || snap.status === "completed")) back();
  }, [snap, back]);

  const from = screen.kind === "order" ? screen.from : "floor";
  const table = snap?.table_id ? tablesById.get(snap.table_id) : null;
  const title = snap
    ? [
        snap.order_type === "dine_in" ? `Table ${table?.name ?? "…"}` : snap.order_no,
        snap.pax ? `${snap.pax} ${snap.pax === 1 ? "guest" : "guests"}` : null,
        ORDER_TYPE_LABEL[snap.order_type],
        snap.customer_ref?.name ?? null,
        snap.ready_by ? `ready by ${formatClock(snap.ready_by)}` : formatElapsed((now - new Date(snap.opened_at).getTime()) / 1000),
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  const line: SnapshotLine | null = sheet?.kind === "line" ? (snap?.lines.find((l) => l.id === sheet.lineId) ?? null) : null;

  return (
    <Frame left={<BackButton label={from === "orders" ? "Orders" : "Floor"} onPress={back} />} title={title} right={snap ? <OrderMenu order={snap} actions={actions} /> : null}>
      {!snap ? (
        <div className="flex flex-1 gap-4 p-4">
          <Skeleton className="h-full w-[140px]" />
          <Skeleton className="h-full flex-1" />
          <Skeleton className="h-full w-[420px]" />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <Catalogue order={snap} actions={actions} activeSeat={activeSeat} />
          <OrderSheet
            order={snap}
            actions={actions}
            rules={rules.data}
            activeSeat={activeSeat}
            onSeat={(seat) => setActiveSeat(orderId, seat)}
            onLine={(l) => setSheet({ kind: "line", lineId: l.id })}
            onDiscount={() => setSheet({ kind: "discount" })}
            onBill={() => setSheet({ kind: "bill" })}
            onPay={() => setSheet({ kind: "pay" })}
          />
        </div>
      )}
      {snap ? <LineSheet order={snap} line={line && !line.optimistic ? line : null} onClose={() => setSheet(null)} actions={actions} /> : null}
      {snap ? <DiscountSheet isOpen={sheet?.kind === "discount"} onClose={() => setSheet(null)} order={snap} rules={rules.data} actions={actions} /> : null}
      <LaterPhaseSheet isOpen={sheet?.kind === "bill" || sheet?.kind === "pay"} onClose={() => setSheet(null)} title={sheet?.kind === "pay" ? "Pay" : "Bill"} />
    </Frame>
  );
}
