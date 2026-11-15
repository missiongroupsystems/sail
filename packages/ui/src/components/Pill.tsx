import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import { Icon } from "./Icon";

export type PillTone = "neutral" | "seated" | "sent" | "bill" | "paid" | "alert" | "agent" | "inverse";

const tones: Record<PillTone, string> = {
  neutral: "bg-surface-2 text-ink-2",
  seated: "bg-status-seated-tint text-status-seated",
  sent: "bg-status-sent-tint text-status-sent",
  bill: "bg-status-bill-tint text-status-bill",
  paid: "bg-status-paid-tint text-status-paid",
  alert: "bg-status-alert-tint text-status-alert",
  agent: "bg-agent-tint text-agent",
  inverse: "bg-primary text-on-primary",
};

export type PillProps = {
  tone?: PillTone;
  /** An icon before the word; status is never colour alone. */
  icon?: LucideIcon;
  /** `md` is 28pt for a screen's own status, `sm` is 22pt for a row or a card. */
  size?: "sm" | "md";
  children: ReactNode;
  className?: string;
};

/** A status word on its tint: "Seated", "Cooking", "Paid". Not interactive; use Button for an action. */
export function Pill({ tone = "neutral", icon, size = "md", children, className }: PillProps) {
  return (
    <span
      className={cx(
        "inline-flex w-fit shrink-0 items-center gap-1.5 rounded-chip font-medium whitespace-nowrap",
        size === "md" ? "h-7 px-2.5 text-[13px]" : "h-[22px] px-2 text-[11.5px]",
        tones[tone],
        className,
      )}
    >
      {icon ? <Icon icon={icon} size={size === "md" ? 14 : 12} /> : null}
      {children}
    </span>
  );
}
