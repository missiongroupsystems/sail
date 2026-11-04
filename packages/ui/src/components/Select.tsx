"use client";

import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import {
  Button,
  FieldError,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Select as AriaSelect,
  SelectValue,
  Text,
  type Key,
} from "react-aria-components";
import { cx } from "../lib/cx";
import { fieldControl, fieldDescription, fieldError, fieldLabel, fieldWrap } from "./field";
import { Icon } from "./Icon";

export type SelectItem = {
  id: string;
  label: string;
  description?: string;
  isDisabled?: boolean;
};

export type SelectProps = {
  label?: ReactNode;
  description?: ReactNode;
  errorMessage?: string;
  items: SelectItem[];
  /** `null` shows the placeholder. */
  selectedKey: string | null;
  onSelectionChange: (key: string | null) => void;
  placeholder?: string;
  name?: string;
  isDisabled?: boolean;
  isRequired?: boolean;
  isInvalid?: boolean;
  /** Accessible name when there is no visible label. */
  "aria-label"?: string;
  className?: string;
  /** Compact trigger for toolbars and filters (still 44px tall). */
  variant?: "field" | "toolbar";
};

export const listBoxClass = "max-h-[min(50vh,360px)] overflow-auto p-1 outline-none";
export const popoverClass =
  "min-w-(--trigger-width) rounded-tile bg-surface hairline shadow-sheet outline-none " +
  "data-[entering]:animate-rise-in data-[exiting]:animate-rise-out";
export const listItemClass =
  "flex min-h-11 cursor-default items-center justify-between gap-3 rounded-[6px] px-3 py-2 text-body text-ink outline-none " +
  "data-[hovered]:bg-surface-2 data-[focused]:bg-surface-2 data-[pressed]:bg-surface-2 data-[disabled]:opacity-45 data-[selected]:font-medium";

export function Select({
  label,
  description,
  errorMessage,
  items,
  selectedKey,
  onSelectionChange,
  placeholder = "Choose…",
  className,
  variant = "field",
  ...rest
}: SelectProps) {
  return (
    <AriaSelect
      {...rest}
      selectedKey={selectedKey}
      onSelectionChange={(key: Key | null) => onSelectionChange(key === null ? null : String(key))}
      placeholder={placeholder}
      className={cx(fieldWrap, className)}
    >
      {label ? <Label className={fieldLabel}>{label}</Label> : null}
      <Button
        className={cx(
          fieldControl,
          "flex items-center justify-between gap-2 text-left press data-[pressed]:scale-[0.99]",
          variant === "toolbar" && "w-auto min-w-40",
        )}
      >
        <SelectValue className="truncate data-[placeholder]:text-ink-2/70" />
        <Icon icon={ChevronDown} size={18} className="text-ink-2" />
      </Button>
      {description ? (
        <Text slot="description" className={fieldDescription}>
          {description}
        </Text>
      ) : null}
      <FieldError className={fieldError}>{errorMessage}</FieldError>
      <Popover className={popoverClass} offset={4}>
        <ListBox items={items} className={listBoxClass}>
          {(item) => (
            <ListBoxItem id={item.id} textValue={item.label} isDisabled={item.isDisabled} className={listItemClass}>
              {({ isSelected }) => (
                <>
                  <span className="min-w-0">
                    <span className="block truncate">{item.label}</span>
                    {item.description ? <span className="block truncate text-caption text-ink-2">{item.description}</span> : null}
                  </span>
                  {isSelected ? <Icon icon={Check} size={16} /> : <span className="size-4" />}
                </>
              )}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </AriaSelect>
  );
}
