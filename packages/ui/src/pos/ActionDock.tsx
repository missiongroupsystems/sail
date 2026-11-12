"use client";

import { cx } from "../lib/cx";
import { Button } from "../components/Button";

export type DockAction = {
  id: string;
  /** A verb with its object: "Send 2 ▸", "Pay $54.43 ▸", "Hold", "Discount". */
  label: string;
  onPress: () => void;
  isDisabled?: boolean;
  isPending?: boolean;
  /** Longer accessible name when the label is terse ("Send 2 to kitchen"). */
  ariaLabel?: string;
  /** Shows the "Manager approval" badge. */
  needsApproval?: boolean;
  /** This action changes the register; while offline it is disabled and labelled "Offline". */
  mutates?: boolean;
};

export type ActionDockProps = {
  primary: DockAction;
  secondaries?: DockAction[];
  /** Disconnected: mutating buttons read "Offline". */
  offline?: boolean;
  className?: string;
};

/** The action dock: always the bottom 72pt, one primary action bottom right. */
export function ActionDock({ primary, secondaries = [], offline, className }: ActionDockProps) {
  const render = (a: DockAction, variant: "primary" | "secondary") => {
    const blocked = offline && a.mutates !== false;
    return (
      <Button
        key={a.id}
        variant={variant}
        size={variant === "primary" ? "lg" : "md"}
        onPress={a.onPress}
        isDisabled={a.isDisabled || blocked}
        isPending={a.isPending}
        aria-label={blocked ? `${a.ariaLabel ?? a.label} (offline)` : a.ariaLabel}
        className={cx("min-h-16 flex-wrap text-center", variant === "primary" && "flex-1 text-heading")}
      >
        {/* The dock is the order column's width: a long total or the approval badge wraps inside the button instead of pushing it off the screen. */}
        <span className="whitespace-normal text-balance">{blocked ? "Offline" : a.label}</span>
        {a.needsApproval && !blocked ? <span className="rounded-chip bg-[color-mix(in_srgb,var(--status-bill)_14%,transparent)] px-2 text-caption text-status-bill">Manager approval</span> : null}
      </Button>
    );
  };
  return (
    <div className={cx("flex h-[72px] shrink-0 items-center gap-2 px-3 hairline-t bg-surface", className)} role="toolbar" aria-label="Order actions">
      {secondaries.map((s) => render(s, "secondary"))}
      {render(primary, "primary")}
    </div>
  );
}
