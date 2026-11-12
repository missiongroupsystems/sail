"use client";

import { formatCents } from "@sail/ui";
import { Check } from "lucide-react";
import { Icon } from "@sail/ui";
import { Button as AriaButton } from "react-aria-components";
import type { CompiledGroup, CompiledMenu, CompiledProduct, SnapshotLine } from "../api/types";

/** Chosen option product ids per group id. */
export type Selection = Record<string, string[]>;

export type ChosenModifier = { group_id: string; product_id: string; name: string; price: number; quantity?: number };

/** The groups in play: the product's own, plus child groups under chosen options (2 levels, design 4.3). */
export function activeGroups(menu: CompiledMenu, product: CompiledProduct, selection: Selection): { group: CompiledGroup; parent: { group: CompiledGroup; option: string } | null }[] {
  const out: { group: CompiledGroup; parent: { group: CompiledGroup; option: string } | null }[] = [];
  for (const gid of product.modifier_groups) {
    const g = menu.modifier_groups[gid];
    if (!g) continue;
    out.push({ group: g, parent: null });
    for (const pid of selection[gid] ?? []) {
      const opt = g.options.find((o) => o.product_id === pid);
      const child = opt?.child_group_id ? menu.modifier_groups[opt.child_group_id] : null;
      if (child) out.push({ group: child, parent: { group: g, option: pid } });
    }
  }
  // Required groups first (design 4.3).
  return out.sort((a, b) => Number(b.group.min_select > 0) - Number(a.group.min_select > 0));
}

/** "Choose 1 more: Spice level", or null when every minimum is met. */
export function unmetRequirement(menu: CompiledMenu, product: CompiledProduct, selection: Selection): string | null {
  for (const { group } of activeGroups(menu, product, selection)) {
    const n = (selection[group.id] ?? []).length;
    if (n < group.min_select) return `Choose ${group.min_select - n} more: ${group.name}`;
  }
  return null;
}

export function toModifiers(menu: CompiledMenu, product: CompiledProduct, selection: Selection): ChosenModifier[] {
  const out: ChosenModifier[] = [];
  for (const { group } of activeGroups(menu, product, selection)) {
    for (const pid of selection[group.id] ?? []) {
      const opt = group.options.find((o) => o.product_id === pid);
      if (opt) out.push({ group_id: group.id, product_id: pid, name: opt.name, price: opt.price });
    }
  }
  return out;
}

export function selectionFromLine(line: SnapshotLine): Selection {
  const sel: Selection = {};
  for (const m of line.modifiers) (sel[m.group_id] ??= []).push(m.product_id);
  return sel;
}

/** Defaults the register marks `is_default` on required groups, so the common case is already filled (principle 6). */
export function defaultSelection(menu: CompiledMenu, product: CompiledProduct): Selection {
  const sel: Selection = {};
  for (const gid of product.modifier_groups) {
    const g = menu.modifier_groups[gid];
    if (!g || g.min_select === 0) continue;
    const d = g.options.filter((o) => o.is_default).slice(0, g.max_select ?? g.options.length);
    if (d.length) sel[gid] = d.map((o) => o.product_id);
  }
  return sel;
}

function ruleText(g: CompiledGroup): string {
  if (g.min_select > 0 && g.max_select === g.min_select) return `Choose ${g.min_select}`;
  if (g.min_select > 0 && g.max_select) return `Choose ${g.min_select} to ${g.max_select}`;
  if (g.min_select > 0) return `Choose at least ${g.min_select}`;
  if (g.max_select) return `Choose up to ${g.max_select}`;
  return "Optional";
}

export type ModifierPickerProps = {
  menu: CompiledMenu;
  product: CompiledProduct;
  selection: Selection;
  onChange: (selection: Selection) => void;
  isDisabled?: boolean;
};

/** Required groups first, "Choose 1" / "Choose up to 3", nested groups inline under their option (design 4.3). */
export function ModifierPicker({ menu, product, selection, onChange, isDisabled }: ModifierPickerProps) {
  const groups = activeGroups(menu, product, selection);

  const toggle = (g: CompiledGroup, pid: string) => {
    const cur = selection[g.id] ?? [];
    let next: string[];
    if (cur.includes(pid)) next = cur.filter((x) => x !== pid);
    else if (g.max_select === 1) next = [pid];
    else if (g.max_select != null && cur.length >= g.max_select) return;
    else next = [...cur, pid];
    const out: Selection = { ...selection, [g.id]: next };
    // A deselected option takes its child group's choices with it.
    for (const pidRemoved of cur.filter((x) => !next.includes(x))) {
      const child = g.options.find((o) => o.product_id === pidRemoved)?.child_group_id;
      if (child) delete out[child];
    }
    onChange(out);
  };

  return (
    <div className="flex flex-col gap-5">
      {groups.map(({ group, parent }) => {
        const chosen = selection[group.id] ?? [];
        const met = chosen.length >= group.min_select;
        const full = group.max_select != null && chosen.length >= group.max_select;
        return (
          <section key={group.id} className={parent ? "ml-4 border-l-2 border-rule pl-4" : ""} aria-label={group.name}>
            <header className="mb-2 flex items-baseline justify-between gap-2">
              <h3 className="text-line text-ink">
                {group.name}
                {parent ? <span className="text-ink-2"> · for {parent.group.options.find((o) => o.product_id === parent.option)?.name}</span> : null}
              </h3>
              <span className={"text-caption " + (group.min_select > 0 && !met ? "text-status-bill" : "text-ink-2")}>{ruleText(group)}</span>
            </header>
            <div className="grid grid-cols-2 gap-2">
              {group.options.map((o) => {
                const on = chosen.includes(o.product_id);
                return (
                  <AriaButton
                    key={o.product_id}
                    onPress={() => toggle(group, o.product_id)}
                    isDisabled={isDisabled || (!on && full && group.max_select !== 1)}
                    aria-pressed={on}
                    className={
                      "press pos-touch flex min-h-14 items-center justify-between gap-2 rounded-tile px-4 text-left text-line outline-none data-[pressed]:scale-[0.98] data-[disabled]:opacity-40 data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-status-seated " +
                      (on ? "bg-ink text-surface" : "bg-surface-2 text-ink")
                    }
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {on ? <Icon icon={Check} size={18} /> : <span className="inline-block size-[18px] shrink-0 rounded-full ring-1 ring-inset ring-current opacity-50" aria-hidden />}
                      <span className="truncate">{o.name}</span>
                    </span>
                    {o.price > 0 ? <span className={"shrink-0 text-caption tabular " + (on ? "text-surface/80" : "text-ink-2")}>{formatCents(o.price, { signed: true })}</span> : null}
                  </AriaButton>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export const QUICK_NOTES = ["No ice", "Less sugar", "Less spicy", "Extra spicy", "No chilli", "No onion", "Takeaway pack", "Allergy: see note"];
