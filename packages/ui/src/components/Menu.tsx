"use client";

import type { ReactNode } from "react";
import {
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  MenuTrigger,
  Popover,
  Separator,
  type MenuItemProps as AriaMenuItemProps,
  type MenuProps as AriaMenuProps,
  type PopoverProps,
} from "react-aria-components";
import { cx } from "../lib/cx";
import { listItemClass } from "./Select";

export { MenuTrigger };

export type MenuProps<T extends object> = Omit<AriaMenuProps<T>, "className"> & {
  className?: string;
  placement?: PopoverProps["placement"];
  /** Minimum width of the popover; defaults to the trigger width. */
  minWidth?: number;
};

/** A popover menu for the user menu and row actions. Pair with `MenuTrigger`. */
export function Menu<T extends object>({ className, placement = "bottom end", minWidth, ...rest }: MenuProps<T>) {
  return (
    <Popover
      placement={placement}
      offset={4}
      className="min-w-(--trigger-width) rounded-tile bg-surface hairline shadow-sheet outline-none data-[entering]:animate-rise-in data-[exiting]:animate-rise-out"
      style={minWidth ? { minWidth } : undefined}
    >
      <AriaMenu {...rest} className={cx("max-h-[min(60vh,420px)] overflow-auto p-1 outline-none", className)} />
    </Popover>
  );
}

export type MenuItemProps = Omit<AriaMenuItemProps, "className" | "children"> & {
  children: ReactNode;
  /** Secondary text to the right ("Day", "Service"). */
  detail?: ReactNode;
  tone?: "default" | "destructive";
  className?: string;
};

export function MenuItem({ children, detail, tone = "default", className, ...rest }: MenuItemProps) {
  return (
    <AriaMenuItem {...rest} className={cx(listItemClass, tone === "destructive" && "text-status-alert", className)}>
      <span className="min-w-0 truncate">{children}</span>
      {detail ? <span className="shrink-0 text-caption text-ink-2">{detail}</span> : null}
    </AriaMenuItem>
  );
}

export function MenuSeparator() {
  return <Separator className="my-1 hairline-t" />;
}
