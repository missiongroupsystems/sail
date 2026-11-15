import type { ReactNode } from "react";

/**
 * Page-level building blocks for the Menu, Floor & QR, Team, Settings and Audit pages, so their lists, sheets and
 * dialogs read as one grammar: a two-line table cell, an upper-case section label over a bordered group, and the
 * grey secondary pill used beside a sheet's primary action.
 */

/** Joins class names, dropping falsy values. */
function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * A secondary action in a sheet or dialog footer: a grey fill and no outline, next to the ink primary. Applied to a
 * `Button variant="secondary"` (the `!` wins over the variant's white fill and border).
 */
export const greyPill = "border-transparent! bg-surface-2! data-[hovered]:bg-surface-3! data-[pressed]:bg-surface-3!";

/** The same grey pill for an action that removes or archives: the word in the alert ink. */
export const greyPillAlert = `${greyPill} not-data-[disabled]:text-status-alert!`;

/** A table cell with a name and a quieter line under it. Long unbroken names wrap instead of widening the column. */
export function TwoLine({ primary, meta, mono, className }: { primary: ReactNode; meta?: ReactNode; mono?: boolean; className?: string }) {
  return (
    <span className={cx("block min-w-0", className)}>
      {/* "anywhere", not "break-word": a 126-character name then wraps in its column instead of pushing the others off (E-L2). */}
      <span className={cx("block font-medium text-ink [overflow-wrap:anywhere]", mono && "font-mono text-[13px]")}>{primary}</span>
      {meta ? <span className="block text-[12px] leading-[1.45] text-ink-3 [overflow-wrap:anywhere]">{meta}</span> : null}
    </span>
  );
}

/** A quieter single-line cell value that still wraps a long unbroken word. */
export function Quiet({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("text-ink-2 [overflow-wrap:anywhere]", className)}>{children}</span>;
}

/** The upper-case label over a group in a sheet or a page: 12px, semibold, tertiary ink. */
export function SectionLabel({ children, className, as: Tag = "h3", id }: { children: ReactNode; className?: string; as?: "h2" | "h3"; id?: string }) {
  return (
    <Tag id={id} className={cx("text-[12px] leading-4 font-medium tracking-[0.04em] text-ink-3 uppercase", className)}>
      {children}
    </Tag>
  );
}

/**
 * A labelled block in a sheet: the section label, an optional hint, then its fields in a bordered group (or bare
 * with `flat`, for lists that draw their own rows).
 */
export function SheetSection({
  title,
  hint,
  aside,
  flat,
  children,
  className,
}: {
  title?: ReactNode;
  hint?: ReactNode;
  aside?: ReactNode;
  flat?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx("flex flex-col gap-2.5", className)}>
      {title || aside ? (
        <div className="flex items-baseline justify-between gap-3">
          {title ? <SectionLabel>{title}</SectionLabel> : <span />}
          {aside}
        </div>
      ) : null}
      {hint ? <p className="-mt-1 text-[13px] leading-[1.45] text-ink-3">{hint}</p> : null}
      {flat ? children : <Group className="flex flex-col gap-4 p-4">{children}</Group>}
    </section>
  );
}

/** A bordered group with the panel radius. */
export function Group({ children, className, as: Tag = "div" }: { children: ReactNode; className?: string; as?: "div" | "ul" | "ol" }) {
  return <Tag className={cx("rounded-panel border border-rule", className)}>{children}</Tag>;
}

/** The row of filters and actions above a list. Actions sit at the right and wrap under the filters on a phone. */
export function Toolbar({ children, actions, className }: { children?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cx("mb-4 flex flex-wrap items-center gap-2", className)}>
      {children}
      {actions ? <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{actions}</div> : null}
    </div>
  );
}
