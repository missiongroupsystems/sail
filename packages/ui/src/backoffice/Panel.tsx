import type { ReactNode } from "react";
import { cx } from "../lib/cx";

export type PanelProps = {
  /** A noun: "Sales", "Payments", "Cash drawer". */
  title?: ReactNode;
  /** Right of the title: a count, a status pill, an action. */
  aside?: ReactNode;
  /** Heading level of the title. */
  as?: "h2" | "h3";
  children: ReactNode;
  /** `rows` pads the body for label/value rows (the default); `flush` leaves the body bare (a table, a list). */
  body?: "rows" | "flush";
  className?: string;
  id?: string;
};

/**
 * A white card with a 14px corner and a hairline: an optional header row (title, aside) over a
 * body. The report pages lay these out in two columns; Today and Printing use them for status.
 */
export function Panel({ title, aside, as: Tag = "h2", children, body = "rows", className, id }: PanelProps) {
  return (
    <section aria-labelledby={title && id ? id : undefined} className={cx("min-w-0 rounded-[14px] border border-rule bg-surface", className)}>
      {title != null ? (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-rule-subtle px-5 py-3.5">
          <Tag id={id} className="font-heading text-[16px] leading-[1.35] font-semibold tracking-[-0.01em] text-ink">
            {title}
          </Tag>
          {/* The aside wraps under the title on a phone rather than running into the card's edge. */}
          {aside != null ? <div className="flex min-w-0 items-center gap-2 text-[13px] text-ink-3">{aside}</div> : null}
        </div>
      ) : null}
      <div className={body === "rows" ? "px-5 py-3" : undefined}>{children}</div>
    </section>
  );
}

export type ValueRowsProps = {
  rows: { label: ReactNode; value: ReactNode; strong?: boolean; indent?: boolean; key?: string }[];
  className?: string;
};

/**
 * Label/value rows in a panel: label in secondary ink at left, value in ink at right with tabular
 * figures, no rules between rows. A strong row (a total) draws a rule above itself and sets both in
 * medium ink. A `dl` with one `div` per row.
 */
export function ValueRows({ rows, className }: ValueRowsProps) {
  return (
    <dl className={cx("flex flex-col", className)}>
      {rows.map((row, i) => (
        <div
          key={row.key ?? i}
          className={cx(
            "flex items-baseline justify-between gap-4 py-0.5 text-[13.5px] leading-5",
            row.strong && i > 0 && "mt-1.5 border-t border-rule-subtle pt-2.5",
            row.indent && "pl-4",
          )}
        >
          <dt className={cx("min-w-0", row.strong ? "font-medium text-ink" : "text-ink-2")}>{row.label}</dt>
          <dd className={cx("shrink-0 text-right tabular", row.strong ? "font-semibold text-ink" : "text-ink")}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export type SheetSectionProps = {
  /** A short noun, drawn small and upper case: "Totals", "Bills". */
  label: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
};

/** A labelled block inside a sheet or drawer: a 12px upper-case label in tertiary ink over its content. Space blocks with the parent's gap. */
export function SheetSection({ label, aside, children, className }: SheetSectionProps) {
  return (
    <section className={cx("flex flex-col gap-2", className)}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[12px] leading-4 font-medium tracking-[0.04em] text-ink-3 uppercase">{label}</h3>
        {aside != null ? <div className="flex items-center gap-2">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

export type GroupProps = { children: ReactNode; className?: string; "aria-label"?: string; role?: string };

/** A bordered group inside a sheet: a hairline box with 14px corners; children separated by hairlines. */
export function Group({ children, className, ...rest }: GroupProps) {
  return (
    <div {...rest} className={cx("min-w-0 divide-y divide-rule-subtle rounded-[14px] border border-rule bg-surface", className)}>
      {children}
    </div>
  );
}
