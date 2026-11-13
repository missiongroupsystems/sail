"use client";

import { Icon, MenuItemRow, ScrollTabs, type MenuItemState, useLocale } from "@sail/ui";
import { ChevronRight, ConciergeBell, ReceiptText, Search, X } from "lucide-react";
import { Button as AriaButton, Input, SearchField } from "react-aria-components";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BasketItem } from "@/lib/basket";
import type { CompiledMenu, CompiledProduct, CompiledSection, GuestSession, OrderView } from "@/lib/types";
import { billNote } from "@/lib/status";
import { BasketBar } from "./BasketBar";
import { StaffBanner } from "./StaffBanner";

export type MenuViewProps = {
  session: GuestSession;
  menu: CompiledMenu;
  canOrder: boolean;
  /** The table is not open yet: check with the register now. */
  onCheckAgain?: () => void;
  basketItems: BasketItem[];
  orderView: OrderView | null;
  onOpenItem: (productId: string) => void;
  onReview: () => void;
  onCallStaff: () => void;
  onStatus: () => void;
  /** The table pill in the header: "Our table", what the whole table has ordered. */
  onOurTable: () => void;
};

type Group = { section: CompiledSection; children: CompiledSection[] };

function itemState(product: CompiledProduct, section: CompiledSection, canOrder: boolean): { state: MenuItemState; reason: string | null } {
  if (product.sold_out) return { state: "sold_out", reason: null };
  if (!section.available_now) return { state: "unavailable", reason: "Not available right now" };
  if (!product.available_now) return { state: "unavailable", reason: product.unavailable_reason ?? "Not available right now" };
  return { state: canOrder ? "orderable" : "browse", reason: null };
}

/** An open-price item needs staff to key its price (and a manager to approve it), so a guest never sees it. */
function guestOrderable(p: CompiledProduct | undefined): p is CompiledProduct {
  return p !== undefined && !p.open_price;
}

/** The landing screen: outlet and brand with the table pill, one sticky bar (Call staff and the section chips), then the menu. */
export function MenuView({ session, menu, canOrder, basketItems, orderView, onOpenItem, onReview, onCallStaff, onStatus, onOurTable, onCheckAgain }: MenuViewProps) {
  const { clock } = useLocale();
  const groups = useMemo<Group[]>(() => {
    const sections = [...menu.menu.sections].sort((a, b) => a.sort - b.sort);
    const hasItems = (s: CompiledSection) => s.items.some((i) => guestOrderable(menu.products[i.product_id]));
    return sections
      .filter((s) => !s.parent_id)
      .map((section) => ({ section, children: sections.filter((c) => c.parent_id === section.id && hasItems(c)) }))
      .filter((g) => hasItems(g.section) || g.children.length > 0);
  }, [menu]);

  const inBasket = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of basketItems) m.set(i.product_id, (m.get(i.product_id) ?? 0) + i.quantity);
    return m;
  }, [basketItems]);

  /* Sticky tabs follow the section under the header; tapping one scrolls to it. */
  const headerRef = useRef<HTMLDivElement>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  const [selected, setSelected] = useState<string | null>(groups[0]?.section.id ?? null);
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeaderHeight(el.getBoundingClientRect().height));
    ro.observe(el);
    setHeaderHeight(el.getBoundingClientRect().height);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const bottom = headerRef.current?.getBoundingClientRect().bottom ?? 0;
      let current = groups[0]?.section.id ?? null;
      for (const g of groups) {
        const el = document.getElementById(`section-${g.section.id}`);
        if (!el) continue;
        if (el.getBoundingClientRect().top - bottom <= 12) current = g.section.id;
        else break;
      }
      setSelected(current);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [groups]);
  const jumpTo = (id: string) => {
    setSelected(id);
    document.getElementById(`section-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // Search the loaded menu by name, on the phone (a round search button); the register is not asked.
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const q = query.trim().toLocaleLowerCase();
  const found = useMemo(() => {
    if (!q) return [];
    const seen = new Set<string>();
    const out: { p: CompiledProduct; section: CompiledSection }[] = [];
    for (const section of menu.menu.sections)
      for (const i of [...section.items].sort((a, b) => a.sort - b.sort)) {
        const p = menu.products[i.product_id];
        if (!p || seen.has(p.id) || !guestOrderable(p) || !p.name.toLocaleLowerCase().includes(q)) continue;
        seen.add(p.id);
        out.push({ p, section });
      }
    return out;
  }, [menu, q]);

  const basketCount = basketItems.reduce((n, i) => n + i.quantity, 0);
  const myRounds = orderView?.rounds.filter((r) => r.mine) ?? [];
  const latest = myRounds[myRounds.length - 1];
  const tableHasLines = (orderView?.lines.length ?? 0) > 0;

  const renderItems = (section: CompiledSection) =>
    [...section.items]
      .sort((a, b) => a.sort - b.sort)
      .map((i) => menu.products[i.product_id])
      .filter(guestOrderable)
      .map((p) => {
        const { state, reason } = itemState(p, section, canOrder);
        const note = p.cap_remaining != null && p.cap_remaining > 0 && p.cap_remaining <= 5 ? `Only ${p.cap_remaining} left today` : null;
        return <MenuItemRow key={p.id} name={p.name} description={p.description} price={p.price} state={state} reason={reason} note={note} inBasket={inBasket.get(p.id)} onPress={() => onOpenItem(p.id)} />;
      });

  const brandRow = (
    <header className="flex items-start justify-between gap-3 px-4 pt-[max(20px,env(safe-area-inset-top))] pb-3">
      <div className="flex min-w-0 items-center gap-3">
        {menu.brand.logo_url ? <img src={menu.brand.logo_url} alt="" className="size-11 shrink-0 rounded-tile object-contain" /> : null}
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium text-ink-3">{session.outlet.name}</p>
          <h1 tabIndex={-1} className="truncate font-display text-[26px] leading-tight font-semibold tracking-tight text-ink outline-none">
            {menu.brand.name}
          </h1>
        </div>
      </div>
      <AriaButton
        onPress={onOurTable}
        aria-label={`Table ${session.table.name}: see everything the table has ordered`}
        className="press relative mt-1 flex h-11 shrink-0 items-center gap-2 rounded-full border border-rule-strong bg-surface px-4 text-[14.5px] font-medium text-ink outline-none transition-colors duration-[120ms] data-[hovered]:bg-surface-2 data-[pressed]:bg-surface-2 data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus"
      >
        <Icon icon={ReceiptText} size={18} />
        <span className="whitespace-nowrap">Table {session.table.name}</span>
        {tableHasLines ? <span aria-hidden className="absolute -top-0.5 -right-0.5 size-3 rounded-full border-2 border-surface bg-brand-accent" /> : null}
      </AriaButton>
    </header>
  );

  return (
    <>
      {brandRow}
      {!canOrder ? <StaffBanner className="mx-4 mb-3" onCheck={onCheckAgain} /> : null}
      {latest || tableHasLines ? (
        <button type="button" onClick={onStatus} className="press mx-4 mb-3 flex min-h-12 w-[calc(100%-32px)] items-center justify-between gap-3 rounded-sheet bg-surface-2 px-4 text-left text-[15px] font-medium text-ink transition-colors duration-[120ms] active:bg-surface-3">
          <span className="min-w-0 truncate">{latest ? `Your order · Sent ${clock(latest.submitted_at)}` : "See what the table has ordered"}</span>
          <ChevronRight size={20} className="shrink-0 text-ink-2" aria-hidden />
        </button>
      ) : null}

      {/* The one sticky bar: search, Call staff where the thumb finds it, then the section chips; searching, the field. */}
      <div ref={headerRef} className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-rule-subtle bg-surface/95 pl-4 backdrop-blur-md">
        {searching ? (
          <SearchField aria-label="Search the menu" value={query} onChange={setQuery} onClear={() => setQuery("")} autoFocus className="flex min-w-0 flex-1 items-center gap-2 pr-2">
            <span className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-full bg-surface-2 px-4">
              <Icon icon={Search} size={18} className="shrink-0 text-ink-3" />
              <Input placeholder="Search the menu" className="min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-none placeholder:text-ink-3 [&::-webkit-search-cancel-button]:hidden" />
            </span>
            <AriaButton
              onPress={() => {
                setQuery("");
                setSearching(false);
              }}
              aria-label="Close search"
              className="press flex size-11 shrink-0 items-center justify-center rounded-full text-ink-2 outline-none data-[hovered]:bg-surface-2 data-[pressed]:bg-surface-2 data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus"
            >
              <Icon icon={X} size={20} />
            </AriaButton>
          </SearchField>
        ) : (
        <>
        <AriaButton
          onPress={() => setSearching(true)}
          aria-label="Search the menu"
          className="press flex size-11 shrink-0 items-center justify-center rounded-full bg-surface-2 text-ink outline-none transition-colors duration-[120ms] data-[hovered]:bg-surface-3 data-[pressed]:bg-surface-3 data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus"
        >
          <Icon icon={Search} size={18} />
        </AriaButton>
        <AriaButton
          onPress={onCallStaff}
          className="press flex h-11 shrink-0 items-center gap-2 rounded-full bg-surface-2 px-4 text-[14.5px] font-medium text-ink outline-none transition-colors duration-[120ms] data-[hovered]:bg-surface-3 data-[pressed]:bg-surface-3 data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus"
        >
          <Icon icon={ConciergeBell} size={18} />
          <span className="whitespace-nowrap">Call staff</span>
        </AriaButton>
        {groups.length > 1 ? (
          <>
            <span aria-hidden className="h-6 w-px shrink-0 bg-rule" />
            <ScrollTabs tabs={groups.map((g) => ({ id: g.section.id, label: g.section.name }))} selectedId={selected} onSelect={jumpTo} className="min-w-0 flex-1 pr-4" />
          </>
        ) : null}
        </>
        )}
      </div>

      <main className="w-full pb-32">
        {searching && q ? (
          <section aria-label="Search results">
            {found.length === 0 ? <p className="px-4 py-12 text-center text-[15px] text-ink-2">Nothing on the menu matches &ldquo;{query.trim()}&rdquo;.</p> : null}
            <div className="flex flex-col divide-y divide-rule-subtle">
              {found.map(({ p, section }) => {
                const { state, reason } = itemState(p, section, canOrder);
                return <MenuItemRow key={p.id} name={p.name} description={p.description} price={p.price} state={state} reason={reason} inBasket={inBasket.get(p.id)} onPress={() => onOpenItem(p.id)} />;
              })}
            </div>
          </section>
        ) : null}
        {searching && q ? null : groups.length === 0 ? <p className="px-4 py-16 text-center text-[15px] text-ink-2">The menu is empty right now. Ask a member of staff.</p> : null}
        {(searching && q ? [] : groups).map(({ section, children }) => (
          <section key={section.id} id={`section-${section.id}`} aria-labelledby={`heading-${section.id}`} style={{ scrollMarginTop: headerHeight }}>
            <h2 id={`heading-${section.id}`} className="px-4 pt-6 pb-1 font-display text-[19px] font-semibold tracking-tight text-ink">
              {section.name}
            </h2>
            {!section.available_now ? <p className="px-4 text-caption text-ink-3">Not available right now</p> : null}
            <div className="flex flex-col divide-y divide-rule-subtle">{renderItems(section)}</div>
            {children.map((sub) => (
              <div key={sub.id} aria-labelledby={`heading-${sub.id}`} role="group">
                <h3 id={`heading-${sub.id}`} className="px-4 pt-5 pb-1 font-display text-[16px] font-semibold tracking-tight text-ink">
                  {sub.name}
                </h3>
                {!sub.available_now ? <p className="px-4 text-caption text-ink-3">Not available right now</p> : null}
                <div className="flex flex-col divide-y divide-rule-subtle">{renderItems(sub)}</div>
              </div>
            ))}
          </section>
        ))}
        <div className="mx-4 mt-8 flex flex-col gap-1 rounded-sheet bg-surface-2 px-4 py-3.5 text-[13.5px] leading-relaxed text-ink-2">
          <p>{billNote(orderView?.totals?.tax_mode)}</p>
          <p>Pay at the counter or ask your server for the bill.</p>
        </div>
      </main>

      {canOrder && basketCount > 0 ? <BasketBar count={basketCount} onPress={onReview} /> : null}
    </>
  );
}
