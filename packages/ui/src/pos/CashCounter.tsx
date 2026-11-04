"use client";

import { Minus, Plus } from "lucide-react";
import { Button as AriaButton } from "react-aria-components";
import { cx } from "../lib/cx";
import { formatCents, Money } from "../components/Money";
import { AmountPad } from "./AmountPad";

export type Denomination = { key: string; label: string; cents: number };

/** Singapore notes and coins, largest first. Keys are the value in cents, so counts round-trip through the register's `float_counts`. */
export const SGD_DENOMINATIONS: Denomination[] = [
  { key: "10000", label: "$100", cents: 10000 },
  { key: "5000", label: "$50", cents: 5000 },
  { key: "1000", label: "$10", cents: 1000 },
  { key: "500", label: "$5", cents: 500 },
  { key: "200", label: "$2", cents: 200 },
  { key: "100", label: "$1", cents: 100 },
  { key: "50", label: "50¢", cents: 50 },
  { key: "20", label: "20¢", cents: 20 },
  { key: "10", label: "10¢", cents: 10 },
  { key: "5", label: "5¢", cents: 5 },
];

export type CashCounterMode = "total" | "counts";

export type CashCounterProps = {
  mode: CashCounterMode;
  onModeChange: (mode: CashCounterMode) => void;
  /** Digits typed on the amount pad in total mode ("20000" is $200.00). */
  totalDigits: string;
  onTotalDigitsChange: (digits: string) => void;
  /** Pieces per denomination key in counts mode. */
  counts: Record<string, number>;
  onCountsChange: (counts: Record<string, number>) => void;
  denominations?: Denomination[];
  isDisabled?: boolean;
  className?: string;
};

/** The amount a count adds up to: the person's own count, before the register compares it with expected cash. */
export function cashCounterTotal(mode: CashCounterMode, totalDigits: string, counts: Record<string, number>, denominations: Denomination[] = SGD_DENOMINATIONS): number {
  if (mode === "total") return Number(totalDigits || "0");
  return denominations.reduce((sum, d) => sum + (counts[d.key] ?? 0) * d.cents, 0);
}

const key =
  "press pos-touch flex size-11 items-center justify-center rounded-tile bg-surface-2 text-ink outline-none " +
  "data-[pressed]:scale-[0.97] data-[pressed]:brightness-90 data-[disabled]:opacity-40 data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-status-seated";

/**
 * Cash count (design 4.9): a single total on the amount pad, or a denomination
 * counter with a row per note and coin adding up live. Used for the float at
 * open and the blind count at close.
 */
export function CashCounter({ mode, onModeChange, totalDigits, onTotalDigitsChange, counts, onCountsChange, denominations = SGD_DENOMINATIONS, isDisabled, className }: CashCounterProps) {
  const total = cashCounterTotal(mode, totalDigits, counts, denominations);
  const setCount = (k: string, n: number) => onCountsChange({ ...counts, [k]: Math.max(0, Math.min(999, n)) });
  return (
    <div className={cx("flex flex-col gap-4", className)}>
      <div role="group" aria-label="How to count" className="inline-flex self-start items-center gap-1 rounded-tile bg-surface-2 p-1">
        {(["total", "counts"] as CashCounterMode[]).map((m) => (
          <AriaButton
            key={m}
            aria-pressed={mode === m}
            isDisabled={isDisabled}
            onPress={() => onModeChange(m)}
            className={cx("press pos-touch min-h-11 rounded-[8px] px-4 text-line outline-none data-[pressed]:scale-[0.97] data-[focus-visible]:outline-2 data-[focus-visible]:outline-status-seated", mode === m ? "bg-surface text-ink" : "text-ink-2")}
          >
            {m === "total" ? "One total" : "Count notes and coins"}
          </AriaButton>
        ))}
      </div>
      {mode === "total" ? (
        <AmountPad digits={totalDigits} onChange={onTotalDigitsChange} mode="cents" isDisabled={isDisabled} hint="Cash in the drawer" />
      ) : (
        <div className="flex flex-col gap-1" role="group" aria-label="Notes and coins">
          {denominations.map((d) => {
            const n = counts[d.key] ?? 0;
            return (
              <div key={d.key} className="flex min-h-12 items-center gap-3">
                <span className="w-14 text-line text-ink tabular">{d.label}</span>
                <AriaButton onPress={() => setCount(d.key, n - 1)} isDisabled={isDisabled || n <= 0} aria-label={`Fewer ${d.label}`} className={key}>
                  <Minus size={18} strokeWidth={1.75} aria-hidden />
                </AriaButton>
                <input
                  type="text"
                  inputMode="numeric"
                  aria-label={`${d.label} count`}
                  value={String(n)}
                  disabled={isDisabled}
                  onChange={(e) => setCount(d.key, Number(e.target.value.replace(/\D/g, "") || "0"))}
                  onFocus={(e) => e.currentTarget.select()}
                  className="h-11 w-16 rounded-tile bg-surface text-center text-line text-ink tabular hairline outline-none focus-visible:outline-2 focus-visible:outline-status-seated"
                />
                <AriaButton onPress={() => setCount(d.key, n + 1)} isDisabled={isDisabled} aria-label={`More ${d.label}`} className={key}>
                  <Plus size={18} strokeWidth={1.75} aria-hidden />
                </AriaButton>
                <span className="ml-auto text-body text-ink-2 tabular">{n > 0 ? formatCents(n * d.cents) : ""}</span>
              </div>
            );
          })}
          <div className="mt-2 flex items-center justify-between pt-2 hairline-t">
            <span className="text-line text-ink">Counted</span>
            <Money cents={total} size="title" className="text-ink" />
          </div>
        </div>
      )}
    </div>
  );
}
