"use client";

import { Minus, Plus } from "lucide-react";
import { Button as AriaButton } from "react-aria-components";
import { cx } from "../lib/cx";
import { Icon } from "../components/Icon";

export type GuestStepperProps = {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  /** Accessible name for the group: "Quantity", "Extra shot". */
  label?: string;
  className?: string;
};

const key =
  "press flex size-12 items-center justify-center rounded-chip bg-surface-2 text-ink outline-none touch-manipulation select-none transition-colors duration-[120ms] " +
  "data-[pressed]:scale-[0.97] data-[pressed]:bg-surface-3 data-[disabled]:text-ink-disabled " +
  "data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus";

/** A quantity stepper with 48px keys (the guest minimum) and the value in tabular figures. */
export function GuestStepper({ value, onChange, min = 1, max = 50, label = "Quantity", className }: GuestStepperProps) {
  return (
    <div className={cx("inline-flex items-center gap-2", className)} role="group" aria-label={label}>
      <AriaButton onPress={() => onChange(Math.max(min, value - 1))} isDisabled={value <= min} aria-label={`Fewer ${label.toLowerCase()}`} className={key}>
        <Icon icon={Minus} size={20} />
      </AriaButton>
      <output className="min-w-10 text-center font-heading text-[20px] font-semibold tabular text-ink" aria-live="polite" aria-label={label}>
        {value}
      </output>
      <AriaButton onPress={() => onChange(Math.min(max, value + 1))} isDisabled={value >= max} aria-label={`More ${label.toLowerCase()}`} className={key}>
        <Icon icon={Plus} size={20} />
      </AriaButton>
    </div>
  );
}
