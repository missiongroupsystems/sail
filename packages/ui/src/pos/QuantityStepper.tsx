"use client";

import { Minus, Plus } from "lucide-react";
import { Button as AriaButton } from "react-aria-components";
import { cx } from "../lib/cx";
import { Icon } from "../components/Icon";

export type QuantityStepperProps = {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  label?: string;
  className?: string;
};

const key =
  "press pos-touch flex size-14 items-center justify-center rounded-tile bg-surface-2 text-ink outline-none " +
  "data-[pressed]:scale-[0.97] data-[pressed]:brightness-90 data-[disabled]:opacity-40 " +
  "data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-status-seated";

/** A quantity stepper with 56pt keys and the value in tabular figures. */
export function QuantityStepper({ value, onChange, min = 1, max = 999, label = "Quantity", className }: QuantityStepperProps) {
  return (
    <div className={cx("inline-flex items-center gap-3", className)} role="group" aria-label={label}>
      <AriaButton onPress={() => onChange(Math.max(min, value - 1))} isDisabled={value <= min} aria-label="Decrease quantity" className={key}>
        <Icon icon={Minus} size={22} />
      </AriaButton>
      <output className="min-w-10 text-center text-title tabular text-ink" aria-live="polite">
        {value}
      </output>
      <AriaButton onPress={() => onChange(Math.min(max, value + 1))} isDisabled={value >= max} aria-label="Increase quantity" className={key}>
        <Icon icon={Plus} size={22} />
      </AriaButton>
    </div>
  );
}
