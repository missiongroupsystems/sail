"use client";

import { useEffect, type ComponentType, type ReactNode } from "react";
import { useEdgeFade } from "../lib/use-edge-fade";
import { cx } from "../lib/cx";
import type { NavLinkProps } from "../components/SideNav";

export type SectionTab = { href: string; label: string; badge?: ReactNode; match?: "exact" | "prefix" };

export type SectionTabsProps = {
  tabs: SectionTab[];
  currentPath: string;
  LinkComponent?: ComponentType<NavLinkProps>;
  "aria-label": string;
  className?: string;
};

function Anchor({ href, children, ...rest }: NavLinkProps) {
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}

/**
 * Secondary navigation under a page header: a grey track with the current sub-section raised on a
 * white segment, the way the back office draws its filters. Scrolls sideways when narrow.
 */
export function SectionTabs({ tabs, currentPath, LinkComponent = Anchor, className, ...rest }: SectionTabsProps) {
  // On a phone the strip is wider than the screen: the current tab is scrolled into view, and an edge fades where more
  // tabs sit beyond it.
  const { ref: scroller, onScroll, fadeClass } = useEdgeFade<HTMLDivElement>([currentPath]);
  useEffect(() => {
    const el = scroller.current;
    const active = el?.querySelector<HTMLElement>('[aria-current="page"]');
    if (el && active && el.scrollWidth > el.clientWidth) el.scrollLeft = Math.max(0, active.offsetLeft - (el.clientWidth - active.offsetWidth) / 2);
    onScroll();
  }, [currentPath, scroller, onScroll]);
  return (
    <div ref={scroller} onScroll={onScroll} className={cx("relative max-w-full overflow-x-auto [scrollbar-width:none]", fadeClass, className)}>
      <nav aria-label={rest["aria-label"]} className="inline-flex h-9 items-center gap-0.5 rounded-[10px] bg-surface-2 p-0.5">
        {tabs.map((tab) => {
          const active = currentPath === tab.href || (tab.match !== "exact" && currentPath.startsWith(`${tab.href}/`));
          return (
            <LinkComponent
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={cx(
                "press flex h-8 items-center gap-1.5 whitespace-nowrap rounded-[8px] px-3 text-[13px] font-medium no-underline outline-none transition-colors duration-[120ms]",
                "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus",
                active ? "bg-surface text-ink shadow-segment" : "text-ink-2 hover:text-ink",
              )}
            >
              {tab.label}
              {tab.badge !== undefined && tab.badge !== null ? <span className="text-[12px] font-normal text-ink-3 tabular">{tab.badge}</span> : null}
            </LinkComponent>
          );
        })}
      </nav>
    </div>
  );
}
