import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import { AgentMark } from "./Icon";

export type BadgeTone = "neutral" | "agent" | "alert" | "paid" | "sent" | "seated" | "bill";

const tones: Record<BadgeTone, string> = {
  neutral: "bg-surface-2 text-ink-2",
  agent: "bg-[color-mix(in_srgb,var(--agent)_12%,transparent)] text-agent",
  alert: "bg-[color-mix(in_srgb,var(--status-alert)_12%,transparent)] text-status-alert",
  paid: "bg-[color-mix(in_srgb,var(--status-paid)_12%,transparent)] text-status-paid",
  sent: "bg-[color-mix(in_srgb,var(--status-sent)_14%,transparent)] text-status-sent",
  seated: "bg-[color-mix(in_srgb,var(--status-seated)_12%,transparent)] text-status-seated",
  bill: "bg-[color-mix(in_srgb,var(--status-bill)_12%,transparent)] text-status-bill",
};

export type BadgeProps = {
  tone?: BadgeTone;
  /** A count renders in tabular figures; text renders as a chip. */
  children: ReactNode;
  className?: string;
};

/** A quiet chip for counts and short labels. Colour carries meaning, never decoration. */
export function Badge({ tone = "neutral", children, className }: BadgeProps) {
  const isCount = typeof children === "number";
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-chip px-2 py-0.5 text-caption leading-[18px] whitespace-nowrap",
        isCount && "tabular min-w-5 justify-center",
        tones[tone],
        className,
      )}
    >
      {tone === "agent" && !isCount ? <AgentMark size={11} /> : null}
      {children}
    </span>
  );
}
