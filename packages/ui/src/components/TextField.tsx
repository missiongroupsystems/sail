"use client";

import type { ReactNode } from "react";
import {
  FieldError,
  Input,
  Label,
  Text,
  TextArea,
  TextField as AriaTextField,
  type TextFieldProps as AriaTextFieldProps,
  type ValidationResult,
} from "react-aria-components";
import { cx } from "../lib/cx";
import { useLockedDisabled } from "./FieldsLocked";
import { fieldControl, fieldControlSm, fieldDescription, fieldError, fieldLabel, fieldWrap, type FieldSize } from "./field";

export type TextFieldProps = Omit<AriaTextFieldProps, "className" | "children"> & {
  label?: ReactNode;
  description?: ReactNode;
  /** The register's message, or a zod message; shown under the field and keeps the input. */
  errorMessage?: string | ((validation: ValidationResult) => string);
  placeholder?: string;
  /** Renders a textarea. */
  multiline?: boolean;
  rows?: number;
  /** Monospace for references, job IDs and codes (7.4). */
  mono?: boolean;
  /** Tabular figures for amounts and counts. */
  numeric?: boolean;
  className?: string;
  inputClassName?: string;
  /** A short unit or hint rendered inside the field on the right ("bps", "%"). */
  suffix?: ReactNode;
  /** `sm` is the 36px back-office field for filter rows; the default `md` is 44px. Not for the POS. */
  size?: FieldSize;
};

export function TextField({
  label,
  description,
  errorMessage,
  placeholder,
  multiline,
  rows = 3,
  mono,
  numeric,
  className,
  inputClassName,
  suffix,
  size = "md",
  ...rest
}: TextFieldProps) {
  const isDisabled = useLockedDisabled(rest.isDisabled);
  const control = cx(size === "sm" ? fieldControlSm : fieldControl, mono && "font-mono", numeric && "tabular", suffix ? "pr-12" : null, inputClassName);
  return (
    <AriaTextField {...rest} isDisabled={isDisabled} validationBehavior={rest.validationBehavior ?? "aria"} className={cx(fieldWrap, className)}>
      {label ? <Label className={fieldLabel}>{label}</Label> : null}
      <div className="relative">
        {multiline ? (
          <TextArea placeholder={placeholder} rows={rows} className={cx(control, "py-2.5 leading-[22px] resize-y")} />
        ) : (
          <Input placeholder={placeholder} className={control} />
        )}
        {suffix ? (
          <span aria-hidden className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-caption text-ink-3">
            {suffix}
          </span>
        ) : null}
      </div>
      {description ? (
        <Text slot="description" className={fieldDescription}>
          {description}
        </Text>
      ) : null}
      <FieldError className={fieldError}>{errorMessage}</FieldError>
    </AriaTextField>
  );
}
