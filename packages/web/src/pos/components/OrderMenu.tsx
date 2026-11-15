"use client";

import { Button, Icon, Menu, MenuItem, MenuSeparator, MenuTrigger, ReasonPicker, Sheet, TableShape, TextField, useLocale } from "@sail/ui";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { req } from "@/lib/api";
import { findCustomers } from "../api/register";
import type { Customer, OrderSnapshot, OrderType } from "../api/types";
import { useFloor } from "../hooks/queries";
import { useApi } from "../hooks/useApi";
import type { useOrderActions } from "../hooks/useOrderActions";
import { ORDER_TYPE_LABEL, todayAt } from "../lib/format";
import { useNavStore } from "../state/nav";
import { usePos } from "./PosContext";

type Open = "type" | "move" | "customer" | "cancel" | "invoice" | null;
/** Sheets the order screen owns (they need its sheet state): Refund, Reopen, Reprint. */
export type OrderMenuAction = "refund" | "reopen" | "reprint";

const CANCEL_REASONS = ["Customer changed mind", "Opened by mistake", "Duplicate order", "Walked out"];

/** The order menu: Change type · Move table · Customer · Refund · Reopen · Get invoice · Reprint ticket · Cancel. */
export function OrderMenu({ order, actions, onOpen }: { order: OrderSnapshot; actions: ReturnType<typeof useOrderActions>; onOpen: (action: OrderMenuAction) => void }) {
  const { offline } = usePos();
  const [open, setOpen] = useState<Open>(null);
  const closed = order.status === "completed";
  const paidChecks = order.checks.filter((c) => c.paid_total > 0);
  const sentLines = order.lines.some((l) => l.status === "fired");
  const frozen = order.pricing_status === "frozen";
  const onAction = (k: React.Key) => {
    if (k === "refund" || k === "reopen" || k === "reprint") return onOpen(k);
    if (k === "invoice") {
      if (paidChecks.length === 1) return void actions.issueInvoice(paidChecks[0]!.id);
      return setOpen("invoice");
    }
    setOpen(k as Open);
  };
  return (
    <>
      <MenuTrigger>
        <Button variant="quiet" size="lg" isDisabled={offline} className="gap-1 px-3">
          Order
          <Icon icon={ChevronDown} size={16} className="text-ink-2" />
        </Button>
        <Menu minWidth={260} onAction={onAction}>
          <MenuItem id="type" isDisabled={closed || frozen} detail={frozen && !closed ? "Paid" : undefined}>
            Change type
          </MenuItem>
          <MenuItem id="move" isDisabled={order.order_type !== "dine_in" || closed}>
            Move table
          </MenuItem>
          <MenuItem id="customer" isDisabled={closed}>
            Customer
          </MenuItem>
          <MenuSeparator />
          <MenuItem id="refund" isDisabled={paidChecks.length === 0} detail={paidChecks.length === 0 ? "Nothing paid" : "Manager"}>
            Refund
          </MenuItem>
          <MenuItem id="reopen" isDisabled={!closed} detail={closed ? "Manager" : undefined}>
            Reopen
          </MenuItem>
          <MenuItem id="invoice" isDisabled={paidChecks.length === 0} detail={paidChecks.length === 1 && paidChecks[0]!.invoice_no ? paidChecks[0]!.invoice_no : undefined}>
            Get invoice
          </MenuItem>
          <MenuItem id="reprint" isDisabled={order.round_count === 0}>
            Reprint ticket
          </MenuItem>
          <MenuSeparator />
          {/* The register refuses a cancel with sent items or a payment; the item says so instead of offering it (live-test B-F13). */}
          <MenuItem id="cancel" tone="destructive" isDisabled={closed || sentLines || order.paid_total > 0} detail={!closed && sentLines ? "Void sent items first" : !closed && order.paid_total > 0 ? "A payment is on it" : undefined}>
            Cancel order
          </MenuItem>
        </Menu>
      </MenuTrigger>
      <ChangeTypeSheet isOpen={open === "type"} onClose={() => setOpen(null)} order={order} actions={actions} />
      <MoveTableSheet isOpen={open === "move"} onClose={() => setOpen(null)} order={order} actions={actions} />
      <CustomerSheet isOpen={open === "customer"} onClose={() => setOpen(null)} order={order} actions={actions} />
      <CancelSheet isOpen={open === "cancel"} onClose={() => setOpen(null)} actions={actions} />
      <Sheet labelledClose isOpen={open === "invoice"} onOpenChange={(o) => (!o ? setOpen(null) : undefined)} title="Get invoice" description="Which bill is the invoice for?">
        <div className="flex flex-col gap-2">
          {paidChecks.map((c) => (
            <Button
              key={c.id}
              size="lg"
              variant="secondary"
              isDisabled={offline}
              onPress={() => {
                setOpen(null);
                void actions.issueInvoice(c.id);
              }}
              className="justify-between"
            >
              <span>{c.label}{c.seat_no != null ? ` · Seat ${c.seat_no}` : ""}</span>
              <span className="text-caption text-ink-2">{c.invoice_no ? `Invoice ${c.invoice_no}` : c.payments.filter((p) => p.status === "recorded").map((p) => p.tender).join(", ")}</span>
            </Button>
          ))}
        </div>
      </Sheet>
    </>
  );
}

type SheetProps = { isOpen: boolean; onClose: () => void; order: OrderSnapshot; actions: ReturnType<typeof useOrderActions> };

/** Change type: pick the type; the fields the new type needs appear before the button. */
function ChangeTypeSheet({ isOpen, onClose, order, actions }: SheetProps) {
  const { floor } = usePos();
  const [type, setType] = useState<OrderType>(order.order_type);
  const [name, setName] = useState(order.customer_ref?.name ?? "");
  const [mobile, setMobile] = useState(order.customer_ref?.mobile ?? "");
  const [address, setAddress] = useState(order.delivery_address ?? "");
  const [readyBy, setReadyBy] = useState("");
  const [tableId, setTableId] = useState<string | null>(order.table_id);
  const [pax, setPax] = useState(String(order.pax ?? ""));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (isOpen) {
      setType(order.order_type);
      setName(order.customer_ref?.name ?? "");
      setMobile(order.customer_ref?.mobile ?? "");
      setAddress(order.delivery_address ?? "");
      setReadyBy("");
      setTableId(order.table_id);
      setPax(String(order.pax ?? ""));
    }
  }, [isOpen, order]);

  const freeTables = (floor?.tables ?? []).filter((t) => t.status === "free" || t.id === order.table_id);
  const needsCustomer = type === "pickup" || type === "delivery";
  const { timeZone } = useLocale();
  const ready = readyBy ? todayAt(readyBy, timeZone) : null;
  // The same type keeps the sheet useful for its details: an open takeaway can be given a name (C-12).
  const sameType = type === order.order_type;
  const detailsChanged = sameType && type !== "dine_in" && (name.trim() !== (order.customer_ref?.name ?? "") || mobile.trim() !== (order.customer_ref?.mobile ?? "") || (type === "delivery" && address.trim() !== (order.delivery_address ?? "")));
  const valid =
    (!sameType || detailsChanged) &&
    (type !== "dine_in" || tableId) &&
    (!needsCustomer || name.trim() || mobile.trim()) &&
    (type !== "delivery" || address.trim()) &&
    (!readyBy || ready);

  const submit = async () => {
    setBusy(true);
    if (sameType) {
      const snap = await actions.updateDetails({ customer_ref: { ...(name.trim() ? { name: name.trim() } : {}), ...(mobile.trim() ? { mobile: mobile.trim() } : {}) }, ...(type === "delivery" ? { delivery_address: address.trim() } : {}) });
      setBusy(false);
      if (snap) onClose();
      return;
    }
    const snap = await actions.changeType({
      order_type: type,
      table_id: type === "dine_in" ? tableId : null,
      pax: type === "dine_in" && pax ? Number(pax) : type === "dine_in" ? (order.pax ?? 1) : null,
      customer_ref: needsCustomer ? { ...(name.trim() ? { name: name.trim() } : {}), ...(mobile.trim() ? { mobile: mobile.trim() } : {}) } : type === "takeaway" && name.trim() ? { name: name.trim() } : null,
      delivery_address: type === "delivery" ? address.trim() : null,
      ready_by: needsCustomer && ready ? ready : null,
    });
    setBusy(false);
    if (snap) onClose();
  };

  return (
    <Sheet labelledClose
      isOpen={isOpen}
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title="Change type"
      description={`Now ${ORDER_TYPE_LABEL[order.order_type]}. Prices follow the new type; blocked after the first payment.`}
      isDismissable={!busy}
      footer={
        <Button variant="primary" size="lg" isDisabled={!valid || busy} isPending={busy} onPress={submit}>
          {sameType ? "Save details" : `Change to ${ORDER_TYPE_LABEL[type]}`}
        </Button>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-2 gap-2" role="group" aria-label="Order type">
          {(["dine_in", "takeaway", "pickup", "delivery"] as OrderType[]).map((t) => (
            <Button key={t} size="lg" variant={t === type ? "primary" : "secondary"} onPress={() => setType(t)} aria-pressed={t === type} className="min-h-16">
              {ORDER_TYPE_LABEL[t]}
            </Button>
          ))}
        </div>
        {type === "dine_in" ? (
          <section>
            <h3 className="mb-2 text-line text-ink">Table</h3>
            <div className="flex flex-wrap gap-2">
              {freeTables.map((t) => (
                <Button key={t.id} size="lg" variant={t.id === tableId ? "primary" : "secondary"} onPress={() => setTableId(t.id)} className="min-w-14">
                  {t.name}
                </Button>
              ))}
              {freeTables.length === 0 ? <p className="text-body text-ink-2">No free tables.</p> : null}
            </div>
            <TextField label="Guests" value={pax} onChange={setPax} inputMode="numeric" inputClassName="min-h-14 text-line tabular" className="mt-3 max-w-[160px]" />
          </section>
        ) : null}
        {type !== "dine_in" ? <TextField label={type === "takeaway" ? "Name (optional)" : "Customer name"} value={name} onChange={setName} inputClassName="min-h-14 text-line" maxLength={80} /> : null}
        {needsCustomer ? <TextField label="Mobile" value={mobile} onChange={setMobile} type="tel" inputClassName="min-h-14 text-line tabular" maxLength={30} /> : null}
        {needsCustomer ? <TextField label="Ready by (HH:MM, optional)" value={readyBy} onChange={setReadyBy} placeholder="19:30" inputClassName="min-h-14 text-line tabular" isInvalid={Boolean(readyBy && !ready)} errorMessage={readyBy && !ready ? "Use HH:MM, for example 19:30" : undefined} /> : null}
        {type === "delivery" ? <TextField label="Delivery address" value={address} onChange={setAddress} multiline rows={2} inputClassName="text-line" maxLength={400} /> : null}
      </div>
    </Sheet>
  );
}

/** Move table: tap the target; free tables are highlighted, the rest are disabled. */
function MoveTableSheet({ isOpen, onClose, order, actions }: SheetProps) {
  const { station } = usePos();
  const floor = useFloor(station.outlet_id);
  const [busy, setBusy] = useState<string | null>(null);
  const snapshot = floor.data?.snapshot;
  const move = async (tableId: string) => {
    setBusy(tableId);
    const snap = await actions.moveTable(tableId);
    setBusy(null);
    if (snap) onClose();
  };
  return (
    <Sheet labelledClose isOpen={isOpen} onOpenChange={(o) => (!o ? onClose() : undefined)} title="Move table" description="Tap the table to move this order to. Free tables are highlighted." width="lg" isDismissable={!busy}>
      <div className="flex flex-col gap-6">
        {(snapshot?.areas ?? []).map((a) => {
          const tables = (snapshot?.tables ?? []).filter((t) => t.area_id === a.id);
          const rows = Math.max(2, ...tables.map((t) => t.y + t.h));
          const cell = 48;
          const gap = 8;
          return (
            <section key={a.id}>
              <h3 className="mb-2 text-line text-ink">{a.name}</h3>
              <div className="relative overflow-x-auto" style={{ height: rows * cell + (rows - 1) * gap }}>
                {tables.map((t) => {
                  const free = t.status === "free";
                  return (
                    <TableShape
                      key={t.id}
                      name={t.name}
                      shape={t.shape}
                      status={t.status}
                      pax={t.order?.pax ?? null}
                      highlight={free}
                      isDisabled={!free || t.id === order.table_id || Boolean(busy)}
                      onPress={() => void move(t.id)}
                      style={{ left: t.x * (cell + gap), top: t.y * (cell + gap), width: t.w * cell + (t.w - 1) * gap, height: t.h * cell + (t.h - 1) * gap }}
                    />
                  );
                })}
              </div>
            </section>
          );
        })}
        {!snapshot ? <p className="text-body text-ink-2">Loading the floor…</p> : null}
      </div>
    </Sheet>
  );
}

/** Customer: type a mobile number, tap the match; Remove detaches. */
function CustomerSheet({ isOpen, onClose, order, actions }: SheetProps) {
  const api = useApi();
  const [mobile, setMobile] = useState("");
  const [busy, setBusy] = useState(false);
  const digits = mobile.replace(/\s+/g, "");
  const search = useQuery({ queryKey: ["pos", "customers", digits], queryFn: () => findCustomers(api, digits), enabled: isOpen && digits.length >= 3, staleTime: 30_000 });
  const current = useQuery({
    queryKey: ["pos", "customer", order.customer_id],
    queryFn: async () => (await req(api.GET("/v1/customers/{id}", { params: { path: { id: order.customer_id! } } }))).data as unknown as Customer,
    enabled: isOpen && Boolean(order.customer_id),
    staleTime: 60_000,
  });
  useEffect(() => {
    if (!isOpen) setMobile("");
  }, [isOpen]);

  const attach = async (id: string) => {
    setBusy(true);
    const snap = await actions.attachCustomer(id);
    setBusy(false);
    if (snap) onClose();
  };
  const detach = async () => {
    setBusy(true);
    const snap = await actions.detachCustomer();
    setBusy(false);
    if (snap) onClose();
  };

  return (
    <Sheet labelledClose isOpen={isOpen} onOpenChange={(o) => (!o ? onClose() : undefined)} title="Customer" description="Customer-group discounts apply once a customer is attached." isDismissable={!busy}>
      <div className="flex flex-col gap-5">
        {order.customer_id ? (
          <div className="flex items-center justify-between gap-3 rounded-tile bg-surface-2 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-line text-ink">{current.data?.name ?? "Attached customer"}</p>
              <p className="text-caption text-ink-2 tabular">{current.data?.mobile ?? ""}</p>
            </div>
            <Button variant="destructive" size="lg" isDisabled={busy} onPress={detach}>
              Remove customer
            </Button>
          </div>
        ) : null}
        <TextField label="Mobile number" value={mobile} onChange={setMobile} type="tel" placeholder="+ country code and number" autoFocus inputClassName="min-h-14 text-line tabular" />
        {digits.length >= 3 ? (
          search.data?.length ? (
            <ul className="flex flex-col gap-2">
              {search.data.map((c) => (
                <li key={c.id}>
                  <Button size="lg" variant="secondary" isDisabled={busy} onPress={() => void attach(c.id)} className="w-full justify-between">
                    <span>{c.name}</span>
                    <span className="text-caption text-ink-2 tabular">{c.mobile}</span>
                  </Button>
                </li>
              ))}
            </ul>
          ) : search.isFetched ? (
            <p className="text-body text-ink-2">No customer with that number. Customers are added in the back office or on a pickup order.</p>
          ) : null
        ) : (
          <p className="text-body text-ink-2">Type at least 3 digits.</p>
        )}
      </div>
    </Sheet>
  );
}

/** Cancel (T2, reason required): nothing sent and nothing paid; otherwise the register says what to do first. */
function CancelSheet({ isOpen, onClose, actions }: { isOpen: boolean; onClose: () => void; actions: ReturnType<typeof useOrderActions> }) {
  const [busy, setBusy] = useState(false);
  const back = useNavStore((s) => s.back);
  const cancel = async (reason: string) => {
    setBusy(true);
    const snap = await actions.cancel(reason);
    setBusy(false);
    if (snap) {
      onClose();
      back();
    }
  };
  return (
    <Sheet labelledClose isOpen={isOpen} onOpenChange={(o) => (!o ? onClose() : undefined)} title="Cancel order" description="Why is the order being cancelled?" isDismissable={!busy}>
      <ReasonPicker reasons={CANCEL_REASONS.map((r) => ({ id: r, name: r }))} onPick={(r) => void cancel(r.text)} isDisabled={busy} />
    </Sheet>
  );
}
