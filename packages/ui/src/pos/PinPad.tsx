"use client";

import { Delete } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button as AriaButton } from "react-aria-components";
import { cx } from "../lib/cx";
import { Icon } from "./../components/Icon";

export type PinPadProps = {
  value: string;
  onChange: (value: string) => void;
  /** Called once the pad holds `length` digits. The pad submits itself; there is no extra tap (design 4.1). */
  onComplete?: (pin: string) => void;
  length?: number;
  /** "PIN not recognised": shakes the dots (flashes under reduced motion). Changing the text shakes again. */
  error?: string | null;
  /** Lockout countdown from the register's rate_limited error; keys are disabled while it runs. */
  lockedForSeconds?: number | null;
  isDisabled?: boolean;
  /** Show "Unlock" under the dots once 4 digits are in (design 4.1). */
  unlockHint?: boolean;
  /** Busy while the register checks the PIN. */
  isPending?: boolean;
  className?: string;
};

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"] as const;

/**
 * The PIN pad (design 4.1, 7.5): keys 88 × 72, digits 48pt, six dots. Used for
 * sign-in and for manager approval (4.7).
 */
export function PinPad({ value, onChange, onComplete, length = 6, error, lockedForSeconds, isDisabled, unlockHint = true, isPending, className }: PinPadProps) {
  const [shaking, setShaking] = useState(0);
  const lastError = useRef<string | null | undefined>(undefined);
  const completed = useRef<string | null>(null);

  useEffect(() => {
    if (error && error !== lastError.current) {
      setShaking((n) => n + 1);
      const t = setTimeout(() => setShaking(0), 700);
      lastError.current = error;
      return () => clearTimeout(t);
    }
    if (!error) lastError.current = null;
    return undefined;
  }, [error]);

  useEffect(() => {
    if (value.length === length && completed.current !== value) {
      completed.current = value;
      onComplete?.(value);
    }
    if (value.length < length) completed.current = null;
  }, [value, length, onComplete]);

  const locked = (lockedForSeconds ?? 0) > 0;
  const disabled = Boolean(isDisabled) || locked || Boolean(isPending);

  const press = (key: string) => {
    if (disabled) return;
    if (key === "⌫") {
      onChange(value.slice(0, -1));
      return;
    }
    if (value.length >= length) return;
    onChange(value + key);
  };

  return (
    <div className={cx("flex flex-col items-center gap-6 pos-touch", className)}>
      <div className="flex h-12 flex-col items-center justify-center gap-2" aria-live="polite">
        <div
          className={cx("flex items-center gap-4", shaking > 0 && "pos-shake")}
          data-error={shaking > 0 || undefined}
          role="status"
          aria-label={`${value.length} of ${length} digits entered`}
        >
          {Array.from({ length }, (_, i) => (
            <span
              key={i}
              aria-hidden
              className={cx(
                "block size-4 rounded-full transition-colors duration-[80ms]",
                shaking > 0 ? "bg-status-alert" : i < value.length ? "bg-ink" : "bg-transparent ring-1 ring-inset ring-ink-2",
              )}
            />
          ))}
        </div>
        <p className={cx("text-caption h-[18px]", error ? "text-status-alert" : "text-ink-2")}>
          {locked ? `Try again in ${lockedForSeconds} s` : error ? error : isPending ? "Checking…" : unlockHint && value.length >= 4 && value.length < length ? "Unlock" : ""}
        </p>
      </div>
      <div className="grid grid-cols-3 gap-2" role="group" aria-label="PIN keys">
        {KEYS.map((key, i) =>
          key === "" ? (
            <span key={i} aria-hidden />
          ) : (
            <AriaButton
              key={key}
              onPress={() => press(key)}
              isDisabled={disabled}
              aria-label={key === "⌫" ? "Delete last digit" : key}
              className={cx(
                "press flex h-[72px] w-[88px] items-center justify-center rounded-tile bg-surface-2 text-ink outline-none select-none",
                "data-[pressed]:scale-[0.97] data-[pressed]:brightness-90 data-[hovered]:brightness-105 data-[disabled]:opacity-40",
                "data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-status-seated",
              )}
            >
              {key === "⌫" ? <Icon icon={Delete} size={28} /> : <span className="text-display tabular leading-none">{key}</span>}
            </AriaButton>
          ),
        )}
      </div>
    </div>
  );
}
