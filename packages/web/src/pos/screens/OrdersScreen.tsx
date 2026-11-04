"use client";

import { Badge, Button, EmptyState, Menu, MenuItem, MenuTrigger, Money, Sheet, Skeleton, TextField, type BadgeTone } from "@sail/ui";
import { useMemo, useState } from "react";
import { Button as AriaButton } from "react-aria-components";
import { idempotencyKey, toApiError } from "@/lib/api";
import { markReady, openOrder, type OpenOrderInput } from "../api/register";
import type { OrderSnapshot, OrderType } from "../api/types";
import { Frame } from "../components/Frame";
import { usePos } from "../components/PosContext";
import { useApplySnapshot, useOpenOrders } from "../hooks/queries";
import { useApi } from "../hooks/useApi";
import { formatClock, ORDER_STATUS_LABEL, ORDER_TYPE_LABEL, todayAt } from "../lib/format";
import { useNavStore } from "../state/nav";
import { useUiStore } from "../state/ui";

const STATUS_TONE: Record<string, BadgeTone> = { open: "seated", fired: "sent", ready: "paid", out_for_delivery: "bill" };

/** Orders (design 3.1): takeaway, pickup and delivery, sorted by ready-by, with + New order and Ready. */
export function OrdersScreen() {
  const api = useApi();
  const { outlet, station, offline } = usePos();
  const orders = useOpenOrders(station.outlet_id);
  const applySnapshot = useApplySnapshot();
  const openOrderScreen = useNavStore((s) => s.openOrder);
  const notify = useUiStore((s) => s.notify);
  const [creating, setCreating] = useState<OrderType | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const list = useMemo(() => (orders.data ?? []).filter((o) => o.order_type !== "dine_in"), [orders.data]);

  const ready = async (o: OrderSnapshot) => {
    setBusy(o.id);
    try {
      const res = await markReady(api, o.id, { expectedVersion: o.version });
      applySnapshot(res.data);
    } catch (e) {
      const err = toApiError(e);
      notify({ text: err.message, remedy: err.remedy ?? null, tone: "alert" }, 8000);
      void orders.refetch();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Frame
      title={`${outlet?.name ?? ""} · Orders`}
      right={
        <MenuTrigger>
          <Button variant="primary" size="lg" isDisabled={offline}>
            {offline ? "Offline" : "+ New order"}
          </Button>
          <Menu minWidth={220} onAction={(k) => setCreating(k as OrderType)}>
            <MenuItem id="takeaway">Takeaway</MenuItem>
            <MenuItem id="pickup">Pickup</MenuItem>
            <MenuItem id="delivery">Delivery</MenuItem>
          </Menu>
        </MenuTrigger>
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {orders.isLoading && !orders.data ? <Skeleton lines={4} /> : null}
        {orders.data && list.length === 0 ? <EmptyState title="No open orders" hint="Tap + New order to start a takeaway, pickup or delivery." /> : null}
        <ul className="flex flex-col gap-2">
          {list.map((o) => (
            <li key={o.id}>
              <div className="flex items-stretch gap-2">
                <AriaButton
                  onPress={() => openOrderScreen(o.id, "orders")}
                  className="press pos-touch flex min-h-16 flex-1 items-center gap-4 rounded-tile bg-surface px-4 text-left outline-none hairline data-[pressed]:bg-surface-2 data-[hovered]:bg-surface-2 data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-status-seated"
                  aria-label={`${ORDER_TYPE_LABEL[o.order_type]} ${o.order_no}${o.customer_ref?.name ? `, ${o.customer_ref.name}` : ""}, ${ORDER_STATUS_LABEL[o.status]}`}
                >
                  <span className="w-24 shrink-0 font-mono text-body text-ink-2">{o.order_no}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-line text-ink">
                      {ORDER_TYPE_LABEL[o.order_type]}
                      {o.customer_ref?.name ? ` · ${o.customer_ref.name}` : ""}
                      {o.customer_ref?.mobile ? <span className="text-ink-2"> · {o.customer_ref.mobile}</span> : null}
                    </span>
                    <span className="block truncate text-caption text-ink-2">
                      {o.ready_by ? `Ready by ${formatClock(o.ready_by)}` : `Opened ${formatClock(o.opened_at)}`}
                      {o.delivery_address ? ` · ${o.delivery_address}` : ""}
                      {` · ${o.lines.filter((l) => l.status !== "voided").length} items`}
                    </span>
                  </span>
                  <Badge tone={STATUS_TONE[o.status] ?? "neutral"}>{ORDER_STATUS_LABEL[o.status]}</Badge>
                  <Money cents={o.totals.total} size="line" className="w-24 text-right" />
                </AriaButton>
                {o.status === "fired" ? (
                  <Button size="lg" variant="secondary" isDisabled={offline || busy === o.id} isPending={busy === o.id} onPress={() => void ready(o)} className="min-h-16">
                    {offline ? "Offline" : "Ready"}
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </div>
      <NewOrderSheet
        type={creating}
        onClose={() => setCreating(null)}
        onCreate={async (input) => {
          const res = await openOrder(api, input);
          applySnapshot(res.data);
          setCreating(null);
          openOrderScreen(res.data.id, "orders");
        }}
      />
    </Frame>
  );
}

/** + New order (design 4.12): Takeaway (optional name), Pickup (name, mobile, ready-by), Delivery (plus address and notes). */
export function NewOrderSheet({ type, onClose, onCreate }: { type: OrderType | null; onClose: () => void; onCreate: (input: OpenOrderInput) => Promise<void> }) {
  const [name, setName] = useState("");
  const [mobile, setMobile] = useState("");
  const [readyBy, setReadyBy] = useState("");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const reset = () => {
    setName("");
    setMobile("");
    setReadyBy("");
    setAddress("");
    setNotes("");
    setError(null);
  };
  const close = () => {
    reset();
    onClose();
  };

  const needsCustomer = type === "pickup" || type === "delivery";
  const ready = readyBy ? todayAt(readyBy) : null;
  const valid = type === "takeaway" || (needsCustomer && (name.trim() || mobile.trim()) && (!readyBy || ready) && (type !== "delivery" || address.trim()));

  const submit = async () => {
    if (!type || !valid) return;
    setPending(true);
    setError(null);
    const input: OpenOrderInput = { order_id: idempotencyKey(), order_type: type };
    if (type === "takeaway" && name.trim()) input.takeaway_ref = name.trim();
    if (needsCustomer) {
      input.customer_ref = { ...(name.trim() ? { name: name.trim() } : {}), ...(mobile.trim() ? { mobile: mobile.trim() } : {}) };
      if (ready) input.ready_by = ready;
    }
    if (type === "delivery") {
      input.delivery_address = address.trim();
      if (notes.trim()) input.delivery_notes = notes.trim();
    }
    try {
      await onCreate(input);
      reset();
    } catch (e) {
      const err = toApiError(e);
      setError(err.remedy ? `${err.message}. ${err.remedy}` : err.message);
    } finally {
      setPending(false);
    }
  };

  const title = type ? `New ${ORDER_TYPE_LABEL[type].toLowerCase()} order` : "";
  return (
    <Sheet
      isOpen={Boolean(type)}
      onOpenChange={(o) => (!o ? close() : undefined)}
      title={title}
      isDismissable={!pending}
      footer={
        <Button variant="primary" size="lg" isDisabled={!valid} isPending={pending} onPress={submit}>
          {type ? `Open ${ORDER_TYPE_LABEL[type].toLowerCase()} order` : "Open order"}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <TextField label={type === "takeaway" ? "Name (optional)" : "Customer name"} value={name} onChange={setName} inputClassName="min-h-14 text-line" maxLength={80} autoFocus />
        {needsCustomer ? <TextField label="Mobile" value={mobile} onChange={setMobile} type="tel" inputClassName="min-h-14 text-line tabular" maxLength={30} /> : null}
        {needsCustomer ? <TextField label="Ready by (HH:MM, optional)" value={readyBy} onChange={setReadyBy} placeholder="19:30" inputClassName="min-h-14 text-line tabular" errorMessage={readyBy && !ready ? "Use HH:MM, for example 19:30" : undefined} isInvalid={Boolean(readyBy && !ready)} /> : null}
        {type === "delivery" ? <TextField label="Delivery address" value={address} onChange={setAddress} multiline rows={2} inputClassName="text-line" maxLength={400} /> : null}
        {type === "delivery" ? <TextField label="Delivery notes (optional)" value={notes} onChange={setNotes} inputClassName="min-h-14 text-line" maxLength={400} /> : null}
        {error ? (
          <p role="alert" className="text-body text-status-alert">
            {error}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
