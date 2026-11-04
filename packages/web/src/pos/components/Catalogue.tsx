"use client";

import { AmountPad, Button, FolderTile, PanelSheet, QuantityStepper, SearchField, SectionRail, Skeleton, TextField, Tile, formatCents } from "@sail/ui";
import { useMemo, useState } from "react";
import type { CompiledProduct, FolderTile as FolderTileData, OrderSnapshot, ProductTile } from "../api/types";
import type { useOrderActions } from "../hooks/useOrderActions";
import { needsChoices, priceFor, searchMenu, tileIndex, tileRestriction } from "../lib/menu";
import { useUiStore } from "../state/ui";
import { defaultSelection, ModifierPicker, QUICK_NOTES, toModifiers, unmetRequirement, type Selection } from "./ModifierPicker";
import { usePos } from "./PosContext";

type Panel = { kind: "modifiers"; product: CompiledProduct } | { kind: "open-price"; product: CompiledProduct } | null;

export type CatalogueProps = {
  order: OrderSnapshot;
  actions: ReturnType<typeof useOrderActions>;
  activeSeat: number | null;
};

/**
 * Section rail, catalogue grid and search (design 4.3). One tap adds a simple
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

  // Search results keep the layout's colour and access level, so search is never a way around a restricted tile.
  const tiles: ProductTile[] | null = results ? results.map((p) => ({ id: `s:${p.id}`, kind: "product", label: p.name, color: layoutTiles.get(p.id)?.color ?? "stone", access_level: layoutTiles.get(p.id)?.access_level ?? "everyone", product_id: p.id })) : null;
  const shown = tiles ?? folder?.tiles ?? page?.tiles ?? [];

  const press = (tile: ProductTile) => {
    if (!menu) return;
    const product = menu.products[tile.product_id];
    if (!product) return notify({ text: `${tile.label} is not on this menu`, remedy: "Add it to the channel's menu in the back office.", tone: "alert", orderId: order.id });
    if (!product.available_now) return notify({ text: `${product.name}: ${product.unavailable_reason ?? "not available"}`, remedy: product.sold_out ? "Choose something else, or restore it from the sold-out list." : "Choose something else.", tone: "info", orderId: order.id });
    if (offline) return notify({ text: "Offline", remedy: "Adding items needs the register. Reconnecting…", tone: "alert", orderId: order.id });
    const restricted = tileRestriction(tile.access_level, staff.role);
    if (restricted && !product.open_price) return notify({ text: `${product.name} needs ${restricted} or above`, remedy: "Ask them to add it from their sign-in.", tone: "info", orderId: order.id });
    if (product.open_price) return setPanel({ kind: "open-price", product });
    if (needsChoices(menu, product)) return setPanel({ kind: "modifiers", product });
    void actions.addLine({ product, quantity: 1, seat: activeSeat, orderType: order.order_type });
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 pl-3">
      <SectionRail
        items={(layout?.pages ?? []).map((p) => ({ id: p.id, label: p.name }))}
        selectedId={query ? null : (page?.id ?? null)}
        onSelect={(id) => {
          setPageId(id);
          setFolder(null);
          setQuery("");
        }}
        folder={folder ? { label: folder.label, onBack: () => setFolder(null) } : null}
        footer={<SearchField value={query} onChange={setQuery} />}
      />
      <div className="relative min-h-0 min-w-0 flex-1">
        <div className="h-full overflow-y-auto px-3 py-3">
          {!menu || !layout ? (
            <div className="grid grid-cols-4 gap-4">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="h-24 w-[136px]" />
              ))}
            </div>
          ) : (
            <>
              {query && results?.length === 0 ? <p className="px-1 py-2 text-body text-ink-2">Nothing on this menu matches “{query}”.</p> : null}
              <div className="grid grid-cols-[repeat(auto-fill,136px)] content-start gap-4" role="list" aria-label={folder ? folder.label : (page?.name ?? "Catalogue")}>
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
                      onPress={() => press(tile)}
                    />
                  );
                })}
              </div>
            </>
          )}
        </div>

        {menu && panel?.kind === "modifiers" ? (
          <ModifierSheet product={panel.product} onClose={() => setPanel(null)} onAdd={async (input) => {
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

/** The modifier sheet (design 4.3): over the catalogue, required groups first; Add stays disabled with the reason on the button. */
function ModifierSheet({ product, onClose, onAdd }: { product: CompiledProduct; onClose: () => void; onAdd: (input: AddInput) => Promise<void> }) {
  const { menu } = usePos();
  const [selection, setSelection] = useState<Selection>(() => (menu ? defaultSelection(menu, product) : {}));
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState("");
  if (!menu) return null;
  const unmet = unmetRequirement(menu, product, selection);
  const addNote = (chip: string) => setNotes((n) => (n.split(", ").includes(chip) ? n : n ? `${n}, ${chip}` : chip));
  return (
    <PanelSheet
      isOpen
      onClose={onClose}
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
            className="min-w-[220px] min-h-16"
          >
            {unmet ?? `Add ${quantity > 1 ? `${quantity} × ` : ""}${product.name}`}
          </Button>
        </>
      }
    >
      <ModifierPicker menu={menu} product={product} selection={selection} onChange={setSelection} />
      <section className="mt-6" aria-label="Notes for the kitchen">
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
    </PanelSheet>
  );
}

/** Open-price items: the amount pad, then Add (Manager approval when the role is below Manager, design 4.7). */
function OpenPriceSheet({ product, onClose, onAdd }: { product: CompiledProduct; onClose: () => void; onAdd: (cents: number) => Promise<void> }) {
  const { staff } = usePos();
  const [digits, setDigits] = useState("");
  const cents = Number(digits || "0");
  const needsApproval = !["manager", "finance", "admin"].includes(staff.role);
  return (
    <PanelSheet
      isOpen
      onClose={onClose}
      title={product.name}
      description="Enter the price"
      footer={
        <Button variant="primary" size="lg" isDisabled={cents <= 0} onPress={() => void onAdd(cents)} className="min-w-[260px] min-h-16">
          Add {product.name} at {formatCents(cents)}
          {needsApproval ? <span className="ml-2 rounded-chip bg-[color-mix(in_srgb,var(--status-bill)_14%,transparent)] px-2 text-caption text-status-bill">Manager approval</span> : null}
        </Button>
      }
    >
      <div className="flex justify-center pt-2">
        <AmountPad digits={digits} onChange={setDigits} mode="cents" hint="Open price · a manager approves it" />
      </div>
    </PanelSheet>
  );
}
