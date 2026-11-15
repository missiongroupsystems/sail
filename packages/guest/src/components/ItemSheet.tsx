"use client";

import { BottomSheet, BrandButton, ChoiceGroup, cx, GuestStepper, Money, type ChoiceValue, useLocale } from "@sail/ui";
import { useState } from "react";
import { Input, Label, TextField as AriaTextField } from "react-aria-components";
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
 * a note for the kitchen, and a footer with the quantity stepper and one
 * "Add to order" button that carries the menu price and stays disabled, with the reason, until every
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
  // The menu section the item sits in ("Noodles"), under its name.
  const category = menu.menu.sections.find((sec) => sec.items.some((i) => i.product_id === product.id))?.name ?? null;
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
  // The price is the menu price and each chosen option's price, as the register lists them (a default option that costs
  // extra included); the phone never adds them up, so the button shows the parts, as the review page does.
  const extras = toModifiers(menu, product, selection).filter((m) => m.price !== 0).map((m) => (m.quantity > 1 ? `${m.quantity} × ${money(m.price)}` : money(m.price)));
  const price = [money(product.price), ...extras].join(" + ");
  const verb = editing ? "Update item" : quantity > 1 ? `Add ${quantity} to order` : "Add to order";
  const priceLine = editing ? null : quantity > 1 ? `${price} each` : price;
  const addLabel = priceLine ? `${verb} · ${priceLine}` : verb;
  const label = unmet ? unmet.message : addLabel;

  return (
    <BottomSheet
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={product.name}
      description={
        category || product.description ? (
          <span className="flex flex-col gap-1">
            {category ? <span className="text-ink-3">{category}</span> : null}
            {product.description ? <span className="wrap-anywhere">{product.description}</span> : null}
          </span>
        ) : undefined
      }
      className={groups.length ? "h-[92dvh]" : undefined}
      footer={
        <div className="flex items-center gap-3">
          <GuestStepper value={quantity} onChange={setQuantity} min={1} max={maxQty} label="Quantity" />
          {/* The accessible name is the whole sentence. While a choice is missing the button looks disabled but stays pressable,
              so a VoiceOver user can reach it; pressing takes them to the group. */}
          <BrandButton variant={unmet ? "secondary" : "accent"} onPress={commit} aria-label={label} className={cx("min-h-14 min-w-0 flex-1 px-4 py-1.5 text-[16px] leading-tight", unmet && "text-ink-3")}>
            {/* Each part keeps to one line; a wrap only ever falls between the verb and the price, the dot staying with the verb. */}
            {unmet ? (
              <span className="max-w-full truncate whitespace-nowrap">{unmet.message}</span>
            ) : (
              <span className="flex max-w-full flex-wrap items-baseline justify-center gap-x-1.5 text-center">
                <span className="whitespace-nowrap">{priceLine ? `${verb} ·` : verb}</span>
                {priceLine ? <span className="whitespace-nowrap tabular">{priceLine}</span> : null}
              </span>
            )}
          </BrandButton>
        </div>
      }
    >
      <div className="flex flex-col gap-6">
        <div className="flex items-baseline gap-2 text-[15px] text-ink-2">
          <Money cents={product.price} size="heading" className="font-heading text-[18px] font-semibold text-ink" />
          <span>each</span>
        </div>
        {groups.map((g) => renderGroup(g))}
        <AriaTextField value={notes} onChange={setNotes} maxLength={200} className="flex flex-col gap-2">
          <Label className="flex items-baseline justify-between gap-3">
            <span className="font-display text-[16px] font-semibold text-ink">Note for the kitchen</span>
          </Label>
          <Input placeholder="Allergies, less spicy, no ice…" className="h-12 w-full rounded-sheet border border-transparent bg-surface-2 px-4 text-[16px] text-ink outline-none placeholder:text-ink-3 focus:border-rule-strong focus:bg-surface" />
        </AriaTextField>
        {product.cap_remaining != null && product.cap_remaining <= 5 ? <p className="text-caption text-ink-3">Only {product.cap_remaining} left today.</p> : null}
      </div>
    </BottomSheet>
  );
}
