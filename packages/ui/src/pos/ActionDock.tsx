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
  /** This action changes the register; while offline it is disabled (its label stays). Default true. */
  mutates?: boolean;
  /** A small icon before the label (Hold, Bill). */
  icon?: LucideIcon;
  /** An icon after the label (Send's arrow). */
  trailingIcon?: LucideIcon;
};

export type ActionDockProps = {
  primary: DockAction;
  secondaries?: DockAction[];
  /** Disconnected: buttons that change the register are disabled, with their labels. */
  offline?: boolean;
  className?: string;
};

/**
 * The action dock: always the bottom 72pt, one row, the primary action bottom right. In a narrow order column
 * the secondaries show icons only and their names go to screen readers; a crowded row keeps the names and drops the icons.
 */
export function ActionDock({ primary, secondaries = [], offline, className }: ActionDockProps) {
  // A crowded row (three secondaries, or an approval chip to carry) drops the secondaries' icons and keeps their names, so
  // Hold reads as Hold in every state of the order (final visual review 1). Only a narrow column (under 360px) shows icons
  // alone, with the names kept for screen readers; the row still wraps as a last resort, so the primary is never cut off.
  const crowded = secondaries.length >= 3 || [primary, ...secondaries].some((a) => a.needsApproval && !(offline && a.mutates !== false));
  // Two secondaries keep their names in the 1024-wide order column (about 330px of dock); only a narrower one drops them (B notes).
  const iconOnly = secondaries.length <= 2 && !crowded ? "@max-[300px]:sr-only" : "@max-[360px]:sr-only";
  const iconClass = (variant: "primary" | "secondary") => cx("opacity-80", crowded && variant === "secondary" && "hidden @max-[360px]:block");
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
        className={cx("min-h-14 shrink-0 text-center", variant === "primary" ? "ml-auto min-w-fit flex-1 px-5 text-[17px]" : "bg-surface-2! px-3.5 data-[hovered]:bg-surface-3! data-[pressed]:bg-surface-3! data-[disabled]:bg-surface-2! @max-[360px]:px-3", crowded && variant === "secondary" && "px-3")}
      >
        {/* The label keeps to one line ("Pay $40.47"); when the dock is too narrow the button moves to its own row instead.
            The approval badge sits under the label, inside the pill, rather than wrapping against its edge. */}
        <span className="flex items-center gap-2 whitespace-nowrap">
          {/* Offline, each control keeps its own name and is simply off; the one offline state is the frame's banner
              (final review B-P14). */}
          {a.icon ? <Icon icon={a.icon} size={18} className={iconClass(variant)} /> : null}
          <span className={variant === "secondary" && a.icon ? iconOnly : undefined}>{a.label}</span>
          {a.trailingIcon ? <Icon icon={a.trailingIcon} size={18} /> : null}
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
