"use client";

import { Button, NowRail, QuantityStepper, Sheet, Skeleton, StatusLegend, TableShape, type NowItem } from "@sail/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { idempotencyKey, toApiError } from "@/lib/api";
import { openOrder } from "../api/register";
import type { FloorTable } from "../api/types";
import { Frame } from "../components/Frame";
import { usePos } from "../components/PosContext";
import { useApplySnapshot, useFloor } from "../hooks/queries";
import { useApi } from "../hooks/useApi";
import { useNow } from "../lib/device";
import { formatClock, formatElapsed } from "../lib/format";
import { useNavStore } from "../state/nav";
import { useUiStore } from "../state/ui";

/**
 * The floor plan (design 4.2): area tabs, tables drawn at their positions with
 * status as colour + icon, pax and elapsed time, the legend, and the Now rail.
 * Tap a free table → pax → order (2 taps). Tap a seated table → order (1 tap).
 */
export function FloorScreen() {
  const api = useApi();
  const { outlet, station, offline } = usePos();
  const floor = useFloor(station.outlet_id);
  const applySnapshot = useApplySnapshot();
  const openOrderScreen = useNavStore((s) => s.openOrder);
  const notify = useUiStore((s) => s.notify);
  const now = useNow(1000);

  const snapshot = floor.data?.snapshot;
  const receivedAt = floor.data?.receivedAt ?? now;
  const [areaId, setAreaId] = useState<string | null>(null);
  const area = snapshot?.areas.find((a) => a.id === areaId) ?? snapshot?.areas[0] ?? null;
  const tables = useMemo(() => (snapshot?.tables ?? []).filter((t) => t.area_id === area?.id), [snapshot, area]);

  const [seating, setSeating] = useState<FloorTable | null>(null);
  const [opening, setOpening] = useState(false);

  const seat = async (table: FloorTable, pax: number) => {
    setOpening(true);
    try {
      const res = await openOrder(api, { order_id: idempotencyKey(), order_type: "dine_in", table_id: table.id, pax });
      applySnapshot(res.data);
      setSeating(null);
      openOrderScreen(res.data.id, "floor");
    } catch (e) {
      const err = toApiError(e);
      notify({ text: err.message, remedy: err.remedy ?? null, tone: "alert" }, 8000);
      if (err.code === "state_conflict") void floor.refetch();
    } finally {
      setOpening(false);
    }
  };

  const newTakeaway = async () => {
    setOpening(true);
    try {
      const res = await openOrder(api, { order_id: idempotencyKey(), order_type: "takeaway" });
      applySnapshot(res.data);
      openOrderScreen(res.data.id, "orders");
    } catch (e) {
      const err = toApiError(e);
      notify({ text: err.message, remedy: err.remedy ?? null, tone: "alert" }, 8000);
    } finally {
      setOpening(false);
    }
  };

  const nowItems: NowItem[] = useMemo(() => {
    if (!snapshot) return [];
    const items: NowItem[] = [];
    for (const t of snapshot.tables) {
      if (t.order && t.order.pending_rounds > 0) items.push({ id: `qr:${t.id}`, title: `Table ${t.name} · QR order`, detail: `${t.order.pending_rounds} waiting to be accepted`, actions: [{ id: "view", label: "View", onPress: () => openOrderScreen(t.order!.id, "floor") }] });
      if (t.requests_waiting > 0) items.push({ id: `req:${t.id}`, title: `Table ${t.name} · ${t.requests_waiting} ${t.requests_waiting === 1 ? "request" : "requests"}`, detail: "Table request", actions: t.order ? [{ id: "view", label: "View", onPress: () => openOrderScreen(t.order!.id, "floor") }] : [] });
    }
    for (const o of snapshot.other_orders) {
      if (o.status === "ready") items.push({ id: `ready:${o.id}`, title: `${o.order_no} · Ready${o.customer_ref?.name ? ` · ${o.customer_ref.name}` : ""}`, detail: o.ready_by ? `Ready by ${formatClock(o.ready_by)}` : null, actions: [{ id: "view", label: "View", onPress: () => openOrderScreen(o.id, "orders") }] });
    }
    return items;
  }, [snapshot, openOrderScreen]);

  return (
    <Frame title={`${outlet?.name ?? ""}${area ? ` · ${area.name}` : ""}`}>
      <div className="flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1 flex-col px-5 pt-3 pb-3">
          <div className="flex items-center gap-2" role="group" aria-label="Areas">
            {(snapshot?.areas ?? []).map((a) => (
              <Button key={a.id} size="lg" variant={a.id === area?.id ? "primary" : "secondary"} onPress={() => setAreaId(a.id)} aria-pressed={a.id === area?.id}>
                {a.name}
              </Button>
            ))}
            {!snapshot && floor.isLoading ? <Skeleton className="h-14 w-40" /> : null}
            {snapshot && snapshot.areas.length === 0 ? <p className="text-body text-ink-2">No areas yet. Add tables in the back office under Floor &amp; QR.</p> : null}
          </div>
          <FloorCanvas tables={tables} now={now} receivedAt={receivedAt} disabled={opening} onTable={(t) => (t.order ? openOrderScreen(t.order.id, "floor") : offline ? notify({ text: "Offline", remedy: "Seating a table needs the register. Reconnecting…", tone: "alert" }) : setSeating(t))} />
          <StatusLegend className="pt-2" />
        </section>
        <NowRail
          items={nowItems}
          footer={
            <Button size="lg" variant="secondary" onPress={newTakeaway} isDisabled={offline || opening} isPending={opening}>
              {offline ? "Offline" : "+ Takeaway order"}
            </Button>
          }
        />
      </div>

      <Sheet isOpen={Boolean(seating)} onOpenChange={(o) => (!o ? setSeating(null) : undefined)} title={seating ? `Table ${seating.name}` : ""} description="How many guests?" isDismissable={!opening}>
        {seating ? <PaxPicker suggested={seating.seats} isPending={opening} onPick={(pax) => void seat(seating, pax)} /> : null}
      </Sheet>
    </Frame>
  );
}

/** 1–8 as big buttons, "More…" for 9+ (design 4.2). */
function PaxPicker({ suggested, isPending, onPick }: { suggested: number; isPending: boolean; onPick: (pax: number) => void }) {
  const [more, setMore] = useState(false);
  const [n, setN] = useState(Math.max(9, suggested));
  if (more) {
    return (
      <div className="flex flex-col items-center gap-6 pt-4">
        <QuantityStepper value={n} onChange={setN} min={9} max={99} label="Guests" />
        <Button variant="primary" size="lg" isPending={isPending} onPress={() => onPick(n)} className="min-w-[240px]">
          Seat {n} guests
        </Button>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-3 gap-3">
      {Array.from({ length: 8 }, (_, i) => i + 1).map((p) => (
        <Button key={p} size="lg" variant={p === suggested ? "primary" : "secondary"} isDisabled={isPending} onPress={() => onPick(p)} className="h-20 text-title tabular" aria-label={`${p} ${p === 1 ? "guest" : "guests"}`}>
          {p}
        </Button>
      ))}
      <Button size="lg" variant="quiet" isDisabled={isPending} onPress={() => setMore(true)} className="h-20">
        More…
      </Button>
    </div>
  );
}

/** Tables on a grid from x/y/w/h; the cell size follows the width so every layout fits (design 4.2). */
function FloorCanvas({ tables, now, receivedAt, disabled, onTable }: { tables: FloorTable[]; now: number; receivedAt: number; disabled: boolean; onTable: (t: FloorTable) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const cols = Math.max(8, ...tables.map((t) => t.x + t.w));
  const rows = Math.max(4, ...tables.map((t) => t.y + t.h));
  const gap = 12;
  const cell = Math.max(44, Math.min(76, Math.floor((width - gap * (cols - 1)) / cols)));
  const height = rows * cell + (rows - 1) * gap;
  return (
    <div ref={ref} className="relative mt-4 min-h-0 flex-1 overflow-auto">
      <div className="relative" style={{ height, minWidth: cols * cell + (cols - 1) * gap }}>
        {tables.map((t) => {
          const elapsed = t.order ? t.order.elapsed_seconds + Math.max(0, (now - receivedAt) / 1000) : null;
          return (
            <TableShape
              key={t.id}
              name={t.name}
              shape={t.shape}
              status={t.status}
              pax={t.order?.pax ?? null}
              elapsed={elapsed != null ? formatElapsed(elapsed) : null}
              needsYou={t.requests_waiting > 0 || (t.order?.pending_rounds ?? 0) > 0}
              isDisabled={disabled}
              onPress={() => onTable(t)}
              style={{ left: t.x * (cell + gap), top: t.y * (cell + gap), width: t.w * cell + (t.w - 1) * gap, height: t.h * cell + (t.h - 1) * gap }}
            />
          );
        })}
        {tables.length === 0 ? <p className="absolute inset-x-0 top-8 text-center text-body text-ink-2">No tables in this area.</p> : null}
      </div>
    </div>
  );
}
