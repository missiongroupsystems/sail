"use client";

import { BottomSheet, BrandButton, ChoiceGroup, GuestStepper, Money, TextField, type ChoiceValue, useLocale } from "@sail/ui";
import { useState } from "react";
import type { BasketItem } from "@/lib/basket";
import { childGroup, defaultSelection, ruleText, selectionFromModifiers, setGroupValue, toModifiers, topGroups, unmetRequirement, type Selection } from "@/lib/modifiers";
import type { CompiledGroup, CompiledMenu, CompiledProduct } from "@/lib/types";

export type ItemSheetProps = {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  menu: CompiledMenu;
  product: CompiledProduct;
  /** The basket item being changed, or null when adding. */
  editing: BasketItem | null;
  /** The register's message for a group on this item, from a failed send. */
  groupError?: string | null;
  onAdd: (item: Omit<BasketItem, "key">) => void;
  onUpdate: (key: string, item: Omit<BasketItem, "key">) => void;
};

const MAX_QTY = 50;

/**
 * The item sheet: required choices first, the same rules as the
 * POS modifier picker, nested choices inline under the option that opens them,
 * a note for the kitchen, a quantity stepper, and one "Add to order" button
 * that carries the menu price and stays disabled, with the reason, until every
 * minimum is met.
 */
export function ItemSheet({ isOpen, onOpenChange, menu, product, editing, groupError, onAdd, onUpdate }: ItemSheetProps) {
  const { money } = useLocale();
  // The parent keys this component per opening, so the initial state is the whole reset; a menu refetch while
  // the sheet is open leaves the guest's choices alone.
  const [selection, setSelection] = useState<Selection>(() => (editing ? selectionFromModifiers(editing.modifiers) : defaultSelection(menu, product)));
  const [quantity, setQuantity] = useState(editing?.quantity ?? 1);
  const [notes, setNotes] = useState(editing?.notes ?? "");
  const [showErrorFor, setShowErrorFor] = useState<string | null>(null);

  const groups = topGroups(menu, product);
  const unmet = unmetRequirement(menu, product, selection);
  const maxQty = product.cap_remaining != null ? Math.max(1, Math.min(MAX_QTY, product.cap_remaining)) : MAX_QTY;

  const setGroup = (g: CompiledGroup, value: ChoiceValue) => {
    setSelection((s) => setGroupValue(menu, s, g, value));
    setShowErrorFor(null);
  };

  const renderGroup = (g: CompiledGroup, parentLabel?: string) => {
    const value = selection[g.id] ?? [];
    const met = value.length >= g.min_select;
    const isTarget = (groupError && !showErrorFor && !met) || showErrorFor === g.id;
    // The id lets the Add button scroll to and focus an unmet group, nested ones included.
    return (
      <div key={g.id} id={`group-${g.id}`}>
        <ChoiceGroup
          name={g.name}
          rule={ruleText(g)}
          required={g.min_select > 0}
          met={met}
          mode={g.max_select === 1 && g.min_select >= 1 ? "single" : "multi"}
          maxSelect={g.max_select}
          maxPerOption={g.max_per_modifier}
          options={g.options.map((o) => ({ id: o.product_id, name: o.name, price: o.price }))}
          value={value}
          onChange={(v) => setGroup(g, v)}
          parentLabel={parentLabel}
          errorMessage={isTarget ? (showErrorFor === g.id ? unmet?.message : groupError) : null}
          renderUnder={(optionId) => {
            const child = childGroup(menu, g, optionId);
            if (!child) return null;
            const optionName = g.options.find((o) => o.product_id === optionId)?.name ?? "";
            return renderGroup(child, optionName);
          }}
        />
      </div>
    );
  };

  const commit = () => {
    if (unmet) {
      setShowErrorFor(unmet.group.id);
      const el = document.getElementById(`group-${unmet.group.id}`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      el?.querySelector<HTMLElement>("[role=radio], [role=checkbox], input, [tabindex]")?.focus({ preventScroll: true });
      return;
    }
    const item: Omit<BasketItem, "key"> = {
      product_id: product.id,
      name: product.name,
      unit_price: product.price,
      quantity,
      modifiers: toModifiers(menu, product, selection),
      notes: notes.trim() ? notes.trim().slice(0, 200) : null,
    };
    if (editing) onUpdate(editing.key, item);
    else onAdd(item);
  };

  // The same rule as the POS picker: while a minimum is unmet the button says what is missing ("Choose 1 more: Protein").
  // It stays pressable so a VoiceOver user can reach it; pressing takes them to that group.
  const addLabel = editing ? "Update item" : quantity > 1 ? `Add ${quantity} to order · ${money(product.price)} each` : `Add to order · ${money(product.price)}`;
  const label = unmet ? unmet.message : addLabel;

  return (
    <BottomSheet
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={product.name}
      description={
        <span className="flex flex-col gap-1">
          {product.description ? <span>{product.description}</span> : null}
          <Money cents={product.price} size="heading" className="text-ink" />
        </span>
      }
      footer={
        <BrandButton variant={unmet ? "secondary" : "accent"} block onPress={commit}>
          {label}
        </BrandButton>
      }
    >
      <div className="flex flex-col gap-6">
        {groups.map((g) => renderGroup(g))}
        <TextField label="Note for the kitchen" value={notes} onChange={setNotes} maxLength={200} placeholder="Allergies, less spicy, no ice…" inputClassName="min-h-12" />
        <div className="flex items-center justify-between gap-3">
          <span className="text-line text-ink">Quantity</span>
          <GuestStepper value={quantity} onChange={setQuantity} min={1} max={maxQty} label="Quantity" />
        </div>
        {product.cap_remaining != null && product.cap_remaining <= 5 ? <p className="text-caption text-ink-2">Only {product.cap_remaining} left today.</p> : null}
      </div>
    </BottomSheet>
  );
}
