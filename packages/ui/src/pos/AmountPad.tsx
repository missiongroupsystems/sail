"use client";

import { Delete } from "lucide-react";
import { Button as AriaButton } from "react-aria-components";
import { cx } from "../lib/cx";
import { Icon } from "../components/Icon";
import { formatCents } from "../components/Money";

export type AmountPadProps = {
  /** Digits typed so far, as a string ("1250" is $12.50 in `cents` mode, or 12.50% in `percent` mode). */
  digits: string;
  onChange: (digits: string) => void;
  /** `cents`: a money amount; `percent`: a percentage with two decimals (digits are basis points). */
  mode: "cents" | "percent";
  /** Shown under the figure: the rule's range or a hint. */
  hint?: string | null;
  isDisabled?: boolean;
  className?: string;
};

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0", "⌫"] as const;

/** Formats basis points as "12.5%". Display only. */
export function formatBpsText(bps: number): string {
  const whole = Math.floor(bps / 100);
  const frac = bps % 100;
  return frac === 0 ? `${whole}%` : `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}%`;
}

/** An amount pad (design 8): currency or percentage entry, digits typed right to left like a till. */
export function AmountPad({ digits, onChange, mode, hint, isDisabled, className }: AmountPadProps) {
  const n = Number(digits || "0");
  const text = mode === "cents" ? formatCents(n) : formatBpsText(n);
  const press = (k: string) => {
    if (isDisabled) return;
    if (k === "⌫") return onChange(digits.slice(0, -1));
    if (digits.length + k.length > 9) return;
    const next = (digits + k).replace(/^0+(?=\d)/, "");
    onChange(next);
  };
  return (
    <div className={cx("flex flex-col items-center gap-4 pos-touch", className)}>
      <div className="flex flex-col items-center">
        <output className="text-amount-xl tabular text-ink" aria-live="polite">
          {text}
        </output>
        {hint ? <span className="text-caption text-ink-2">{hint}</span> : null}
      </div>
      <div className="grid grid-cols-3 gap-2" role="group" aria-label="Amount keys">
        {KEYS.map((k) => (
          <AriaButton
            key={k}
            onPress={() => press(k)}
            isDisabled={isDisabled}
            aria-label={k === "⌫" ? "Delete last digit" : k}
            className="press flex h-16 w-[88px] items-center justify-center rounded-tile bg-surface-2 text-title tabular text-ink outline-none data-[pressed]:scale-[0.97] data-[pressed]:brightness-90 data-[disabled]:opacity-40 data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-status-seated"
          >
            {k === "⌫" ? <Icon icon={Delete} size={24} /> : k}
          </AriaButton>
        ))}
      </div>
    </div>
  );
}
