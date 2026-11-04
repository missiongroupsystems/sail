import type { ChoiceValue } from "@sail/ui";
import type { CompiledGroup, CompiledMenu, CompiledProduct, RoundModifierInput } from "./types";

/** Chosen options (with quantities) per group id, child groups included. */
export type Selection = Record<string, ChoiceValue>;

export type ChosenModifier = { group_id: string; product_id: string; name: string; price: number; quantity: number };

/** The product's own groups, required ones first (design 4.3, 4.11). Child groups render inline under their option. */
export function topGroups(menu: CompiledMenu, product: CompiledProduct): CompiledGroup[] {
  const groups = product.modifier_groups.map((gid) => menu.modifier_groups[gid]).filter((g): g is CompiledGroup => Boolean(g));
  return groups.sort((a, b) => Number(b.min_select > 0) - Number(a.min_select > 0));
}

/** The child group under a chosen option, if the option has one. */
export function childGroup(menu: CompiledMenu, group: CompiledGroup, optionId: string): CompiledGroup | null {
  const opt = group.options.find((o) => o.product_id === optionId);
  return opt?.child_group_id ? (menu.modifier_groups[opt.child_group_id] ?? null) : null;
}

/**
 * Every group in play: the product's groups plus the child groups of chosen
 * options, followed as deep as the sheet renders them (the register allows a
 * child group whenever its parent option is chosen, so the rules must match).
 */
export function activeGroups(menu: CompiledMenu, product: CompiledProduct, selection: Selection): CompiledGroup[] {
  const out: CompiledGroup[] = [];
  const seen = new Set<string>();
  const visit = (g: CompiledGroup) => {
    if (seen.has(g.id)) return;
    seen.add(g.id);
    out.push(g);
    for (const v of selection[g.id] ?? []) {
      const child = childGroup(menu, g, v.id);
      if (child) visit(child);
    }
  };
  for (const g of topGroups(menu, product)) visit(g);
  return out;
}

/** "Choose 1" / "Choose 1 to 3" / "Choose at least 2" / "Choose up to 3" / "Optional". */
export function ruleText(g: CompiledGroup): string {
  if (g.min_select > 0 && g.max_select === g.min_select) return `Choose ${g.min_select}`;
  if (g.min_select > 0 && g.max_select) return `Choose ${g.min_select} to ${g.max_select}`;
  if (g.min_select > 0) return `Choose at least ${g.min_select}`;
  if (g.max_select) return `Choose up to ${g.max_select}`;
  return "Optional";
}

/** The first unmet minimum, worded as the register words it ("Choose 1 more: Protein"), or null. */
export function unmetRequirement(menu: CompiledMenu, product: CompiledProduct, selection: Selection): { group: CompiledGroup; message: string } | null {
  for (const group of activeGroups(menu, product, selection)) {
    const n = (selection[group.id] ?? []).length;
    if (n < group.min_select) return { group, message: `Choose ${group.min_select - n} more: ${group.name}` };
  }
  return null;
}

/** Replace one group's value, taking the child choices of any deselected option with it. */
export function setGroupValue(menu: CompiledMenu, selection: Selection, group: CompiledGroup, value: ChoiceValue): Selection {
  const before = selection[group.id] ?? [];
  const keep = new Set(value.map((v) => v.id));
  const out: Selection = { ...selection, [group.id]: value };
  for (const v of before) {
    if (keep.has(v.id)) continue;
    const child = childGroup(menu, group, v.id);
    if (child) {
      for (const cv of out[child.id] ?? []) {
        const grandchild = childGroup(menu, child, cv.id);
        if (grandchild) delete out[grandchild.id];
      }
      delete out[child.id];
    }
  }
  return out;
}

/** Defaults the register marks `is_default` on required groups (and their required children), so the common case is filled. */
export function defaultSelection(menu: CompiledMenu, product: CompiledProduct): Selection {
  const sel: Selection = {};
  const fill = (g: CompiledGroup) => {
    if (g.min_select === 0) return;
    const d = g.options.filter((o) => o.is_default).slice(0, g.max_select ?? g.options.length);
    if (!d.length) return;
    sel[g.id] = d.map((o) => ({ id: o.product_id, quantity: 1 }));
    for (const o of d) {
      const child = childGroup(menu, g, o.product_id);
      if (child) fill(child);
    }
  };
  for (const g of topGroups(menu, product)) fill(g);
  return sel;
}

/** Flatten the selection into what the register takes, with names and prices for display. */
export function toModifiers(menu: CompiledMenu, product: CompiledProduct, selection: Selection): ChosenModifier[] {
  const out: ChosenModifier[] = [];
  for (const group of activeGroups(menu, product, selection)) {
    for (const v of selection[group.id] ?? []) {
      const opt = group.options.find((o) => o.product_id === v.id);
      if (opt) out.push({ group_id: group.id, product_id: v.id, name: opt.name, price: opt.price, quantity: Math.max(1, Math.min(group.max_per_modifier, v.quantity)) });
    }
  }
  return out;
}

/** Back from stored modifiers to a selection (editing a basket item). */
export function selectionFromModifiers(mods: ChosenModifier[]): Selection {
  const sel: Selection = {};
  for (const m of mods) (sel[m.group_id] ??= []).push({ id: m.product_id, quantity: m.quantity });
  return sel;
}

export function toRoundModifiers(mods: ChosenModifier[]): RoundModifierInput[] {
  return mods.map((m) => ({ group_id: m.group_id, product_id: m.product_id, ...(m.quantity > 1 ? { quantity: m.quantity } : {}) }));
}
