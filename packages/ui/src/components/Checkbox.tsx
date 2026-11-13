"use client";

import { Check } from "lucide-react";
import type { ReactNode } from "react";
import {
  Checkbox as AriaCheckbox,
  CheckboxGroup as AriaCheckboxGroup,
  FieldError,
  Label,
  Text,
  type CheckboxGroupProps as AriaCheckboxGroupProps,
  type CheckboxProps as AriaCheckboxProps,
} from "react-aria-components";
import { cx } from "../lib/cx";
import { fieldDescription, fieldError, fieldLabel, fieldWrap } from "./field";
import { Icon } from "./Icon";

export type CheckboxProps = Omit<AriaCheckboxProps, "className" | "children"> & {
  children: ReactNode;
  description?: ReactNode;
  className?: string;
};

export function Checkbox({ children, description, className, ...rest }: CheckboxProps) {
  return (
    <AriaCheckbox
      {...rest}
      className={cx("group flex min-h-11 cursor-default items-start gap-3 py-2 text-body text-ink outline-none data-[disabled]:text-ink-disabled", className)}
    >
      <span
        aria-hidden
        className={cx(
          "mt-[3px] inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-rule-input bg-surface press",
          "group-data-[hovered]:border-ink-2 group-data-[selected]:bg-primary group-data-[selected]:border-primary group-data-[selected]:text-on-primary group-data-[pressed]:scale-[0.94]",
          "group-data-[disabled]:border-rule group-data-[disabled]:bg-surface-2 group-data-[selected]:group-data-[disabled]:border-transparent group-data-[selected]:group-data-[disabled]:bg-ink-disabled",
          "group-data-[focus-visible]:outline-2 group-data-[focus-visible]:outline-offset-2 group-data-[focus-visible]:outline-focus",
        )}
      >
        <Icon icon={Check} size={12} className="opacity-0 group-data-[selected]:opacity-100" strokeWidth={3} />
      </span>
      <span className="flex flex-col">
        <span>{children}</span>
        {description ? <span className="text-caption text-ink-3">{description}</span> : null}
      </span>
    </AriaCheckbox>
  );
}

export type CheckboxGroupProps = Omit<AriaCheckboxGroupProps, "className" | "children"> & {
  label?: ReactNode;
  description?: ReactNode;
  errorMessage?: string;
  children: ReactNode;
  className?: string;
  /** Lay options out in two columns when there is room. */
  columns?: 1 | 2;
};

export function CheckboxGroup({ label, description, errorMessage, children, className, columns = 1, ...rest }: CheckboxGroupProps) {
  return (
    <AriaCheckboxGroup {...rest} className={cx(fieldWrap, className)}>
      {label ? <Label className={fieldLabel}>{label}</Label> : null}
      <div className={cx("grid gap-x-6", columns === 2 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1")}>{children}</div>
      {description ? (
        <Text slot="description" className={fieldDescription}>
          {description}
        </Text>
      ) : null}
      <FieldError className={fieldError}>{errorMessage}</FieldError>
    </AriaCheckboxGroup>
  );
}
