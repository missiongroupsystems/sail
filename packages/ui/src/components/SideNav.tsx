import type { LucideIcon } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { cx } from "../lib/cx";
import { Badge, type BadgeTone } from "./Badge";
import { Icon } from "./Icon";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** A count or short marker ("3", "◭ 3"). */
  badge?: number | string;
  badgeTone?: BadgeTone;
  /** `prefix` (default) marks the item active for nested routes too. */
  match?: "exact" | "prefix";
};

export type NavLinkProps = {
  href: string;
  className?: string;
  children: ReactNode;
  "aria-current"?: "page";
  "aria-label"?: string;
  title?: string;
};

export type SideNavProps = {
  items: NavItem[];
  currentPath: string;
  /** Your router's link (Next `Link`); defaults to a plain anchor. */
  LinkComponent?: ComponentType<NavLinkProps>;
  /**
   * `auto` (default) shows labels at 1100px and wider and collapses to icons below,
   * matching the back-office grid (7.2). `true`/`false` force a state.
   */
  collapsed?: boolean | "auto";
  /** Rendered above the items (the wordmark and the scope picker). */
  header?: ReactNode;
  /**
   * Rendered below the items (Open the POS, the user menu). Shown in both states: give its
   * rows `sideNavRowClass(collapsed)` and wrap their labels in `sideNavLabelClass(collapsed)`.
   */
  footer?: ReactNode;
  "aria-label"?: string;
  className?: string;
};

function isActive(current: string, item: NavItem): boolean {
  if (current === item.href) return true;
  if (item.match === "exact") return false;
  return current.startsWith(item.href.endsWith("/") ? item.href : `${item.href}/`);
}

function Anchor({ href, children, ...rest }: NavLinkProps) {
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}

/** Hides a label when the rail is collapsed. */
export function sideNavLabelClass(collapsed: boolean | "auto" = "auto"): string {
  return collapsed === "auto" ? "max-[1099px]:sr-only" : collapsed ? "sr-only" : "";
}

/**
 * The look of one row in the rail: 40px, 10px corners, 14px secondary ink, a grey fill on hover.
 * Exported so the footer's own links and buttons sit in the same column as the sections.
 */
export function sideNavRowClass(collapsed: boolean | "auto" = "auto", active = false): string {
  return cx(
    "press flex h-10 w-full items-center gap-2.5 rounded-[10px] px-3 text-left text-[14px] no-underline outline-none transition-colors duration-[120ms]",
    "hover:bg-surface-2 active:bg-surface-2",
    "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus",
    "data-[hovered]:bg-surface-2 data-[pressed]:bg-surface-2 data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-[-2px] data-[focus-visible]:outline-focus",
    active ? "bg-surface-3 font-medium text-ink hover:bg-surface-3" : "text-ink-2 hover:text-ink",
    collapsed === "auto" ? "max-[1099px]:justify-center max-[1099px]:px-0" : collapsed ? "justify-center px-0" : "",
  );
}

/**
 * The back-office left navigation (3.2): every section is always present, so
 * nothing is ever a gap. A 240px rail on the sunken grey with a subtle edge; a 64px icon rail
 * when collapsed (below 1100px, phones included).
 */
export function SideNav({ items, currentPath, LinkComponent = Anchor, collapsed = "auto", header, footer, className, ...rest }: SideNavProps) {
  const labelClass = sideNavLabelClass(collapsed);
  const widthClass = collapsed === "auto" ? "w-60 max-[1099px]:w-16" : collapsed ? "w-16" : "w-60";
  return (
    <div className={cx("flex h-full shrink-0 flex-col border-r border-rule-subtle bg-bg", widthClass, className)}>
      {header ? <div className={cx("flex flex-col gap-3 px-4 pt-4 pb-2", collapsed === "auto" ? "max-[1099px]:px-2" : collapsed ? "px-2" : "")}>{header}</div> : null}
      <nav aria-label={rest["aria-label"] ?? "Sections"} className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <ul className="flex flex-col">
          {items.map((item) => {
            const active = isActive(currentPath, item);
            return (
              <li key={item.href}>
                <LinkComponent href={item.href} aria-current={active ? "page" : undefined} aria-label={item.label} title={item.label} className={sideNavRowClass(collapsed, active)}>
                  <Icon icon={item.icon} size={15} className={active ? "text-ink" : "text-ink-3"} />
                  <span className={cx("min-w-0 flex-1 truncate", labelClass)}>{item.label}</span>
                  {item.badge !== undefined && item.badge !== 0 ? (
                    <Badge tone={item.badgeTone ?? "neutral"} className={collapsed === "auto" ? "max-[1099px]:hidden" : collapsed ? "hidden" : ""}>
                      {item.badge}
                    </Badge>
                  ) : null}
                </LinkComponent>
              </li>
            );
          })}
        </ul>
      </nav>
      {footer ? <div className="flex flex-col px-2 pt-2 pb-3">{footer}</div> : null}
    </div>
  );
}
