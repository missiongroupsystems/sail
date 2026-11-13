"use client";

import { useEffect, useState, type ReactNode } from "react";
import { FieldError, Input, Label, Text, TextField as AriaTextField } from "react-aria-components";
import { cx } from "../lib/cx";
import { fieldControl, fieldDescription, fieldError, fieldLabel, fieldWrap } from "../components/field";
import { useLocale } from "../lib/locale";

export type MoneyFieldProps = {
  label?: ReactNode;
  description?: ReactNode;
  errorMessage?: string;
  /** Integer minor units, as the API stores them. `null` is an empty field. */
  value: number | null;
  onChange: (cents: number | null) => void;
  onBlur?: () => void;
  placeholder?: string;
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
 * A money input for the back office: the person types the amount in the
 * merchant's currency and locale, the form holds integer minor units. Tabular
 * figures; the currency symbol sits inside the field.
 */
export function MoneyField({
  label,
  description,
  errorMessage,
  value,
  onChange,
  onBlur,
  placeholder,
  isInvalid,
  className,
  inputClassName,
  ...rest
}: MoneyFieldProps) {
  const { moneyText, parseMoney, symbol, minorDigits } = useLocale();
  const example = moneyText(16 * 10 ** minorDigits);
  const [text, setText] = useState(() => moneyText(value));
  const [malformed, setMalformed] = useState(false);

  // Follow outside changes (a reset, a saved value) without fighting the typist.
  useEffect(() => {
    const parsed = parseMoney(text);
    if (parsed !== value) setText(moneyText(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const change = (next: string) => {
    setText(next);
    const parsed = parseMoney(next);
    if (parsed === undefined) {
      setMalformed(true);
      return;
    }
    setMalformed(false);
    onChange(parsed);
  };

  const blur = () => {
    const parsed = parseMoney(text);
    if (parsed !== undefined) setText(moneyText(parsed));
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
        <span aria-hidden className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-body text-ink-3">
          {symbol}
        </span>
        <Input placeholder={placeholder ?? moneyText(0)} className={cx(fieldControl, "tabular", symbol.length > 1 ? "pl-12" : "pl-7", inputClassName)} />
      </div>
      {description ? (
        <Text slot="description" className={fieldDescription}>
          {description}
        </Text>
      ) : null}
      <FieldError className={fieldError}>{malformed ? `Enter an amount like ${example}` : errorMessage}</FieldError>
    </AriaTextField>
  );
}
