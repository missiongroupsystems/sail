import type { LucideIcon, LucideProps } from "lucide-react";
import { cx } from "../lib/cx";

export type IconProps = Omit<LucideProps, "ref"> & {
  icon: LucideIcon;
  /** Pixel size; 20 is the back-office default, 24 the POS default. */
  size?: number;
  /** Accessible name. Icons without one are decorative and hidden from readers. */
  label?: string;
};

/** Lucide at a 1.6 stroke. Decorative unless a `label` is given. */
export function Icon({ icon: Glyph, size = 20, label, className, ...rest }: IconProps) {
  return (
    <Glyph
      size={size}
      strokeWidth={1.6}
      absoluteStrokeWidth
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      focusable={false}
      className={cx("shrink-0", className)}
      {...rest}
    />
  );
}

/** The agent mark (2.1): a small three-point sail, used only for assistants. */
export function AgentMark({ size = 14, className, label }: { size?: number; className?: string; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      className={cx("shrink-0 text-agent", className)}
    >
      <path d="M2.5 13.5 L8 2.25 L13.5 13.5 Z" fill="currentColor" />
      <path d="M8 2.25 V13.5" stroke="var(--surface)" strokeWidth="1.25" />
    </svg>
  );
}
