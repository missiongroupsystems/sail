"use client";

import { Button, NowRail, QuantityStepper, Sheet, Skeleton, StatusLegend, TableShape, type NowItem } from "@sail/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { idempotencyKey, toApiError } from "@/lib/api";
import { openOrder } from "../api/register";
import type { FloorTable, GuestRound } from "../api/types";
import { Frame } from "../components/Frame";
import { usePos } from "../components/PosContext";
import { RejectRoundSheet } from "../components/ReasonSheets";
import { useApplySnapshot, useFloor, useOpenServiceRequests, usePendingRounds } from "../hooks/queries";
import { useApi } from "../hooks/useApi";
import { useNowActions } from "../hooks/useNowActions";
import { useNow } from "../lib/device";
import { formatClock, formatElapsed } from "../lib/format";
import { useNavStore } from "../state/nav";
import { useSoundStore, useUiStore } from "../state/ui";

const REQUEST_LABEL: Record<string, string> = { water: "Water", call_staff: "Call staff", call_for_bill: "Bill, please", cutlery: "Cutlery", napkins: "Napkins", help: "Help" };
const requestLabel = (type: string) => REQUEST_LABEL[type] ?? type.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** Two short soft tones (design 7.9), only when the station has turned sound on. The context is created on the toggle tap, which is the user gesture browsers need. */
let audio: AudioContext | null = null;
function tone(kind: "new" | "alert") {
  try {
    audio ??= new AudioContext();
    const ctx = audio;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = kind === "new" ? 880 : 660;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.08, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + 0.4);
  } catch {
    // No audio: the Now rail still shows the item.
  }
}

/**
 * The floor plan (design 4.2): area tabs, tables drawn at their positions with
 * status as colour + icon, pax and elapsed time, the legend, and the Now rail
 * with QR orders, table requests and ready pickups, each with its action inline.
 */
export function FloorScreen() {
  const api = useApi();
  const { outlet, station, offline } = usePos();
  const floor = useFloor(station.outlet_id);
  const rounds = usePendingRounds(station.outlet_id);
  const requests = useOpenServiceRequests(station.outlet_id);
  const nowActions = useNowActions(station.outlet_id);
  const applySnapshot = useApplySnapshot();
  const openOrderScreen = useNavStore((s) => s.openOrder);
  const openPay = useNavStore((s) => s.openPay);
  const notify = useUiStore((s) => s.notify);
  const sound = useSoundStore((s) => s.enabled);
  const setSound = useSoundStore((s) => s.setEnabled);
  const now = useNow(1000);

  const snapshot = floor.data?.snapshot;
  const receivedAt = floor.data?.receivedAt ?? now;
  const [areaId, setAreaId] = useState<string | null>(null);
  const area = snapshot?.areas.find((a) => a.id === areaId) ?? snapshot?.areas[0] ?? null;
  const tables = useMemo(() => (snapshot?.tables ?? []).filter((t) => t.area_id === area?.id), [snapshot, area]);

  const [seating, setSeating] = useState<FloorTable | null>(null);
  const [opening, setOpening] = useState(false);
  const [rejecting, setRejecting] = useState<GuestRound | null>(null);
  // One order id per pax sheet: a second tap after a timeout replays the same open instead of a duplicate (design 4.2 envelope).
  const seatingOrderId = useRef(idempotencyKey());

  // A new QR order or table request plays the soft tone when sound is on (design 7.9).
  const waitingIds = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = new Set([...(rounds.data ?? []).map((r) => `r:${r.id}`), ...(requests.data ?? []).map((r) => `q:${r.id}`)]);
    if (waitingIds.current && sound && [...ids].some((id) => !waitingIds.current!.has(id))) tone("new");
    waitingIds.current = ids;
  }, [rounds.data, requests.data, sound]);

  const seat = async (table: FloorTable, pax: number) => {
    setOpening(true);
    try {
      const orderId = seatingOrderId.current;
      const res = await openOrder(api, { order_id: orderId, order_type: "dine_in", table_id: table.id, pax }, { key: orderId });
      seatingOrderId.current = idempotencyKey();
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

  const collect = async (o: NonNullable<typeof snapshot>["other_orders"][number]) => {
    const res = await nowActions.collect(o);
    if (res && !res.paid) {
      const open = res.order.checks.find((c) => c.status === "open");
      notify({ text: `${o.order_no} still has ${res.order.balance > 0 ? "a balance" : "an open bill"}`, remedy: "Take the payment, then it is collected.", tone: "info" }, 5000);
      if (open) openPay(o.id, open.id, "order");
      else openOrderScreen(o.id, "orders");
    }
  };

  const nowItems: NowItem[] = useMemo(() => {
    if (!snapshot) return [];
    const items: (NowItem & { at: number })[] = [];
    const busy = nowActions.busy;
    const seenRoundOrders = new Set<string>();
    for (const r of rounds.data ?? []) {
      seenRoundOrders.add(r.order_id);
      items.push({
        id: `round:${r.id}`,
        at: new Date(r.submitted_at).getTime(),
        title: `Table ${r.table_name ?? "?"} · QR order`,
        detail: `${r.lines.length} ${r.lines.length === 1 ? "item" : "items"} · ${formatClock(r.submitted_at)}${r.guest_name ? ` · ${r.guest_name}` : ""}`,
        lines: r.lines.slice(0, 4).map((l) => `${l.quantity} ${l.name}${l.modifiers.length ? ` · ${l.modifiers.join(", ")}` : ""}`).concat(r.lines.length > 4 ? [`+${r.lines.length - 4} more`] : []),
        actions: [
          { id: "accept", label: "Accept", variant: "primary", onPress: () => void nowActions.acceptRound(r.id), isDisabled: offline || busy !== null, isPending: busy === r.id },
          { id: "view", label: "View", onPress: () => openOrderScreen(r.order_id, "floor") },
          { id: "reject", label: "Reject", variant: "quiet", onPress: () => setRejecting(r), isDisabled: offline || busy !== null },
        ],
      });
    }
    // Before the rounds list has loaded, the floor snapshot's counts stand in.
    if (!rounds.data) {
      for (const t of snapshot.tables) if (t.order && t.order.pending_rounds > 0 && !seenRoundOrders.has(t.order.id)) items.push({ id: `qr:${t.id}`, at: 0, title: `Table ${t.name} · QR order`, detail: `${t.order.pending_rounds} waiting to be accepted`, actions: [{ id: "view", label: "View", onPress: () => openOrderScreen(t.order!.id, "floor") }] });
    }
    for (const q of requests.data ?? []) {
      items.push({
        id: `req:${q.id}`,
        at: new Date(q.created_at).getTime(),
        title: `Table ${q.table_name ?? "?"} · ${requestLabel(q.type)}`,
        detail: `${formatClock(q.created_at)}${q.guest_name ? ` · ${q.guest_name}` : ""} · table request`,
        actions: [
          { id: "done", label: "Done", variant: "primary", onPress: () => void nowActions.acknowledge(q.id), isDisabled: offline || busy !== null, isPending: busy === q.id },
          ...(q.order_id ? [{ id: "view", label: "View", onPress: () => openOrderScreen(q.order_id!, "floor") }] : []),
        ],
      });
    }
    if (!requests.data) {
      for (const t of snapshot.tables) if (t.requests_waiting > 0) items.push({ id: `reqs:${t.id}`, at: 0, title: `Table ${t.name} · ${t.requests_waiting} ${t.requests_waiting === 1 ? "request" : "requests"}`, detail: "Table request", actions: t.order ? [{ id: "view", label: "View", onPress: () => openOrderScreen(t.order!.id, "floor") }] : [] });
    }
    for (const o of snapshot.other_orders) {
      if (o.status === "ready") {
        items.push({
          id: `ready:${o.id}`,
          at: o.ready_by ? new Date(o.ready_by).getTime() : 1,
          title: `${o.order_no} · Ready${o.customer_ref?.name ? ` · ${o.customer_ref.name}` : ""}`,
          detail: o.ready_by ? `Ready by ${formatClock(o.ready_by)}` : "Pickup ready",
          actions: [
            { id: "collected", label: "Collected", variant: "primary", onPress: () => void collect(o), isDisabled: offline || busy !== null, isPending: busy === o.id },
            { id: "view", label: "View", onPress: () => openOrderScreen(o.id, "orders") },
          ],
        });
      }
    }
    return items.sort((a, b) => a.at - b.at).map(({ at: _at, ...it }) => it);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, rounds.data, requests.data, nowActions, offline, openOrderScreen]);

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
            <>
              <Button size="lg" variant="secondary" onPress={newTakeaway} isDisabled={offline || opening} isPending={opening}>
                {offline ? "Offline" : "+ Takeaway order"}
              </Button>
              <Button
                size="md"
                variant="quiet"
                onPress={() => {
                  const next = !sound;
                  setSound(next);
                  if (next) tone("new");
                }}
                aria-pressed={sound}
                className="text-ink-2"
              >
                {sound ? "Sound on · tap to turn off" : "Sound off · tap to turn on"}
              </Button>
            </>
          }
        />
      </div>

      <Sheet
        isOpen={Boolean(seating)}
        onOpenChange={(o) => {
          if (o) return;
          setSeating(null);
          seatingOrderId.current = idempotencyKey();
        }}
        title={seating ? `Table ${seating.name}` : ""}
        description="How many guests?"
        isDismissable={!opening}
      >
        {seating ? <PaxPicker suggested={seating.seats} isPending={opening} onPick={(pax) => void seat(seating, pax)} /> : null}
      </Sheet>
      <RejectRoundSheet isOpen={Boolean(rejecting)} roundLabel={rejecting ? `Table ${rejecting.table_name ?? ""} · ${rejecting.lines.length} ${rejecting.lines.length === 1 ? "item" : "items"}` : null} onClose={() => setRejecting(null)} onReject={(reason) => (rejecting ? nowActions.rejectRound(rejecting.id, reason) : Promise.resolve(null))} />
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
