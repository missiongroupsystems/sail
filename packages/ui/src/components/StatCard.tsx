import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import { Icon } from "./Icon";

export type StatCardProps = {
  /** What the figure is: "Net sales", "Covers". */
  label: ReactNode;
  /** The figure as the register returned it, already formatted (a Money element or a count). */
  value: ReactNode;
  /** One quiet line under the figure: "12 orders", "since 4:00 am". */
  caption?: ReactNode;
  icon?: LucideIcon;
  /** `accent` is the one card a page leads with (ink fill); `alert` marks a figure that needs someone. */
  tone?: "default" | "accent" | "alert";
  className?: string;
};

/**
 * A figure on a white bordered card, flat (no shadow): a 13px label over the value in the heading face. The figure
 * is 26px and steps down to 20px when the card itself is narrow (a container query, so it follows the card, not the
 * window). Also exported as `StatTile`.
 */
export function StatCard({ label, value, caption, icon, tone = "default", className }: StatCardProps) {
  const accent = tone === "accent";
  return (
    <div
      className={cx(
        "@container flex min-w-0 flex-col gap-1.5 rounded-panel border px-4 py-4 sm:px-5",
        accent ? "border-transparent bg-primary text-on-primary" : "border-rule bg-surface text-ink",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p className={cx("text-[13px] leading-[18px]", accent ? "text-on-primary/80" : tone === "alert" ? "text-status-alert" : "text-ink-2")}>{label}</p>
        {icon ? <Icon icon={icon} size={16} className={accent ? "text-on-primary/70" : tone === "alert" ? "text-status-alert" : "text-ink-3"} /> : null}
      </div>
      {/* The figure takes the card's size, not the Money element's own. */}
      <p
        className={cx(
          "font-heading text-[20px] leading-none font-semibold tracking-[-0.02em] tabular *:text-[length:inherit]! *:leading-[inherit]! @[10rem]:text-[26px]",
          tone === "alert" && "text-status-alert",
        )}
      >
        {value}
      </p>
      {caption ? <p className={cx("text-[12.5px] leading-[18px]", accent ? "text-on-primary/80" : "text-ink-3")}>{caption}</p> : null}
    </div>
  );
}

/** The same card under the back office's earlier name. */
export const StatTile = StatCard;

const COLUMNS = { 3: "@2xl:grid-cols-3", 4: "@2xl:grid-cols-4", 6: "@2xl:grid-cols-3 @5xl:grid-cols-6" } as const;

export type StatTilesProps = { children: ReactNode; columns?: keyof typeof COLUMNS; className?: string };

/** A row of stat cards: four (or three, or six) across when there is room, two on a phone or in a narrow sheet. */
export function StatTiles({ children, columns = 4, className }: StatTilesProps) {
  return (
    <div className={cx("@container", className)}>
      <div className={cx("grid grid-cols-2 gap-3 sm:gap-4", COLUMNS[columns])}>{children}</div>
    </div>
  );
}
