"use client";

import { AmountPad, Button, FolderTile, QuantityStepper, Sheet, SearchField, SectionRail, Skeleton, TextField, Tile, useLocale } from "@sail/ui";
import { useMemo, useState } from "react";
import type { CompiledProduct, FolderTile as FolderTileData, OrderSnapshot, ProductTile } from "../api/types";
import type { useOrderActions } from "../hooks/useOrderActions";
import { needsChoices, priceFor, searchMenu, tileIndex, tileRestriction } from "../lib/menu";
import { useUiStore } from "../state/ui";
import { defaultSelection, ModifierPicker, QUICK_NOTES, toModifiers, unmetRequirement, type Selection } from "./ModifierPicker";
import { usePos } from "./PosContext";
import { GREY_PILL } from "./styles";

type Panel = { kind: "modifiers"; product: CompiledProduct } | { kind: "open-price"; product: CompiledProduct } | null;

export type CatalogueProps = {
  order: OrderSnapshot;
  actions: ReturnType<typeof useOrderActions>;
  activeSeat: number | null;
};

/**
 * Section rail, catalogue grid and search. One tap adds a simple
 * item; items with required choices open the modifier sheet over the grid.
 */
export function Catalogue({ order, actions, activeSeat }: CatalogueProps) {
  const { menu, layout, staff, offline } = usePos();
  const notify = useUiStore((s) => s.notify);
  const [pageId, setPageId] = useState<string | null>(null);
  const [folder, setFolder] = useState<FolderTileData | null>(null);
  const [query, setQuery] = useState("");
  const [panel, setPanel] = useState<Panel>(null);

  const page = layout?.pages.find((p) => p.id === pageId) ?? layout?.pages[0] ?? null;
  const layoutTiles = useMemo(() => tileIndex(layout), [layout]);
  const results = useMemo(() => (menu && query.trim() ? searchMenu(menu, query) : null), [menu, query]);
  // How many of each item the order holds (voided ones out): a count on its tile.
  const onOrder = useMemo(() => {
    const n = new Map<string, number>();
    for (const l of order.lines) if (l.status !== "voided") n.set(l.product_id, (n.get(l.product_id) ?? 0) + l.quantity);
    return n;
  }, [order.lines]);

  // Search results keep the layout's colour and access level, so search is never a way around a restricted tile.
  const tiles: ProductTile[] | null = results ? results.map((p) => ({ id: `s:${p.id}`, kind: "product", label: p.name, color: layoutTiles.get(p.id)?.color ?? "stone", access_level: layoutTiles.get(p.id)?.access_level ?? "everyone", product_id: p.id })) : null;
  const shown = tiles ?? folder?.tiles ?? page?.tiles ?? [];

  const press = (tile: ProductTile) => {
    if (!menu) return;
    const product = menu.products[tile.product_id];
    if (!product) return notify({ text: `${tile.label} is not on this menu`, remedy: "Add it to the channel's menu in the back office.", tone: "alert", orderId: order.id });
    if (!product.available_now) return notify({ text: `${product.name}: ${product.unavailable_reason ?? "not available"}`, remedy: product.sold_out ? "Choose something else, or restore it from the sold-out list." : "Choose something else.", tone: "info", orderId: order.id });
    // Offline, an item is kept on the order and sent when the register is back; an open price needs a manager's approval through the register.
    if (offline && product.open_price) return notify({ text: "Offline", remedy: "An open price needs a manager's approval from the register. Reconnecting…", tone: "alert", orderId: order.id });
    const restricted = tileRestriction(tile.access_level, staff.role);
    if (restricted && !product.open_price) return notify({ text: `${product.name} needs ${restricted} or above`, remedy: "Ask them to add it from their sign-in.", tone: "info", orderId: order.id });
    if (product.open_price) return setPanel({ kind: "open-price", product });
    if (needsChoices(menu, product)) return setPanel({ kind: "modifiers", product });
    void actions.addLine({ product, quantity: 1, seat: activeSeat, orderType: order.order_type });
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 gap-3">
      <SectionRail
        items={(layout?.pages ?? []).map((p) => ({ id: p.id, label: p.name }))}
        selectedId={query ? null : (page?.id ?? null)}
        onSelect={(id) => {
          setPageId(id);
          setFolder(null);
          setQuery("");
        }}
        folder={folder ? { label: folder.label, onBack: () => setFolder(null) } : null}
      />
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col gap-3">
        <SearchField value={query} onChange={setQuery} placeholder="Search the menu" className="shrink-0" />
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          {!menu || !layout ? (
            <div className="grid grid-cols-4 gap-4">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="h-24 w-[136px]" />
              ))}
            </div>
          ) : (
            <>
              {query && results?.length === 0 ? <p className="px-1 py-2 text-body text-ink-2">Nothing on this menu matches “{query}”.</p> : null}
              <div className="grid grid-cols-[repeat(auto-fill,136px)] content-start gap-4 max-[900px]:grid-cols-[repeat(auto-fill,minmax(120px,1fr))] max-[900px]:gap-3" role="list" aria-label={folder ? folder.label : (page?.name ?? "Catalogue")}>
                {shown.map((tile) => {
                  if (tile.kind === "folder") return <FolderTile key={tile.id} label={tile.label} colour={tile.color} count={tile.tiles.length} onPress={() => setFolder(tile)} />;
                  const product = menu.products[tile.product_id];
                  return (
                    <Tile
                      key={tile.id}
                      label={tile.label}
                      colour={tile.color}
                      priceCents={product ? (product.open_price ? null : priceFor(product, order.order_type)) : null}
                      soldOut={product?.sold_out}
                      unavailableReason={product ? (product.available_now ? null : product.unavailable_reason) : "Not on menu"}
                      capRemaining={product?.cap_remaining}
                      restrictedTo={tileRestriction(tile.access_level, staff.role)}
                      onOrder={onOrder.get(tile.product_id) || undefined}
                      onPress={() => press(tile)}
                    />
                  );
                })}
              </div>
            </>
          )}
        </div>

        {menu && panel?.kind === "modifiers" ? (
          <ModifierSheet product={panel.product} orderType={order.order_type} onClose={() => setPanel(null)} onAdd={async (input) => {
            setPanel(null);
            await actions.addLine({ ...input, orderType: order.order_type, seat: activeSeat });
          }} />
        ) : null}
        {menu && panel?.kind === "open-price" ? (
          <OpenPriceSheet product={panel.product} onClose={() => setPanel(null)} onAdd={async (cents) => {
            setPanel(null);
            await actions.addLine({ product: panel.product, quantity: 1, openPrice: cents, orderType: order.order_type, seat: activeSeat });
          }} />
        ) : null}
      </div>
    </div>
  );
}

type AddInput = { product: CompiledProduct; quantity: number; modifiers: ReturnType<typeof toModifiers>; notes: string | null };

/** The modifier sheet: over the catalogue, required groups first; Add stays disabled with the reason on the button. */
function ModifierSheet({ product, orderType, onClose, onAdd }: { product: CompiledProduct; orderType: Parameters<typeof priceFor>[1]; onClose: () => void; onAdd: (input: AddInput) => Promise<void> }) {
  const { menu } = usePos();
  const { money } = useLocale();
  const [selection, setSelection] = useState<Selection>(() => (menu ? defaultSelection(menu, product) : {}));
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState("");
  if (!menu) return null;
  const unmet = unmetRequirement(menu, product, selection);
  const addNote = (chip: string) => setNotes((n) => (n.split(", ").includes(chip) ? n : n ? `${n}, ${chip}` : chip));
  return (
    <Sheet labelledClose
      isOpen
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={product.name}
      description={product.description ?? undefined}
      footer={
        <>
          <QuantityStepper value={quantity} onChange={setQuantity} />
          <div className="flex-1" />
          <Button
            variant="primary"
            size="lg"
            isDisabled={Boolean(unmet)}
            onPress={() => void onAdd({ product, quantity, modifiers: toModifiers(menu, product, selection), notes: notes.trim() || null })}
            className="min-w-[220px] text-[17px]"
          >
            {unmet ?? `Add ${quantity > 1 ? `${quantity} × ` : ""}${product.name}`}
          </Button>
        </>
      }
    >
      {/* The item's section and its price before choices (the "Mains · $16.00" row). */}
      <div className="mb-5 flex items-baseline justify-between gap-3">
        <span className="text-body text-ink-2">{menu.menu.sections.find((sec) => sec.items.some((i) => i.product_id === product.id))?.name ?? ""}</span>
        <span className="font-heading text-[17px] font-semibold text-ink tabular">{money(priceFor(product, orderType))}</span>
      </div>
      <ModifierPicker menu={menu} product={product} selection={selection} onChange={setSelection} />
      <section className="mt-6" aria-label="Notes for the kitchen">
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
    </Sheet>
  );
}

/** Open-price items: the amount pad, then Add (Manager approval when the role is below Manager). */
function OpenPriceSheet({ product, onClose, onAdd }: { product: CompiledProduct; onClose: () => void; onAdd: (cents: number) => Promise<void> }) {
  const { money } = useLocale();
  const { staff } = usePos();
  const [digits, setDigits] = useState("");
  const cents = Number(digits || "0");
  const needsApproval = !["manager", "finance", "admin"].includes(staff.role);
  return (
    <Sheet labelledClose
      isOpen
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={product.name}
      description="Enter the price"
      footer={
        <Button variant="primary" size="lg" isDisabled={cents <= 0} onPress={() => void onAdd(cents)} className="min-w-[260px]">
          Add {product.name} at {money(cents)}
          {needsApproval ? <span className="ml-2 rounded-chip bg-[color-mix(in_srgb,var(--status-bill)_14%,transparent)] px-2 text-caption text-status-bill">Manager approval</span> : null}
        </Button>
      }
    >
      <div className="flex justify-center pt-2">
        <AmountPad digits={digits} onChange={setDigits} mode="cents" hint="Open price · a manager approves it" />
      </div>
    </Sheet>
  );
}
