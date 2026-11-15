import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import { Eyebrow } from "./Eyebrow";

export type SectionHeadProps = {
  title: ReactNode;
  eyebrow?: ReactNode;
  /** One line under the title. */
  description?: ReactNode;
  /** Right-aligned actions or a count. */
  actions?: ReactNode;
  as?: "h2" | "h3";
  id?: string;
  className?: string;
};

/**
 * A block's heading with no rule under it: title in the heading face, an optional eyebrow and description, actions on
 * the right. SectionHeading (with its hairline) stays for lists that start straight under the title.
 */
export function SectionHead({ title, eyebrow, description, actions, as: Tag = "h2", id, className }: SectionHeadProps) {
  return (
    <div className={cx("flex flex-wrap items-end justify-between gap-x-6 gap-y-2", className)}>
      <div className="min-w-0">
        {eyebrow != null ? <Eyebrow className="mb-1">{eyebrow}</Eyebrow> : null}
        <Tag id={id} className={cx("font-heading font-semibold tracking-[-0.01em] text-ink", Tag === "h2" ? "text-[19px] leading-[1.3]" : "text-[16px] leading-[1.35]")}>
          {title}
        </Tag>
        {description ? <p className="mt-1 max-w-[70ch] text-[14px] leading-5 text-ink-2">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
