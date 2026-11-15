import type { ReactNode } from "react";
import { cx } from "../lib/cx";

export type EyebrowProps = {
  /** A section's label, in sentence case: "Today so far", "Kitchen". */
  children: ReactNode;
  /** Quieter text after the label: a count, a date. */
  suffix?: ReactNode;
  className?: string;
};

/** The small label above a heading or a group: 12.5pt medium in tertiary ink, never upper case. */
export function Eyebrow({ children, suffix, className }: EyebrowProps) {
  return (
    <p className={cx("text-[12.5px] leading-[1.4] font-medium text-ink-3", className)}>
      {children}
      {suffix != null ? <span className="font-normal"> {suffix}</span> : null}
    </p>
  );
}
