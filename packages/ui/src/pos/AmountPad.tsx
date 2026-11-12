"use client";

import { Delete } from "lucide-react";
import { useState } from "react";
import { Button as AriaButton } from "react-aria-components";
import { MAX_AMOUNT } from "@sail/shared";
import { cx } from "../lib/cx";
import { Icon } from "../components/Icon";
import { useLocale } from "../lib/locale";

export type AmountPadProps = {
  /** The value as a string of digits: minor units in `cents` mode ("1250" is $12.50, or ¥1,250), basis points in `percent` mode ("1250" is 12.5%). */
  digits: string;
  onChange: (digits: string) => void;
  /** `cents`: a money amount, typed right to left like a till; `percent`: a percentage typed as it reads (1, 0 is 10%; a point for decimals), reported in basis points. */
  mode: "cents" | "percent";
  /** Shown under the figure: the rule's range or a hint. */
  hint?: string | null;
  isDisabled?: boolean;
  className?: string;
};

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0", "⌫"] as const;
const PERCENT_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"] as const;

/** "12.5" → 1250 basis points. */
const typedToBps = (typed: string) => Math.round(Number(typed || "0") * 100);
/** 1250 basis points → "12.5", as it would have been typed. */
const bpsToTyped = (digits: string) => (digits ? formatBpsText(Number(digits)).slice(0, -1) : "");

/** Formats basis points as "12.5%". Display only. */
export function formatBpsText(bps: number): string {
  const whole = Math.floor(bps / 100);
  const frac = bps % 100;
  return frac === 0 ? `${whole}%` : `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}%`;
}

/**
 * The digits after a key press, or null when the key is refused. An amount may go up to the largest the register
 * accepts (`MAX_AMOUNT`, so a rupiah bill in the millions can be typed); a percentage keeps to 9 digits.
 */
export function padDigits(digits: string, key: string, mode: AmountPadProps["mode"]): string | null {
  if (key === "⌫") return digits.slice(0, -1);
  const next = (digits + key).replace(/^0+(?=\d)/, "");
  if (mode === "cents" ? Number(next) > MAX_AMOUNT : next.length > 9) return null;
  return next;
}

/**
 * An amount pad. Money is typed right to left like a till (1, 2, 5, 0 is 12.50); a percentage is typed as it reads
 * (1, 0 is 10%, and 1, 2, ., 5 is 12.5%), because a till's implied decimals turned "10" into 0.10%.
 */
export function AmountPad({ digits, onChange, mode, hint, isDisabled, className }: AmountPadProps) {
  const { money } = useLocale();
  const n = Number(digits || "0");
  // The percentage as typed, so "12." survives until the next digit; it follows the caller when the value is reset.
  const [typed, setTyped] = useState(() => bpsToTyped(digits));
  if (mode === "percent" && typedToBps(typed) !== n) setTyped(bpsToTyped(digits));
  const text = mode === "cents" ? money(n) : `${typed || "0"}%`;
  const pressPercent = (k: string) => {
    let next = typed;
    if (k === "⌫") next = typed.slice(0, -1);
    else if (k === ".") next = typed.includes(".") ? typed : `${typed || "0"}.`;
    else if (/\.\d{2}$/.test(typed) || typed.replace(".", "").length >= 5) return;
    else next = (typed + k).replace(/^0+(?=\d)/, "");
    setTyped(next);
    onChange(String(typedToBps(next)));
  };
  const press = (k: string) => {
    if (isDisabled) return;
    if (mode === "percent") return pressPercent(k);
    const next = padDigits(digits, k, mode);
    if (next !== null) onChange(next);
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
        {(mode === "percent" ? PERCENT_KEYS : KEYS).map((k) => (
          <AriaButton
            key={k}
            onPress={() => press(k)}
            isDisabled={isDisabled}
            aria-label={k === "⌫" ? "Delete last digit" : k === "." ? "Decimal point" : k}
            className="press flex h-16 w-[88px] items-center justify-center rounded-tile bg-surface-2 text-title tabular text-ink outline-none data-[pressed]:scale-[0.97] data-[pressed]:brightness-90 data-[disabled]:opacity-40 data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-status-seated"
          >
            {k === "⌫" ? <Icon icon={Delete} size={24} /> : k}
          </AriaButton>
        ))}
      </div>
    </div>
  );
}
