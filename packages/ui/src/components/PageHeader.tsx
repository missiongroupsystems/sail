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

export function PageHeader({ title, description, eyebrow, actions, tabs, className }: PageHeaderProps) {
  return (
    <header className={cx("hairline-b mb-6", className)}>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 pb-4">
        <div className="min-w-0">
          {eyebrow ? <p className="text-caption text-ink-2 uppercase tracking-[0.06em]">{eyebrow}</p> : null}
          <h1 className="text-title text-ink">{title}</h1>
          {description ? <p className="mt-1 text-body text-ink-2">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {tabs ? <div className="-mb-px">{tabs}</div> : null}
    </header>
  );
}

export type SectionHeadingProps = { title: ReactNode; aside?: ReactNode; className?: string };

/** A heading for a block within a page. Nouns only. */
export function SectionHeading({ title, aside, className }: SectionHeadingProps) {
  return (
    <div className={cx("flex items-baseline justify-between gap-4 pb-2 hairline-b", className)}>
      <h2 className="text-heading text-ink">{title}</h2>
      {aside ? <div className="text-caption text-ink-2">{aside}</div> : null}
    </div>
  );
}
