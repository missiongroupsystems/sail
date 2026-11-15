import { cx } from "../lib/cx";

export type HairlineProps = {
  orientation?: "horizontal" | "vertical";
  /** `subtle` divides rows in a list; `default` separates blocks. */
  weight?: "subtle" | "default";
  className?: string;
};

/** A 1px divider in the line colour. Vertical ones stretch to their row's height. */
export function Hairline({ orientation = "horizontal", weight = "subtle", className }: HairlineProps) {
  const colour = weight === "subtle" ? "bg-rule-subtle" : "bg-rule";
  if (orientation === "vertical") {
    return <span role="separator" aria-orientation="vertical" className={cx("inline-block w-px self-stretch", colour, className)} />;
  }
  return <div role="separator" aria-orientation="horizontal" className={cx("h-px w-full", colour, className)} />;
}
