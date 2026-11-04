import type { ReactNode } from "react";
import { cx } from "../lib/cx";

export type EmptyStateProps = {
  /** One line, noun first: "Nothing waiting", "No outlets yet". */
  title: ReactNode;
  /** What to do next, in one line: "Tap Add outlet to create the first one." */
  hint?: ReactNode;
  action?: ReactNode;
  /** `quiet` is the Today-page treatment: small, secondary, no box. */
  variant?: "quiet" | "panel";
  className?: string;
};

export function EmptyState({ title, hint, action, variant = "panel", className }: EmptyStateProps) {
  if (variant === "quiet") {
    return (
      <div className={cx("py-3 text-ink-2", className)}>
        <p className="text-body">{title}</p>
        {hint ? <p className="text-caption mt-0.5">{hint}</p> : null}
        {action ? <div className="mt-3">{action}</div> : null}
      </div>
    );
  }
  return (
    <div className={cx("flex flex-col items-start gap-1 rounded-tile hairline border-dashed px-6 py-8", className)}>
      <p className="text-heading text-ink">{title}</p>
      {hint ? <p className="text-body text-ink-2">{hint}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
