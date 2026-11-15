"use client";

import { KeyRound, type LucideIcon } from "lucide-react";
import { cx } from "../lib/cx";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";

export type DockAction = {
  id: string;
  /** A verb with its object: "Send 2", "Pay $54.43", "Hold", "Discount". */
  label: string;
  onPress: () => void;
  isDisabled?: boolean;
  isPending?: boolean;
  /** Longer accessible name when the label is terse ("Send 2 to kitchen"). */
  ariaLabel?: string;
  /** Shows the approval badge. */
  needsApproval?: boolean;
  /** The badge's words, naming the least role that may approve: "Cashier approval" (default "Manager approval"). */
  approvalLabel?: string;
  /** This action changes the register; while offline it is disabled and labelled "Offline". */
  mutates?: boolean;
  /** A small icon before the label (Hold, Bill). */
  icon?: LucideIcon;
  /** An icon after the label (Send's arrow). */
  trailingIcon?: LucideIcon;
};

export type ActionDockProps = {
  primary: DockAction;
  secondaries?: DockAction[];
  /** Disconnected: mutating buttons read "Offline". */
  offline?: boolean;
  className?: string;
};

/**
 * The action dock: always the bottom 72pt, one row, the primary action bottom right. In a narrow order column
 * the secondaries keep their icons and their names go to screen readers only, so the row never wraps.
 */
export function ActionDock({ primary, secondaries = [], offline, className }: ActionDockProps) {
  // A crowded row (three secondaries, or an approval chip to carry) shows the secondaries as icons whatever the width;
  // a narrow column (under 360px) does so always. Their names stay for screen readers, and the row still wraps as a
  // last resort, so the primary action is never cut off.
  const crowded = secondaries.length >= 3 || [primary, ...secondaries].some((a) => a.needsApproval && !(offline && a.mutates !== false));
  // Two secondaries keep their names in the 1024-wide order column (about 330px of dock); only a narrower one drops them (B notes).
  const iconOnly = crowded ? "sr-only" : secondaries.length <= 2 ? "@max-[300px]:sr-only" : "@max-[360px]:sr-only";
  const render = (a: DockAction, variant: "primary" | "secondary") => {
    const blocked = offline && a.mutates !== false;
    return (
      <Button
        key={a.id}
        variant={variant === "primary" ? "primary" : "quiet"}
        size={variant === "primary" ? "lg" : "md"}
        onPress={a.onPress}
        isDisabled={a.isDisabled || blocked}
        isPending={a.isPending}
        aria-label={blocked ? `${a.ariaLabel ?? a.label} (offline)` : a.ariaLabel}
        className={cx("min-h-14 shrink-0 text-center", variant === "primary" ? "ml-auto min-w-fit flex-1 px-5 text-[17px]" : "bg-surface-2! px-3.5 data-[hovered]:bg-surface-3! data-[pressed]:bg-surface-3! data-[disabled]:bg-surface-2! @max-[360px]:px-3", crowded && variant === "secondary" && a.icon && "px-3")}
      >
        {/* The label keeps to one line ("Pay $40.47"); when the dock is too narrow the button moves to its own row instead.
            The approval badge sits under the label, inside the pill, rather than wrapping against its edge. */}
        <span className="flex items-center gap-2 whitespace-nowrap">
          {a.icon && !blocked ? <Icon icon={a.icon} size={18} className="opacity-80" /> : null}
          <span className={variant === "secondary" && a.icon && !blocked ? iconOnly : undefined}>{blocked ? "Offline" : a.label}</span>
          {a.trailingIcon && !blocked ? <Icon icon={a.trailingIcon} size={18} /> : null}
        </span>
        {/* The approval on the same line as the label, as a small key and the role ("Manager"), so the pill never wraps;
            on the dark primary pill it is a light chip, legible in both themes. */}
        {a.needsApproval && !blocked ? (
          <span className={cx("inline-flex items-center gap-1 rounded-chip px-1.5 text-[12px] leading-[20px] font-medium whitespace-nowrap", variant === "primary" ? "bg-on-primary/15 text-on-primary" : "bg-status-bill-tint text-status-bill")}>
            <Icon icon={KeyRound} size={12} />
            {/* On a crowded row a secondary's chip is the key alone; the role is still read out. */}
            <span className={variant === "secondary" && crowded ? "sr-only" : undefined}>{(a.approvalLabel ?? "Manager approval").replace(/ approval$/, "")}</span>
            <span className="sr-only"> approval</span>
          </span>
        ) : null}
      </Button>
    );
  };
  return (
    <div className={cx("@container shrink-0 border-t border-rule bg-surface", className)}>
      <div className="flex min-h-[80px] flex-wrap items-center gap-2 px-3 py-3" role="toolbar" aria-label="Order actions">
        {secondaries.map((s) => render(s, "secondary"))}
        {render(primary, "primary")}
      </div>
    </div>
  );
}
