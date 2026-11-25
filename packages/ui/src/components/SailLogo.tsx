import type { ComponentType } from "react";
import { cx } from "../lib/cx";

/*
 * Sail's own mark: the three-point sail, a triangle split by its mast. The two halves are drawn apart instead of
 * painting the mast in a surface colour, so the mark reads on any background, in Day and in Service.
 */
const LEFT = "M2.5 13.5 L7.4 3.48 V13.5 Z";
const RIGHT = "M8.6 3.48 L13.5 13.5 H8.6 Z";

export type SailMarkProps = {
  /** Pixel size of the square mark. */
  size?: number;
  className?: string;
  /** Accessible name. Without one the mark is decorative and hidden from readers. */
  label?: string;
};

/** The sail in currentColor, ink by default. AgentMark stays the violet mark for assistants. */
export function SailMark({ size = 20, className, label }: SailMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      className={cx("shrink-0 text-ink", className)}
    >
      <path d={LEFT} fill="currentColor" />
      <path d={RIGHT} fill="currentColor" />
    </svg>
  );
}

export type SailLogoSize = "bar" | "sidebar" | "card";

const sizes: Record<SailLogoSize, { mark: number; text: string; gap: string }> = {
  /** POS and kitchen top bar. */
  bar: { mark: 18, text: "text-[17px] leading-6", gap: "gap-2" },
  /** Back-office sidebar header. */
  sidebar: { mark: 20, text: "text-[17px] leading-6", gap: "gap-2" },
  /** Sign-in, pairing and set-up cards. */
  card: { mark: 28, text: "text-[22px] leading-7", gap: "gap-2.5" },
};

export type SailLogoProps = {
  size?: SailLogoSize;
  className?: string;
  /** The product's name in place of "Sail". */
  name?: string;
  /** The mark in place of the sail; null sets the name alone. */
  mark?: ComponentType<{ size: number; className?: string }> | null;
  /** The name truncates to the width the logo is given (`className`), instead of widening it. */
  fit?: boolean;
};

/** The mark followed by the product's name ("Sail") in the heading face. Readers hear one name. */
export function SailLogo({ size = "bar", className, name = "Sail", mark: Mark = SailMark, fit = false }: SailLogoProps) {
  const s = sizes[size];
  return (
    <span role="img" aria-label={name} className={cx("inline-flex shrink-0 items-center text-ink", s.gap, className)}>
      {/* A downstream mark may not keep its size in a fixed width on its own. */}
      {Mark && (fit ? <span className="flex shrink-0"><Mark size={s.mark} className="text-current" /></span> : <Mark size={s.mark} className="text-current" />)}
      <span aria-hidden className={cx("font-heading font-semibold tracking-[-0.02em]", s.text, fit && "min-w-0 truncate")}>
        {name}
      </span>
    </span>
  );
}
