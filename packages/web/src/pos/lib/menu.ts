import type { CompiledMenu, CompiledProduct, Layout, LayoutTile, OrderType, ProductTile } from "../api/types";

/** The register's price for the order type (display only; the register prices the line). */
export function priceFor(product: CompiledProduct, orderType: OrderType): number {
  return product.prices_by_order_type[orderType] ?? product.price;
}

/** Does the product need the modifier sheet before it can be added with one tap? */
export function needsChoices(menu: CompiledMenu, product: CompiledProduct): boolean {
  if (product.open_price) return true;
  return product.modifier_groups.some((gid) => (menu.modifier_groups[gid]?.min_select ?? 0) > 0);
}

/** The layout's tile for each product (colour and access level), so search results keep the same look and the same role gate as the grid. */
export function tileIndex(layout: Layout | undefined): Map<string, Pick<ProductTile, "color" | "access_level">> {
  const m = new Map<string, Pick<ProductTile, "color" | "access_level">>();
  if (!layout) return m;
  const walk = (tiles: LayoutTile[]) => {
    for (const t of tiles) {
      if (t.kind === "product") {
        if (!m.has(t.product_id)) m.set(t.product_id, { color: t.color, access_level: t.access_level });
      } else walk(t.tiles);
    }
  };
  for (const p of layout.pages) walk(p.tiles);
  return m;
}

/** Search the channel's menu, never the whole catalogue (design 4.3). Starts after one character. */
export function searchMenu(menu: CompiledMenu, query: string, limit = 60): CompiledProduct[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const onMenu = new Set<string>();
  for (const s of menu.menu.sections) for (const it of s.items) onMenu.add(it.product_id);
  const out: CompiledProduct[] = [];
  for (const id of onMenu) {
    const p = menu.products[id];
    if (!p) continue;
    if (p.name.toLowerCase().includes(q) || (p.sku ?? "").toLowerCase().includes(q) || (p.kitchen_name ?? "").toLowerCase().includes(q)) out.push(p);
    if (out.length >= limit) break;
  }
  return out.sort((a, b) => Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name));
}

/** When the station has no layout, build pages from the menu's top-level sections. */
export function layoutFromMenu(menu: CompiledMenu): Layout {
  const top = menu.menu.sections.filter((s) => !s.parent_id);
  const children = (id: string) => menu.menu.sections.filter((s) => s.parent_id === id);
  const tilesFor = (items: { product_id: string }[]): ProductTile[] =>
    items.filter((i) => menu.products[i.product_id]).map((i) => ({ id: `p:${i.product_id}`, kind: "product" as const, label: menu.products[i.product_id]!.name, color: "stone", access_level: "everyone" as const, product_id: i.product_id }));
  return {
    id: `menu:${menu.menu.id}`,
    brand_id: menu.brand.id,
    name: menu.menu.name,
    version: 0,
    pages: top.map((s) => ({
      id: s.id,
      name: s.name,
      tiles: [
        ...tilesFor(s.items),
        ...children(s.id).map((c) => ({ id: c.id, kind: "folder" as const, label: c.name, color: "stone", access_level: "everyone" as const, tiles: tilesFor(c.items) })),
      ],
    })),
  };
}

/** Required-role label for a tile the signed-in role cannot use, or null. */
export function tileRestriction(level: ProductTile["access_level"] | "everyone", role: string): string | null {
  const rank: Record<string, number> = { server: 10, cashier: 20, manager: 30, finance: 40, admin: 50 };
  const need: Record<string, number> = { everyone: 0, cashier: 20, manager: 30, admin: 50 };
  if ((rank[role] ?? 0) >= (need[level] ?? 0)) return null;
  return level === "cashier" ? "Cashier" : level === "manager" ? "Manager" : "Admin";
}
