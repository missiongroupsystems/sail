"use client";

import { useEffect, useState, type ReactNode } from "react";
import { FieldError, Input, Label, Text, TextField as AriaTextField } from "react-aria-components";
import { cx } from "../lib/cx";
import { fieldControl, fieldDescription, fieldError, fieldLabel, fieldWrap } from "../components/field";

/** "16", "16.5", "$1,600.00" -> 1650 cents. Text arithmetic only: no floats. Returns null for empty, undefined for malformed. */
export function parseMoney(text: string, fractionDigits = 2): number | null | undefined {
  const clean = text.replace(/[^\d.\-]/g, "");
  if (clean === "" || clean === "-") return null;
  const m = /^(-)?(\d*)(?:\.(\d*))?$/.exec(clean);
  if (!m) return undefined;
  const [, sign, wholeRaw = "", fracRaw = ""] = m;
  if (fracRaw.length > fractionDigits) return undefined;
  const whole = wholeRaw === "" ? "0" : wholeRaw;
  const frac = fracRaw.padEnd(fractionDigits, "0");
  const cents = Number(`${whole}${frac}`);
  if (!Number.isSafeInteger(cents)) return undefined;
  return sign ? -cents : cents;
}

/** 1650 -> "16.50". Display inside an input: no symbol, no grouping. */
export function moneyText(cents: number | null | undefined, fractionDigits = 2): string {
  if (cents === null || cents === undefined || !Number.isInteger(cents)) return "";
  const negative = cents < 0;
  const digits = String(Math.abs(cents)).padStart(fractionDigits + 1, "0");
  const whole = digits.slice(0, digits.length - fractionDigits);
  const frac = digits.slice(digits.length - fractionDigits);
  return `${negative ? "-" : ""}${whole}${fractionDigits ? `.${frac}` : ""}`;
}

export type MoneyFieldProps = {
  label?: ReactNode;
  description?: ReactNode;
  errorMessage?: string;
  /** Integer cents, as the API stores them. `null` is an empty field. */
  value: number | null;
  onChange: (cents: number | null) => void;
  onBlur?: () => void;
  placeholder?: string;
  /** "$" for SGD. Shown inside the field; never part of the value. */
  symbol?: string;
  fractionDigits?: number;
  name?: string;
  isDisabled?: boolean;
  isInvalid?: boolean;
  isRequired?: boolean;
  autoFocus?: boolean;
  "aria-label"?: string;
  className?: string;
  inputClassName?: string;
};

/**
 * A money input for the back office: the person types dollars and cents, the
 * form holds integer cents. Tabular figures; the symbol sits inside the field.
 */
export function MoneyField({
  label,
  description,
  errorMessage,
  value,
  onChange,
  onBlur,
  placeholder = "0.00",
  symbol = "$",
  fractionDigits = 2,
  isInvalid,
  className,
  inputClassName,
  ...rest
}: MoneyFieldProps) {
  const [text, setText] = useState(() => moneyText(value, fractionDigits));
  const [malformed, setMalformed] = useState(false);

  // Follow outside changes (a reset, a saved value) without fighting the typist.
  useEffect(() => {
    const parsed = parseMoney(text, fractionDigits);
    if (parsed !== value) setText(moneyText(value, fractionDigits));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const change = (next: string) => {
    setText(next);
    const parsed = parseMoney(next, fractionDigits);
    if (parsed === undefined) {
      setMalformed(true);
      return;
    }
    setMalformed(false);
    onChange(parsed);
  };

  const blur = () => {
    const parsed = parseMoney(text, fractionDigits);
    if (parsed !== undefined) setText(moneyText(parsed, fractionDigits));
    onBlur?.();
  };

  return (
    <AriaTextField
      {...rest}
      value={text}
      onChange={change}
      onBlur={blur}
      isInvalid={isInvalid || malformed}
      inputMode="decimal"
      validationBehavior="aria"
      className={cx(fieldWrap, className)}
    >
      {label ? <Label className={fieldLabel}>{label}</Label> : null}
      <div className="relative">
        <span aria-hidden className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-body text-ink-2">
          {symbol}
        </span>
        <Input placeholder={placeholder} className={cx(fieldControl, "tabular pl-7 text-right", inputClassName)} />
      </div>
      {description ? (
        <Text slot="description" className={fieldDescription}>
          {description}
        </Text>
      ) : null}
      <FieldError className={fieldError}>{malformed ? `Enter an amount like 16.00` : errorMessage}</FieldError>
    </AriaTextField>
  );
}
