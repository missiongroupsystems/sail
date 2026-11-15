import type { ReactNode } from "react";
import { cx } from "../lib/cx";

export type PageHeaderProps = {
  /** A noun: "Outlets", "Team", "Today". */
  title: ReactNode;
  /** One quiet line under the title. */
  description?: ReactNode;
  /** Small text above the title, for the section a page belongs to. */
  eyebrow?: ReactNode;
  /** Right-aligned actions; the primary one last. */
  actions?: ReactNode;
  /** Secondary navigation (tabs) rendered under the header, above the hairline. */
  tabs?: ReactNode;
  className?: string;
};

/**
 * A page's own title at the top of the content sheet: Geist 24px, a 14px description, actions at the
 * right, and no rule under it. Sub-section tabs sit under the description as a segmented strip.
 */
export function PageHeader({ title, description, eyebrow, actions, tabs, className }: PageHeaderProps) {
  return (
    <header className={cx("mb-6", className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          {eyebrow ? <p className="mb-1 text-[12.5px] leading-[1.4] font-medium text-ink-3">{eyebrow}</p> : null}
          <h1 className="font-heading text-[24px] leading-[1.25] font-semibold tracking-[-0.02em] text-ink">{title}</h1>
          {description ? <p className="mt-1 max-w-[70ch] text-[14px] leading-5 text-ink-2">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {tabs ? <div className="mt-5 max-w-full">{tabs}</div> : null}
    </header>
  );
}

export type SectionHeadingProps = { title: ReactNode; aside?: ReactNode; className?: string };

/** A heading for a block within a page. Nouns only. */
export function SectionHeading({ title, aside, className }: SectionHeadingProps) {
  return (
    <div className={cx("flex items-baseline justify-between gap-4 border-b border-rule-subtle pb-2", className)}>
      <h2 className="font-heading text-[16px] leading-[1.35] font-semibold tracking-[-0.01em] text-ink">{title}</h2>
      {aside ? <div className="text-caption text-ink-3">{aside}</div> : null}
    </div>
  );
}
