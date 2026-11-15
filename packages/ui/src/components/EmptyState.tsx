import { Inbox, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import { Icon } from "./Icon";

export type EmptyStateProps = {
  /** One line, noun first: "Nothing waiting", "No outlets yet". */
  title: ReactNode;
  /** What to do next, in one line: "Tap Add outlet to create the first one." */
  hint?: ReactNode;
  action?: ReactNode;
  /** `quiet` is the Today-page treatment: small, secondary, no box. `centred` is an icon over one secondary
   * sentence in the middle of the space, for an empty list, rail or table. */
  variant?: "quiet" | "panel" | "centred";
  /** Shown above the title in the `centred` variant (decorative). */
  icon?: LucideIcon;
  className?: string;
};

export function EmptyState({ title, hint, action, variant = "panel", icon = Inbox, className }: EmptyStateProps) {
  // One empty state across the back office: an icon over one secondary sentence, centred in its space. The
  // `quiet` one (inside a Today panel) is the same, only with less room around it.
  return (
    <div className={cx("flex flex-col items-center justify-center gap-2 px-6 text-center", variant === "quiet" ? "py-6" : "py-10", className)}>
      <Icon icon={icon} size={24} className="mb-1 text-ink-3" />
      <p className="max-w-[36ch] text-[15px] leading-[22px] text-ink-2">{title}</p>
      {hint ? <p className="max-w-[36ch] text-caption text-ink-3">{hint}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
