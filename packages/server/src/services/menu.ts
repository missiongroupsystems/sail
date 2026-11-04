import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { ChannelType, OrderType } from "@sail/shared";
import { db } from "../db/client.js";
import { availabilityRules, brands, channelLinks, menuItems, menuSections, menus, modifierGroups, modifierOptions, outlets, productModifierGroups, productPrices, products, reportCategories, stockStatus } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";
import { localParts } from "../lib/time.js";

/**
 * The compiled menu for one channel link (`menu.get`, vision 5.12): sections,
 * products with resolved prices and modifier groups, availability and stock,
 * ready for the POS and the guest app to cache. The POS keeps one channel
 * link's menu in memory, never the whole catalogue (design 11.3).
 */
export type CompiledMenu = {
  channel_link: { id: string; channel: ChannelType; outlet_id: string; brand_id: string; menu_id: string; hold_orders: boolean; open_on_first_scan: boolean; service_requests: string[] };
  brand: { id: string; name: string; accent_color: string | null; display_font: string | null; logo_url: string | null };
  outlet: { id: string; name: string; phone: string | null };
  menu: { id: string; name: string; sections: { id: string; name: string; parent_id: string | null; sort: number; available_now: boolean; items: { product_id: string; sort: number }[] }[] };
  products: Record<string, CompiledProduct>;
  modifier_groups: Record<string, CompiledGroup>;
  compiled_at: string;
  version: string;
};
export type CompiledProduct = {
  id: string;
  name: string;
  kitchen_name: string | null;
  sku: string | null;
  description: string | null;
  price: number;
  prices_by_order_type: Partial<Record<OrderType, number>>;
  category_id: string | null;
  parent_category_id: string | null;
  tags: string[];
  is_bcrs: boolean;
  open_price: boolean;
  modifier_groups: string[];
  available_now: boolean;
  unavailable_reason: string | null;
  sold_out: boolean;
  sold_out_until: string | null;
  cap_remaining: number | null;
};
export type CompiledGroup = { id: string; name: string; min_select: number; max_select: number | null; max_per_modifier: number; options: { product_id: string; name: string; price: number; child_group_id: string | null; is_default: boolean; sort: number }[] };

export async function compileMenu(channelLinkId: string, at: Date): Promise<CompiledMenu> {
  const [link] = await db().select().from(channelLinks).where(eq(channelLinks.id, channelLinkId)).limit(1);
  if (!link) throw AppError.notFound("channel link", channelLinkId);
  const [brand] = await db().select().from(brands).where(eq(brands.id, link.brandId)).limit(1);
  const [outlet] = await db().select().from(outlets).where(eq(outlets.id, link.outletId)).limit(1);
  const [menu] = await db().select().from(menus).where(eq(menus.id, link.menuId)).limit(1);
  if (!brand || !outlet || !menu) throw AppError.notFound("menu for channel link", channelLinkId);

  const sections = await db().select().from(menuSections).where(eq(menuSections.menuId, menu.id)).orderBy(asc(menuSections.sort), asc(menuSections.name));
  const items = await db().select().from(menuItems).where(eq(menuItems.menuId, menu.id)).orderBy(asc(menuItems.sort));
  const productIds = [...new Set(items.map((i) => i.productId))];
  const prods = productIds.length ? await db().select().from(products).where(and(inArray(products.id, productIds), isNull(products.archivedAt))) : [];
  const prodIdSet = new Set(prods.map((p) => p.id));
  const prices = productIds.length ? await db().select().from(productPrices).where(inArray(productPrices.productId, productIds)) : [];
  const pmg = productIds.length ? await db().select().from(productModifierGroups).where(inArray(productModifierGroups.productId, productIds)).orderBy(asc(productModifierGroups.sort)) : [];

  // Modifier groups: those attached to products, plus nested child groups (2 levels).
  const groupIds = new Set(pmg.map((x) => x.groupId));
  let groups = groupIds.size ? await db().select().from(modifierGroups).where(and(inArray(modifierGroups.id, [...groupIds]), isNull(modifierGroups.archivedAt))) : [];
  let options = groupIds.size ? await db().select().from(modifierOptions).where(inArray(modifierOptions.groupId, [...groupIds])).orderBy(asc(modifierOptions.sort)) : [];
  const childIds = [...new Set(options.map((o) => o.childGroupId).filter((x): x is string => !!x && !groupIds.has(x)))];
  if (childIds.length) {
    groups = groups.concat(await db().select().from(modifierGroups).where(and(inArray(modifierGroups.id, childIds), isNull(modifierGroups.archivedAt))));
    options = options.concat(await db().select().from(modifierOptions).where(inArray(modifierOptions.groupId, childIds)).orderBy(asc(modifierOptions.sort)));
  }
  const modifierProductIds = [...new Set(options.map((o) => o.productId).filter((id) => !prodIdSet.has(id)))];
  const modifierProducts = modifierProductIds.length ? await db().select().from(products).where(inArray(products.id, modifierProductIds)) : [];
  const allProducts = [...prods, ...modifierProducts];
  const byProduct = new Map(allProducts.map((p) => [p.id, p]));

  const cats = await db().select().from(reportCategories).where(eq(reportCategories.merchantId, link.merchantId));
  const catParent = new Map(cats.map((c) => [c.id, c.parentId]));

  const stock = productIds.length ? await db().select().from(stockStatus).where(and(eq(stockStatus.outletId, link.outletId), inArray(stockStatus.productId, productIds))) : [];
  const stockBy = new Map(stock.map((s) => [s.productId, s]));
  const rules = await db().select().from(availabilityRules).where(eq(availabilityRules.merchantId, link.merchantId));
  const rulesBy = new Map<string, (typeof rules)[number][]>();
  for (const r of rules) {
    const k = `${r.targetKind}:${r.targetId}`;
    rulesBy.set(k, [...(rulesBy.get(k) ?? []), r]);
  }
  const local = localParts(at, "Asia/Singapore");
  const dow = new Date(`${local.date}T00:00:00Z`).getUTCDay();
  const availableNow = (kind: "product" | "section", id: string): { ok: boolean; reason: string | null } => {
    const rs = rulesBy.get(`${kind}:${id}`);
    if (!rs || rs.length === 0) return { ok: true, reason: null };
    for (const r of rs) {
      if (r.outletIds.length && !r.outletIds.includes(link.outletId)) continue;
      if (r.channels.length && !r.channels.includes(link.channel)) continue;
      if (r.daysOfWeek.length && !r.daysOfWeek.includes(dow)) continue;
      if (r.startTime && local.time < r.startTime) continue;
      if (r.endTime && local.time >= r.endTime) continue;
      return { ok: true, reason: null };
    }
    const timed = rs.find((r) => r.startTime || r.endTime || r.daysOfWeek.length);
    return { ok: false, reason: timed ? "Not available at this time" : "Not available at this outlet or channel" };
  };
  const today = local.date;

  const compiledProducts: Record<string, CompiledProduct> = {};
  for (const p of allProducts) {
    const st = stockBy.get(p.id);
    const soldOut = !!st?.soldOutUntil && st.soldOutUntil.getTime() > at.getTime();
    const capRemaining = st?.dailyCap != null ? (st.capDate === today ? (st.capRemaining ?? 0) : st.dailyCap) : null;
    const avail = availableNow("product", p.id);
    const unavailable = soldOut ? "Sold out" : capRemaining === 0 ? "Sold out for today" : avail.ok ? null : avail.reason;
    compiledProducts[p.id] = {
      id: p.id,
      name: p.name,
      kitchen_name: p.kitchenName,
      sku: p.sku,
      description: p.description,
      price: p.price,
      prices_by_order_type: Object.fromEntries(prices.filter((x) => x.productId === p.id).map((x) => [x.orderType, x.price])) as Partial<Record<OrderType, number>>,
      category_id: p.categoryId,
      parent_category_id: p.categoryId ? (catParent.get(p.categoryId) ?? null) : null,
      tags: p.tags,
      is_bcrs: p.isBcrs,
      open_price: p.openPrice,
      modifier_groups: pmg.filter((x) => x.productId === p.id).map((x) => x.groupId),
      available_now: unavailable === null,
      unavailable_reason: unavailable,
      sold_out: soldOut || capRemaining === 0,
      sold_out_until: st?.soldOutUntil ? (st.soldOutUntil.getTime() > 4e12 ? "indefinite" : st.soldOutUntil.toISOString()) : null,
      cap_remaining: capRemaining,
    };
  }
  const compiledGroups: Record<string, CompiledGroup> = {};
  for (const g of groups) {
    compiledGroups[g.id] = {
      id: g.id,
      name: g.name,
      min_select: g.minSelect,
      max_select: g.maxSelect,
      max_per_modifier: g.maxPerModifier,
      options: options
        .filter((o) => o.groupId === g.id)
        .map((o) => {
          const mp = byProduct.get(o.productId);
          return { product_id: o.productId, name: mp?.name ?? "?", price: o.priceOverride ?? mp?.price ?? 0, child_group_id: o.childGroupId, is_default: o.isDefault, sort: o.sort };
        }),
    };
  }
  const versionSource = [menu.updatedAt.toISOString(), ...allProducts.map((p) => p.updatedAt.toISOString()), ...stock.map((s) => s.updatedAt.toISOString())].sort().at(-1) ?? at.toISOString();
  return {
    channel_link: { id: link.id, channel: link.channel, outlet_id: link.outletId, brand_id: link.brandId, menu_id: link.menuId, hold_orders: link.holdOrders, open_on_first_scan: link.openOnFirstScan, service_requests: link.serviceRequests },
    brand: { id: brand.id, name: brand.name, accent_color: brand.accentColor, display_font: brand.displayFont, logo_url: brand.logoUrl },
    outlet: { id: outlet.id, name: outlet.name, phone: outlet.phone },
    menu: {
      id: menu.id,
      name: menu.name,
      sections: sections.map((s) => ({ id: s.id, name: s.name, parent_id: s.parentId, sort: s.sort, available_now: availableNow("section", s.id).ok, items: items.filter((i) => i.sectionId === s.id && prodIdSet.has(i.productId)).map((i) => ({ product_id: i.productId, sort: i.sort })) })),
    },
    products: compiledProducts,
    modifier_groups: compiledGroups,
    compiled_at: at.toISOString(),
    version: versionSource,
  };
}
