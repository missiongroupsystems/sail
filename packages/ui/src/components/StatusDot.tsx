import type { ReactNode } from "react";
import { cx } from "../lib/cx";

/** Status hues from 7.3 plus `neutral` for "no state yet". Colour is never the only signal: a label is required. */
export type Status = "seated" | "sent" | "bill" | "paid" | "alert" | "neutral";

const dots: Record<Status, string> = {
  seated: "bg-status-seated",
  sent: "bg-status-sent",
  bill: "bg-status-bill",
  paid: "bg-status-paid",
  alert: "bg-status-alert",
  neutral: "bg-transparent ring-1 ring-inset ring-ink-2",
};

export type StatusDotProps = {
  status: Status;
  /** The word for the state: "Paired", "Archived", "Not printing". */
  label: ReactNode;
  className?: string;
  /** Secondary text colour for quiet rows; default inherits. */
  muted?: boolean;
};

export function StatusDot({ status, label, className, muted }: StatusDotProps) {
  return (
    <span className={cx("inline-flex items-center gap-2 whitespace-nowrap", muted && "text-ink-2", className)}>
      <span aria-hidden className={cx("inline-block size-2 shrink-0 rounded-full", dots[status])} />
      <span>{label}</span>
    </span>
  );
}
