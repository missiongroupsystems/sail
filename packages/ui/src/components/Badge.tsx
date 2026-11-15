import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import { AgentMark, Icon } from "./Icon";

export type BadgeTone = "neutral" | "agent" | "alert" | "paid" | "sent" | "seated" | "bill";

const tones: Record<BadgeTone, string> = {
  neutral: "bg-surface-2 text-ink-2",
  agent: "bg-agent-tint text-agent",
  alert: "bg-status-alert-tint text-status-alert",
  paid: "bg-status-paid-tint text-status-paid",
  sent: "bg-status-sent-tint text-status-sent",
  seated: "bg-status-seated-tint text-status-seated",
  bill: "bg-status-bill-tint text-status-bill",
};

export type BadgeProps = {
  tone?: BadgeTone;
  /** A count renders in tabular figures; text renders as a chip. */
  children: ReactNode;
  /** A small icon before the word (status is never colour alone). */
  icon?: LucideIcon;
  className?: string;
};

/** A quiet chip for counts and short labels. Colour carries meaning, never decoration. */
export function Badge({ tone = "neutral", children, icon, className }: BadgeProps) {
  const isCount = typeof children === "number";
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-chip px-2 py-0.5 text-caption leading-[18px] font-medium whitespace-nowrap",
        isCount && "tabular min-w-5 justify-center",
        tones[tone],
        className,
      )}
    >
      {tone === "agent" && !isCount ? <AgentMark size={11} /> : icon ? <Icon icon={icon} size={12} /> : null}
      {children}
    </span>
  );
}

/**
 * One mapping for pricing-rule kinds wherever they appear as a pill (rules list, simulator, order drawer):
 * a fee is neutral, a discount wears the paid tint. Unknown kinds are neutral.
 */
export const KIND_TONE = { fee: "neutral", discount: "paid" } as const satisfies Record<string, BadgeTone>;

export function kindTone(kind: string): BadgeTone {
  return (KIND_TONE as Record<string, BadgeTone>)[kind] ?? "neutral";
}
