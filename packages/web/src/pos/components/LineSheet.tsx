"use client";

import { Button, Money, QuantityStepper, ReasonPicker, Sheet, TextField } from "@sail/ui";
import { useEffect, useState } from "react";
import type { OrderSnapshot, SnapshotLine } from "../api/types";
import { useVoidReasons } from "../hooks/queries";
import type { useOrderActions } from "../hooks/useOrderActions";
import { ModifierPicker, QUICK_NOTES, selectionFromLine, toModifiers, unmetRequirement, type Selection } from "./ModifierPicker";
import { usePos } from "./PosContext";

export type LineSheetProps = {
  order: OrderSnapshot;
  line: SnapshotLine | null;
  onClose: () => void;
  actions: ReturnType<typeof useOrderActions>;
};

/**
 * The line sheet (design 4.3): quantity, quick notes, seat, hold, and Remove
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

  if (!line) return <Sheet isOpen={false} onOpenChange={() => undefined} title="" children={null} />;

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
    <Sheet
      isOpen
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={line.name}
      description={
        <span className="inline-flex items-center gap-2">
          <Money cents={line.amounts.total} /> · {sent ? `Sent${line.fired_at ? "" : ""} · round ${line.fire_round}` : line.status === "held" ? "Held" : "Not sent yet"}
        </span>
      }
      isDismissable={!busy}
      footer={
        removing ? null : (
          <>
            {!offline ? (
              <Button variant="destructive" size="lg" isDisabled={busy} onPress={() => setRemoving(true)} className="mr-auto">
                {sent ? "Void" : "Remove"}
                {sent && !["manager", "finance", "admin"].includes(actions.role ?? "") ? <span className="ml-1 rounded-chip bg-[color-mix(in_srgb,var(--status-bill)_14%,transparent)] px-2 text-caption text-status-bill">Manager approval</span> : null}
              </Button>
            ) : (
              <span className="mr-auto text-caption text-ink-2">Offline</span>
            )}
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
          <p className="text-line text-ink">{sent ? "Why is it being voided?" : "Why is it being removed?"}</p>
          {quantity < line.quantity ? (
            <p className="text-body text-ink-2">
              {sent ? "Voiding" : "Removing"} {quantity} of {line.quantity}.
            </p>
          ) : null}
          <ReasonPicker reasons={(reasons.data ?? []).map((r) => ({ id: r.id, name: r.name }))} onPick={(r) => void remove(r)} isDisabled={busy} />
          <Button variant="quiet" size="lg" onPress={() => setRemoving(false)} isDisabled={busy}>
            Keep the line
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          <section className="flex items-center justify-between gap-4">
            <h3 className="text-line text-ink">Quantity</h3>
            <QuantityStepper value={quantity} onChange={setQuantity} min={1} max={sent ? line.quantity : 999} />
          </section>
          {sent ? <p className="text-body text-ink-2">A sent line cannot be changed. Lower the quantity to void part of it.</p> : null}
          {station.seats_enabled && order.order_type === "dine_in" && !sent ? (
            <section>
              <h3 className="mb-2 text-line text-ink">Seat</h3>
              <div className="flex flex-wrap gap-2">
                {[null, ...Array.from({ length: seats }, (_, i) => i + 1)].map((s) => (
                  <Button key={s ?? "shared"} size="lg" variant={s === seat ? "primary" : "secondary"} onPress={() => setSeat(s)} className="rounded-chip min-w-14">
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
              <h3 className="mb-2 text-line text-ink">Choices</h3>
              <ModifierPicker menu={menu} product={product} selection={selection} onChange={setSelection} />
            </section>
          ) : line.modifiers.length ? (
            <section>
              <h3 className="mb-1 text-line text-ink">Choices</h3>
              <ul className="text-body text-ink-2">
                {line.modifiers.map((m) => (
                  <li key={m.modifier_id}>· {m.name}</li>
                ))}
              </ul>
            </section>
          ) : null}
          {!sent ? (
            <section>
              <h3 className="mb-2 text-line text-ink">Notes</h3>
              <div className="mb-2 flex flex-wrap gap-2">
                {QUICK_NOTES.map((c) => (
                  <Button key={c} size="md" variant="secondary" onPress={() => addNote(c)} className="rounded-chip">
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
