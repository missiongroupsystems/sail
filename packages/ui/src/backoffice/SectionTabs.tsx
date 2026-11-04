import type { ComponentType, ReactNode } from "react";
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

/** Secondary navigation under a page header: one row of underlined tabs, scrollable when narrow. */
export function SectionTabs({ tabs, currentPath, LinkComponent = Anchor, className, ...rest }: SectionTabsProps) {
  return (
    <nav aria-label={rest["aria-label"]} className={cx("-mx-1 flex gap-1 overflow-x-auto", className)}>
      {tabs.map((tab) => {
        const active = currentPath === tab.href || (tab.match !== "exact" && currentPath.startsWith(`${tab.href}/`));
        return (
          <LinkComponent
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cx(
              "press flex min-h-11 items-center gap-2 whitespace-nowrap border-b-2 px-3 text-line no-underline outline-none",
              "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-status-seated",
              active ? "border-ink text-ink" : "border-transparent text-ink-2 hover:text-ink",
            )}
          >
            {tab.label}
            {tab.badge !== undefined && tab.badge !== null ? <span className="text-caption text-ink-2">{tab.badge}</span> : null}
          </LinkComponent>
        );
      })}
    </nav>
  );
}
