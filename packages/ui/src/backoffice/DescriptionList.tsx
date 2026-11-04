import type { ReactNode } from "react";
import { cx } from "../lib/cx";

export type DescriptionItem = { term: ReactNode; detail: ReactNode; numeric?: boolean };

export type DescriptionListProps = {
  items: DescriptionItem[];
  /** `rows` (default) is term left, detail right, hairline separated. `grid` lays pairs out in two columns. */
  layout?: "rows" | "grid";
  className?: string;
};

/** Facts about one thing (an order, a job, a rule), term and detail, in the register's words. */
export function DescriptionList({ items, layout = "rows", className }: DescriptionListProps) {
  if (layout === "grid") {
    return (
      <dl className={cx("grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2", className)}>
        {items.map((it, i) => (
          <div key={i} className="min-w-0">
            <dt className="text-caption text-ink-2">{it.term}</dt>
            <dd className={cx("text-body text-ink", it.numeric && "tabular")}>{it.detail}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <dl className={cx("flex flex-col", className)}>
      {items.map((it, i) => (
        <div key={i} className="flex items-baseline justify-between gap-4 py-2 hairline-b last:border-b-0">
          <dt className="shrink-0 text-body text-ink-2">{it.term}</dt>
          <dd className={cx("min-w-0 text-right text-body text-ink", it.numeric && "tabular")}>{it.detail}</dd>
        </div>
      ))}
    </dl>
  );
}

export type StatProps = { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: "default" | "alert" | "paid"; className?: string };

/** One count with its label, for summary rows ("Prices 48", "Rejected 3"). Not a KPI card. */
export function Stat({ label, value, hint, tone = "default", className }: StatProps) {
  return (
    <div className={cx("flex min-w-[96px] flex-col", className)}>
      <span className="text-caption text-ink-2">{label}</span>
      <span className={cx("tabular text-heading", tone === "alert" ? "text-status-alert" : tone === "paid" ? "text-status-paid" : "text-ink")}>{value}</span>
      {hint ? <span className="text-caption text-ink-2">{hint}</span> : null}
    </div>
  );
}
