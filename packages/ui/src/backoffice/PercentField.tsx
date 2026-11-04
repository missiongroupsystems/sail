"use client";

import { useEffect, useState, type ReactNode } from "react";
import { cx } from "../lib/cx";
import { TextField } from "../components/TextField";

/** "9", "9.5", "9.25%" -> basis points (925). Up to two decimals; null for empty; undefined when malformed. */
export function parsePercent(text: string): number | null | undefined {
  const clean = text.replace(/[^\d.]/g, "");
  if (clean === "") return null;
  const m = /^(\d*)(?:\.(\d*))?$/.exec(clean);
  if (!m) return undefined;
  const [, wholeRaw = "", fracRaw = ""] = m;
  if (fracRaw.length > 2) return undefined;
  const whole = wholeRaw === "" ? "0" : wholeRaw;
  const bps = Number(`${whole}${fracRaw.padEnd(2, "0")}`);
  return Number.isSafeInteger(bps) ? bps : undefined;
}

/** 925 -> "9.25"; 900 -> "9". */
export function percentText(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isInteger(bps)) return "";
  const whole = Math.trunc(bps / 100);
  const frac = Math.abs(bps % 100);
  if (frac === 0) return String(whole);
  return `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}`;
}

export type PercentFieldProps = {
  label?: ReactNode;
  description?: ReactNode;
  errorMessage?: string;
  /** Basis points (900 = 9%), as the API stores them. */
  value: number | null;
  onChange: (bps: number | null) => void;
  onBlur?: () => void;
  placeholder?: string;
  name?: string;
  isDisabled?: boolean;
  isInvalid?: boolean;
  autoFocus?: boolean;
  "aria-label"?: string;
  className?: string;
};

/** A percentage input: the person types "9.5", the form holds 950 basis points. */
export function PercentField({ value, onChange, onBlur, placeholder = "0", isInvalid, errorMessage, className, ...rest }: PercentFieldProps) {
  const [text, setText] = useState(() => percentText(value));
  const [malformed, setMalformed] = useState(false);

  useEffect(() => {
    if (parsePercent(text) !== value) setText(percentText(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <TextField
      {...rest}
      value={text}
      onChange={(next) => {
        setText(next);
        const parsed = parsePercent(next);
        if (parsed === undefined) {
          setMalformed(true);
          return;
        }
        setMalformed(false);
        onChange(parsed);
      }}
      onBlur={() => {
        const parsed = parsePercent(text);
        if (parsed !== undefined) setText(percentText(parsed));
        onBlur?.();
      }}
      inputMode="decimal"
      numeric
      suffix="%"
      placeholder={placeholder}
      isInvalid={isInvalid || malformed}
      errorMessage={malformed ? "Enter a percentage like 9.5" : errorMessage}
      className={cx(className)}
    />
  );
}
