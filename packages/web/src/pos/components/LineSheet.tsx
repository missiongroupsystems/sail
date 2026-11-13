"use client";

import { Button, Money, QuantityStepper, ReasonPicker, Sheet, sortTaxes, TextField } from "@sail/ui";
import { Fragment, useEffect, useState } from "react";
import type { OrderSnapshot, SnapshotLine } from "../api/types";
import { useVoidReasons } from "../hooks/queries";
import type { useOrderActions } from "../hooks/useOrderActions";
import { ModifierPicker, QUICK_NOTES, selectionFromLine, toModifiers, unmetRequirement, type Selection } from "./ModifierPicker";
import { usePos } from "./PosContext";
import { GREY_PILL } from "./styles";

export type LineSheetProps = {
  order: OrderSnapshot;
  line: SnapshotLine | null;
  onClose: () => void;
  actions: ReturnType<typeof useOrderActions>;
};

/**
 * The line sheet: quantity, quick notes, seat, hold, and Remove
 * (before sending) or Void (after sending, which needs manager approval).
 */
export function LineSheet({ order, line, onClose, actions }: LineSheetProps) {
  const { menu, station, offline } = usePos();
  const reasons = useVoidReasons();
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState("");
  const [seat, setSeat] = useState<number | null>(null);
  const [selection, setSelection] = useState<Selection>({});
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!line) return;
    setQuantity(line.quantity);
    setNotes(line.notes ?? "");
    setSeat(line.seat_no);
    setSelection(selectionFromLine(line));
    setRemoving(false);
  }, [line]);

  if (!line) return <Sheet labelledClose isOpen={false} onOpenChange={() => undefined} title="" children={null} />;

  const sent = line.status === "fired";
  const product = menu?.products[line.product_id];
  const canEditModifiers = !sent && menu && product && product.modifier_groups.length > 0;
  const unmet = canEditModifiers ? unmetRequirement(menu, product, selection) : null;
  const seats = Math.max(order.pax ?? 0, ...order.lines.map((l) => l.seat_no ?? 0), seat ?? 0, 1);

  const changed = quantity !== line.quantity || (notes.trim() || null) !== (line.notes ?? null) || seat !== line.seat_no || (canEditModifiers && JSON.stringify(toModifiers(menu, product, selection).map((m) => m.product_id)) !== JSON.stringify(line.modifiers.map((m) => m.product_id)));

  const save = async () => {
    setBusy(true);
    const patch: Parameters<typeof actions.patchLine>[1] = {};
    if (quantity !== line.quantity) patch.quantity = quantity;
    if ((notes.trim() || null) !== (line.notes ?? null)) patch.notes = notes.trim() || null;
    if (seat !== line.seat_no) patch.seat_no = seat;
    if (canEditModifiers) patch.modifiers = toModifiers(menu, product, selection).map((m) => ({ group_id: m.group_id, product_id: m.product_id, quantity: 1 }));
    const snap = await actions.patchLine(line.id, patch);
    setBusy(false);
    if (snap) onClose();
  };

  const toggleHold = async () => {
    setBusy(true);
    const toHeld = line.status !== "held";
    const snap = await actions.patchLine(line.id, { hold: toHeld }, toHeld ? `Held ${line.name}` : `Released ${line.name}`);
    setBusy(false);
    if (snap) onClose();
  };

  const remove = async (reason: { id?: string; text: string }) => {
    setBusy(true);
    const snap = await actions.removeLine(line, reason, quantity < line.quantity ? quantity : undefined);
    setBusy(false);
    if (snap) onClose();
  };

  const addNote = (chip: string) => setNotes((n) => (n.split(", ").includes(chip) ? n : n ? `${n}, ${chip}` : chip));

  return (
    <Sheet labelledClose
      isOpen
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={line.name}
      description={
        <span className="inline-flex items-center gap-2">
          Order {order.order_no}
        </span>
      }
      isDismissable={!busy}
      footer={
        removing ? (
          <>
            <span className="mr-auto text-body text-ink-2">{offline ? "Offline" : sent ? `Sent · round ${line.fire_round}. Tap a reason to void it.` : "Not sent yet. Tap a reason to remove it."}</span>
            <Button variant="quiet" size="lg" onPress={() => setRemoving(false)} isDisabled={busy} className={GREY_PILL}>
              Keep the line
            </Button>
          </>
        ) : (
          <>
            <span className="mr-auto text-body text-ink-2">{offline ? "Offline" : sent ? `Sent · round ${line.fire_round}.` : line.status === "held" ? "Held." : "Not sent yet."}</span>
            {!offline ? (
              <Button variant="quiet" size="lg" isDisabled={busy} onPress={() => setRemoving(true)} className={GREY_PILL + (sent && !["manager", "finance", "admin"].includes(actions.role ?? "") ? " flex-col gap-0! py-1" : "")}>
                <span>{sent ? "Void item" : "Remove item"}</span>
                {sent && !["manager", "finance", "admin"].includes(actions.role ?? "") ? <span className="rounded-chip bg-status-bill-tint px-2 text-[12px] leading-[18px] text-status-bill">Manager approval</span> : null}
              </Button>
            ) : null}
            {!sent ? (
              <Button variant="secondary" size="lg" isDisabled={busy || offline} onPress={toggleHold}>
                {line.status === "held" ? "Release" : "Hold"}
              </Button>
            ) : null}
            {!sent ? (
              <Button variant="primary" size="lg" isDisabled={!changed || Boolean(unmet) || busy || offline} isPending={busy} onPress={save}>
                {unmet ?? "Save changes"}
              </Button>
            ) : null}
          </>
        )
      }
    >
      {removing ? (
        <div className="flex flex-col gap-4">
          {/* The line's figures first, then the reasons; one tap on a reason removes it. */}
          <LineTotal line={line} taxMode={order.totals.tax_mode} />
          <p className="text-line font-medium text-ink">{sent ? "Reason for voiding it" : "Reason for removing it"}</p>
          {quantity < line.quantity ? (
            <p className="text-body text-ink-2">
              {sent ? "Voiding" : "Removing"} {quantity} of {line.quantity}.
            </p>
          ) : null}
          <ReasonPicker reasons={(reasons.data ?? []).map((r) => ({ id: r.id, name: r.name }))} onPick={(r) => void remove(r)} isDisabled={busy} />
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          <section className="flex items-center justify-between gap-4">
            <h3 className="text-[16px] font-medium text-ink">Quantity</h3>
            <QuantityStepper value={quantity} onChange={setQuantity} min={1} max={sent ? line.quantity : 999} />
          </section>
          {sent ? <p className="text-body text-ink-2">A sent line cannot be changed. Lower the quantity to void part of it.</p> : null}
          <LineTotal line={line} taxMode={order.totals.tax_mode} />
          {station.seats_enabled && order.order_type === "dine_in" && !sent ? (
            <section>
              <h3 className="mb-2 text-[16px] font-medium text-ink">Seat</h3>
              <div className="flex flex-wrap gap-2">
                {[null, ...Array.from({ length: seats }, (_, i) => i + 1)].map((s) => (
                  <Button key={s ?? "shared"} size="lg" variant={s === seat ? "primary" : "quiet"} onPress={() => setSeat(s)} className={"min-w-14" + (s === seat ? "" : " " + GREY_PILL)}>
                    {s ?? "Shared"}
                  </Button>
                ))}
                <Button size="lg" variant="quiet" onPress={() => setSeat(seats + 1)} className="rounded-chip">
                  + Seat
                </Button>
              </div>
            </section>
          ) : null}
          {canEditModifiers ? (
            <section>
              <h3 className="mb-2 text-[16px] font-medium text-ink">Choices</h3>
              <ModifierPicker menu={menu} product={product} selection={selection} onChange={setSelection} />
            </section>
          ) : line.modifiers.length ? (
            <section>
              <h3 className="mb-1 text-[16px] font-medium text-ink">Choices</h3>
              <ul className="text-body text-ink-2">
                {line.modifiers.map((m) => (
                  <li key={m.modifier_id}>· {m.name}</li>
                ))}
              </ul>
            </section>
          ) : null}
          {!sent ? (
            <section>
              <h3 className="mb-2 text-[16px] font-medium text-ink">Notes</h3>
              <div className="mb-2 flex flex-wrap gap-2">
                {QUICK_NOTES.map((c) => (
                  <Button key={c} size="md" variant="quiet" onPress={() => addNote(c)} className={GREY_PILL + " text-[14.5px] font-normal"}>
                    {c}
                  </Button>
                ))}
              </div>
              <TextField aria-label="Note" value={notes} onChange={setNotes} placeholder="Note for the kitchen" inputClassName="min-h-14 text-line" maxLength={200} />
            </section>
          ) : line.notes ? (
            <p className="text-body text-ink-2 italic">{line.notes}</p>
          ) : null}
        </div>
      )}
    </Sheet>
  );
}

/** The line's figures as the register priced them, in a bordered card: the items, its share of discounts and fees, tax, and the line total. */
function LineTotal({ line, taxMode }: { line: SnapshotLine; taxMode: string }) {
  const a = line.amounts;
  const row = (label: string, cents: number, signed = false) => (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-[13.5px] text-ink-2">{label}</dt>
      <dd>
        <Money cents={cents} signed={signed} size="body" className="text-[13.5px] text-ink" />
      </dd>
    </div>
  );
  return (
    <dl className="flex flex-col gap-1 rounded-tile border border-rule px-4 py-3" aria-label="Line total">
      {row(`${line.quantity} × ${line.name}`, a.base)}
      {a.discount ? row("Discounts", -Math.abs(a.discount), true) : null}
      {a.fee ? row("Service and fees", a.fee) : null}
      {line.taxes.length ? sortTaxes(line.taxes).map((t, i) => <Fragment key={i}>{row(taxMode === "inclusive" ? `${t.name} (included)` : t.name, t.amount)}</Fragment>) : a.tax ? row(taxMode === "inclusive" ? "Tax (included)" : "Tax", a.tax) : null}
      <div className="mt-1.5 flex items-center justify-between gap-3 border-t border-rule pt-2.5">
        <dt className="text-[15px] font-semibold text-ink">Line total</dt>
        <dd>
          <Money cents={a.total} size="title" className="text-ink" />
        </dd>
      </div>
    </dl>
  );
}
