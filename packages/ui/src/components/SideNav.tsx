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
  /** Rendered above the items (the scope picker). */
  header?: ReactNode;
  /** Rendered below the items (version, help). */
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

/**
 * The back-office left navigation (3.2): every section is always present, so
 * nothing is ever a gap. 240px wide with labels; a 64px icon rail when collapsed.
 */
export function SideNav({ items, currentPath, LinkComponent = Anchor, collapsed = "auto", header, footer, className, ...rest }: SideNavProps) {
  const labelClass = collapsed === "auto" ? "max-[1099px]:hidden" : collapsed ? "hidden" : "";
  const widthClass = collapsed === "auto" ? "w-60 max-[1099px]:w-16" : collapsed ? "w-16" : "w-60";
  return (
    <nav
      aria-label={rest["aria-label"] ?? "Sections"}
      className={cx("flex h-full shrink-0 flex-col gap-2 hairline-r bg-bg px-2 py-3", widthClass, className)}
    >
      {header ? <div className="px-0 pb-1">{header}</div> : null}
      <ul className="flex flex-1 flex-col gap-0.5">
        {items.map((item) => {
          const active = isActive(currentPath, item);
          return (
            <li key={item.href}>
              <LinkComponent
                href={item.href}
                aria-current={active ? "page" : undefined}
                aria-label={item.label}
                title={item.label}
                className={cx(
                  "press flex min-h-11 items-center gap-3 rounded-tile px-3 text-line no-underline outline-none",
                  "hover:bg-surface-2 active:scale-[0.99]",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-status-seated",
                  active ? "bg-surface-2 text-ink" : "text-ink-2 hover:text-ink",
                  collapsed === "auto" ? "max-[1099px]:justify-center max-[1099px]:px-0" : collapsed ? "justify-center px-0" : "",
                )}
              >
                <Icon icon={item.icon} size={20} />
                <span className={cx("min-w-0 flex-1 truncate", labelClass)}>{item.label}</span>
                {item.badge !== undefined && item.badge !== 0 ? (
                  <Badge tone={item.badgeTone ?? "neutral"} className={labelClass}>
                    {item.badge}
                  </Badge>
                ) : null}
              </LinkComponent>
            </li>
          );
        })}
      </ul>
      {footer ? <div className={cx("px-3 pt-2 text-caption text-ink-2", labelClass)}>{footer}</div> : null}
    </nav>
  );
}
