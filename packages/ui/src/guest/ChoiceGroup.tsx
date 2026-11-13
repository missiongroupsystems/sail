"use client";

import { Check } from "lucide-react";
import type { ReactNode } from "react";
import {
  Checkbox as AriaCheckbox,
  CheckboxGroup as AriaCheckboxGroup,
  Label,
  Radio as AriaRadio,
  RadioGroup as AriaRadioGroup,
  Text,
} from "react-aria-components";
import { cx } from "../lib/cx";
import { Icon } from "../components/Icon";
import { Money } from "../components/Money";
import { GuestStepper } from "./GuestStepper";

export type ChoiceOption = {
  id: string;
  name: string;
  /** Extra price in cents from the register; shown as "+$2.00". 0 or undefined shows nothing. */
  price?: number;
  isDisabled?: boolean;
  description?: string;
};

/** Chosen options with their quantities (quantity is 1 unless the group allows more per option). */
export type ChoiceValue = { id: string; quantity: number }[];

export type ChoiceGroupProps = {
  /** The group's name: "Protein", "Spice". */
  name: string;
  /** The rule, announced with the group: "Choose 1", "Choose up to 3", "Optional". */
  rule: string;
  required: boolean;
  /** Whether the minimum is met; the rule sits on an amber tint until it is. */
  met: boolean;
  /** A single-choice group renders radios; anything else renders checkboxes. */
  mode: "single" | "multi";
  maxSelect: number | null;
  /** Most of one option; a stepper appears under a chosen option when this is above 1. */
  maxPerOption: number;
  options: ChoiceOption[];
  value: ChoiceValue;
  onChange: (value: ChoiceValue) => void;
  /** The register's message for this group, shown in place of the rule ("Choose 1 more: Protein"). */
  errorMessage?: string | null;
  /** Rendered under a chosen option: its child group (nested choices live inline). */
  renderUnder?: (optionId: string) => ReactNode;
  /** A child group: indented under its parent's option, with "for Chicken" in the heading. */
  parentLabel?: string;
  isDisabled?: boolean;
  className?: string;
};

const row =
  "group flex min-h-[52px] w-full cursor-default items-center gap-3 px-4 py-2.5 text-[15.5px] text-ink outline-none touch-manipulation transition-colors duration-[120ms] " +
  "data-[pressed]:bg-surface-2 data-[disabled]:text-ink-disabled data-[focus-visible]:outline-2 data-[focus-visible]:-outline-offset-2 data-[focus-visible]:outline-focus";

/** The options sit in one bordered card with a hairline between them. */
const card = "flex flex-col divide-y divide-rule-subtle overflow-hidden rounded-sheet border border-rule";

function Mark({ shape, selected }: { shape: "radio" | "check"; selected: boolean }) {
  return (
    <span
      aria-hidden
      className={cx(
        "inline-flex size-[22px] shrink-0 items-center justify-center border-[1.5px] transition-colors duration-[120ms] press",
        shape === "radio" ? "rounded-full" : "rounded-[6px]",
        selected ? "border-brand-accent bg-brand-accent text-on-brand-accent" : "border-rule-input bg-surface",
      )}
    >
      <Icon icon={Check} size={14} strokeWidth={3} className={selected ? "opacity-100" : "opacity-0"} />
    </span>
  );
}

function OptionText({ option }: { option: ChoiceOption }) {
  return (
    <>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="break-words group-data-[selected]:font-medium">{option.name}</span>
        {option.description ? <span className="text-caption text-ink-3">{option.description}</span> : null}
      </span>
      {option.price ? <Money cents={option.price} signed className="shrink-0 text-[14.5px] text-ink-2" /> : null}
    </>
  );
}

/**
 * A modifier group for the item sheet: a real radio group or
 * checkbox group whose rule ("Choose 1") is its accessible description, so
 * VoiceOver announces it with the group. Targets are 48px rows. A chosen option
 * may show a per-option stepper and its child group right underneath it.
 */
export function ChoiceGroup({ name, rule, required, met, mode, maxSelect, maxPerOption, options, value, onChange, errorMessage, renderUnder, parentLabel, isDisabled, className }: ChoiceGroupProps) {
  const chosen = new Set(value.map((v) => v.id));
  const full = maxSelect != null && value.length >= maxSelect;
  const ruleTone = errorMessage ? "text-status-alert" : required && !met ? "text-status-sent" : "text-ink-3";

  const setQuantity = (id: string, quantity: number) => onChange(value.map((v) => (v.id === id ? { ...v, quantity } : v)));

  const under = (option: ChoiceOption) => {
    if (!chosen.has(option.id)) return null;
    const stepper = maxPerOption > 1 ? <GuestStepper value={value.find((v) => v.id === option.id)?.quantity ?? 1} onChange={(q) => setQuantity(option.id, q)} min={1} max={maxPerOption} label={option.name} /> : null;
    const child = renderUnder?.(option.id) ?? null;
    if (!stepper && !child) return null;
    return (
      <div className="flex flex-col gap-3 bg-surface-2 px-4 py-3">
        {stepper ? (
          <div className="flex items-center justify-between gap-3">
            <span className="text-caption text-ink-3">How many (up to {maxPerOption})</span>
            {stepper}
          </div>
        ) : null}
        {child}
      </div>
    );
  };

  const heading = (
    <div className="mb-2 flex items-baseline justify-between gap-3">
      <Label className="font-display text-[16px] font-semibold text-ink">
        {name}
        {parentLabel ? <span className="font-sans text-body text-ink-2"> · for {parentLabel}</span> : null}
      </Label>
      <Text slot="description" className={cx("shrink-0 rounded-chip px-2 py-0.5 text-[12.5px] font-medium", ruleTone, required && !met && !errorMessage && "bg-status-sent-tint")} role={errorMessage ? "alert" : undefined}>
        {errorMessage ?? rule}
      </Text>
    </div>
  );

  if (mode === "single") {
    return (
      <AriaRadioGroup
        value={value[0]?.id ?? null}
        onChange={(id) => onChange([{ id, quantity: 1 }])}
        isRequired={required}
        isInvalid={Boolean(errorMessage)}
        isDisabled={isDisabled}
        className={cx("flex flex-col", className)}
      >
        {heading}
        <div className={card}>
          {options.map((o) => (
            <div key={o.id}>
              <AriaRadio value={o.id} isDisabled={o.isDisabled} className={row}>
                {({ isSelected }) => (
                  <>
                    <Mark shape="radio" selected={isSelected} />
                    <OptionText option={o} />
                  </>
                )}
              </AriaRadio>
              {under(o)}
            </div>
          ))}
        </div>
      </AriaRadioGroup>
    );
  }

  return (
    <AriaCheckboxGroup
      value={value.map((v) => v.id)}
      onChange={(ids) => {
        // Replace when the group allows one at a time; otherwise keep quantities for options that stay chosen.
        const next = maxSelect === 1 && ids.length > 1 ? [ids[ids.length - 1]!] : ids;
        onChange(next.map((id) => value.find((v) => v.id === id) ?? { id, quantity: 1 }));
      }}
      isRequired={required}
      isInvalid={Boolean(errorMessage)}
      isDisabled={isDisabled}
      className={cx("flex flex-col", className)}
    >
      {heading}
      <div className={card}>
        {options.map((o) => (
          <div key={o.id}>
            <AriaCheckbox value={o.id} isDisabled={o.isDisabled || (full && !chosen.has(o.id) && maxSelect !== 1)} className={row}>
              {({ isSelected }) => (
                <>
                  <Mark shape="check" selected={isSelected} />
                  <OptionText option={o} />
                </>
              )}
            </AriaCheckbox>
            {under(o)}
          </div>
        ))}
      </div>
    </AriaCheckboxGroup>
  );
}
