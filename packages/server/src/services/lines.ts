import { AppError } from "../lib/errors.js";
import type { CompiledMenu } from "./menu.js";
import type { LineModifier, orderLines } from "../db/schema/index.js";
import { consumeDailyCap } from "../routes/catalogue.js";

export type LineInput = {
  line_id: string;
  product_id: string;
  quantity: number;
  modifiers?: { group_id: string; product_id: string; quantity?: number }[];
  notes?: string | null;
  seat_no?: number | null;
  hold?: boolean;
  open_price?: number | null;
};

/**
 * Validate modifier selections against the compiled menu's groups (min/max,
 * per-modifier maximum, membership, nesting to two levels) and resolve prices.
 */
export function resolveModifiers(menu: CompiledMenu, product: CompiledMenu["products"][string], selections: NonNullable<LineInput["modifiers"]>): LineModifier[] {
  const topGroups = product.modifier_groups;
  const allowed = new Set(topGroups);
  // Child groups become allowed when one of their parent options is selected.
  for (const sel of selections) {
    if (!allowed.has(sel.group_id)) continue;
    const g = menu.modifier_groups[sel.group_id];
    const opt = g?.options.find((o) => o.product_id === sel.product_id);
    if (opt?.child_group_id) allowed.add(opt.child_group_id);
  }
  const out: LineModifier[] = [];
  const countByGroup = new Map<string, number>();
  for (const sel of selections) {
    const g = menu.modifier_groups[sel.group_id];
    if (!g || !allowed.has(sel.group_id)) throw AppError.validation(`Modifier group ${sel.group_id} does not apply to ${product.name}`);
    const opt = g.options.find((o) => o.product_id === sel.product_id);
    if (!opt) throw AppError.validation(`${sel.product_id} is not an option of ${g.name}`);
    const qty = sel.quantity ?? 1;
    if (qty < 1) throw AppError.validation("Modifier quantity must be at least 1");
    if (qty > g.max_per_modifier) throw AppError.validation(`${opt.name}: at most ${g.max_per_modifier} per modifier in ${g.name}`, { group_id: g.id, max_per_modifier: g.max_per_modifier });
    countByGroup.set(g.id, (countByGroup.get(g.id) ?? 0) + qty);
    out.push({ modifier_id: `${g.id}:${opt.product_id}`, product_id: opt.product_id, name: opt.name, quantity: qty, price: opt.price, group_id: g.id });
  }
  for (const gid of allowed) {
    const g = menu.modifier_groups[gid];
    if (!g) continue;
    const n = countByGroup.get(gid) ?? 0;
    if (n < g.min_select) throw AppError.validation(`Choose ${g.min_select - n} more: ${g.name}`, { group_id: gid, min_select: g.min_select, selected: n, remedy: `Choose at least ${g.min_select} in ${g.name}.` });
    if (g.max_select != null && n > g.max_select) throw AppError.validation(`Choose up to ${g.max_select}: ${g.name}`, { group_id: gid, max_select: g.max_select, selected: n });
  }
  return out;
}

export type BuiltLine = Omit<typeof orderLines.$inferInsert, "orderId" | "merchantId" | "outletId">;

/** Build line rows from inputs against the compiled menu, enforcing availability, 86 and daily caps. */
export async function buildLines(menu: CompiledMenu, inputs: LineInput[], ctx: { orderType: string; outletId: string; today: string; source: "pos" | "guest"; addedBy: string | null; addedByName: string | null; allowOpenPrice: boolean; startSort: number }): Promise<BuiltLine[]> {
  const built: BuiltLine[] = [];
  let sort = ctx.startSort;
  for (const input of inputs) {
    const product = menu.products[input.product_id];
    if (!product) throw AppError.notFound("product on this menu", input.product_id);
    if (!product.available_now) {
      throw new AppError("unavailable", `${product.name}: ${product.unavailable_reason ?? "not available"}`, { remedy: product.sold_out ? "Choose something else, or restore it from the sold-out list." : "Choose something else.", details: { product_id: product.id, reason: product.unavailable_reason, cap_remaining: product.cap_remaining, sold_out_until: product.sold_out_until } });
    }
    if (input.open_price != null && !product.open_price) throw AppError.validation(`${product.name} does not allow an open price`);
    if (product.open_price && input.open_price == null) throw AppError.validation(`${product.name} needs a price`, { remedy: "Enter the price for this open item." });
    if (input.open_price != null && !ctx.allowOpenPrice) throw AppError.permission("manager", true, "lines.add_open_price");
    if (!Number.isInteger(input.quantity) || input.quantity < 1) throw AppError.validation("quantity must be at least 1");
    const modifiers = resolveModifiers(menu, product, input.modifiers ?? []);
    const cap = await consumeDailyCap(ctx.outletId, product.id, input.quantity, ctx.today);
    if (!cap.ok) throw new AppError("unavailable", `${product.name}: only ${cap.remaining} left today`, { remedy: cap.remaining ? `Reduce the quantity to ${cap.remaining}.` : "Choose something else.", details: { product_id: product.id, cap_remaining: cap.remaining } });
    built.push({
      id: input.line_id,
      productId: product.id,
      name: product.name,
      kitchenName: product.kitchen_name,
      sku: product.sku,
      categoryId: product.category_id,
      parentCategoryId: product.parent_category_id,
      tags: product.tags,
      hasDeposit: product.has_deposit,
      taxClassId: product.tax_class_id,
      quantity: input.quantity,
      unitPrice: input.open_price ?? product.prices_by_order_type[ctx.orderType as keyof typeof product.prices_by_order_type] ?? product.price,
      basePrice: product.price,
      pricesByOrderType: product.prices_by_order_type as Record<string, number>,
      openPrice: input.open_price ?? null,
      modifiers,
      notes: input.notes ?? null,
      seatNo: input.seat_no ?? null,
      source: ctx.source,
      status: input.hold ? "held" : "pending",
      sort: sort++,
      addedBy: ctx.addedBy,
      addedByName: ctx.addedByName,
    });
  }
  return built;
}
