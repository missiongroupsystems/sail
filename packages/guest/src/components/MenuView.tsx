"use client";

import { BrandButton, MenuItemRow, ScrollTabs, type MenuItemState, useLocale } from "@sail/ui";
import { ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BasketItem } from "@/lib/basket";
import type { CompiledMenu, CompiledProduct, CompiledSection, GuestSession, OrderView } from "@/lib/types";
import { BasketBar } from "./BasketBar";
import { StaffBanner } from "./StaffBanner";

export type MenuViewProps = {
  session: GuestSession;
  menu: CompiledMenu;
  canOrder: boolean;
  basketItems: BasketItem[];
  orderView: OrderView | null;
  onOpenItem: (productId: string) => void;
  onReview: () => void;
  onCallStaff: () => void;
  onStatus: () => void;
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

/** The landing screen (design 4.11): brand, table, sticky section tabs and the typography-led menu. */
export function MenuView({ session, menu, canOrder, basketItems, orderView, onOpenItem, onReview, onCallStaff, onStatus }: MenuViewProps) {
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
  const headerRef = useRef<HTMLElement>(null);
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

  return (
    <>
      <header ref={headerRef} className="sticky top-0 z-20 bg-bg/95 backdrop-blur-sm hairline-b">
        <div className="mx-auto w-full max-w-[560px]">
          <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-[max(12px,env(safe-area-inset-top))]">
            <div className="flex min-w-0 items-center gap-3">
              {menu.brand.logo_url ? <img src={menu.brand.logo_url} alt="" className="size-11 shrink-0 rounded-tile object-contain" /> : null}
              <div className="min-w-0">
                <p className="text-caption text-ink-2">Table {session.table.name}</p>
                <h1 tabIndex={-1} className="truncate font-display text-heading text-ink outline-none">
                  {menu.brand.name}
                </h1>
              </div>
            </div>
            <BrandButton variant="quiet" onPress={onCallStaff} className="-mr-2 shrink-0">
              Call staff
            </BrandButton>
          </div>
          {!canOrder ? <StaffBanner className="mx-4 mb-2" /> : null}
          {latest || tableHasLines ? (
            <button type="button" onClick={onStatus} className="press mx-4 mb-2 flex min-h-12 w-[calc(100%-32px)] items-center justify-between gap-3 rounded-tile bg-surface-2 px-4 text-left text-body text-ink">
              <span className="min-w-0 truncate">{latest ? `Your order · Sent ${clock(latest.submitted_at)}` : "See what the table has ordered"}</span>
              <ChevronRight size={20} className="shrink-0 text-ink-2" aria-hidden />
            </button>
          ) : null}
          {groups.length > 1 ? <ScrollTabs tabs={groups.map((g) => ({ id: g.section.id, label: g.section.name }))} selectedId={selected} onSelect={jumpTo} /> : null}
        </div>
      </header>

      <main className="mx-auto w-full max-w-[560px] px-4 pb-32">
        {groups.length === 0 ? <p className="py-12 text-body text-ink-2">The menu is empty right now. Ask a member of staff.</p> : null}
        {groups.map(({ section, children }) => (
          <section key={section.id} id={`section-${section.id}`} aria-labelledby={`heading-${section.id}`} style={{ scrollMarginTop: headerHeight }}>
            <h2 id={`heading-${section.id}`} className="pb-1 pt-8 font-display text-title text-ink">
              {section.name}
            </h2>
            {!section.available_now ? <p className="text-caption text-ink-2">Not available right now</p> : null}
            {renderItems(section)}
            {children.map((sub) => (
              <div key={sub.id} aria-labelledby={`heading-${sub.id}`} role="group">
                <h3 id={`heading-${sub.id}`} className="pb-1 pt-6 font-display text-heading text-ink">
                  {sub.name}
                </h3>
                {!sub.available_now ? <p className="text-caption text-ink-2">Not available right now</p> : null}
                {renderItems(sub)}
              </div>
            ))}
          </section>
        ))}
        <p className="pt-10 text-caption text-ink-2">Prices are menu prices. Service charge and any discounts are added to your bill.</p>
        <p className="pt-2 text-caption text-ink-2">Pay at the counter or ask your server for the bill.</p>
      </main>

      {canOrder && basketCount > 0 ? <BasketBar count={basketCount} onPress={onReview} /> : null}
    </>
  );
}
