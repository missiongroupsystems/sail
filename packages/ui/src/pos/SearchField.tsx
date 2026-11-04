"use client";

import { Search, X } from "lucide-react";
import { Button as AriaButton, Input, SearchField as AriaSearchField } from "react-aria-components";
import { cx } from "../lib/cx";
import { Icon } from "../components/Icon";

export type SearchFieldProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Accessible name; the field has no visible label on the POS. */
  label?: string;
  autoFocus?: boolean;
  className?: string;
};

/** The POS search field (design 4.3): 56pt, filters the channel's menu after one character. Never focused automatically. */
export function SearchField({ value, onChange, placeholder = "Search", label = "Search the menu", autoFocus, className }: SearchFieldProps) {
  return (
    <AriaSearchField value={value} onChange={onChange} aria-label={label} autoFocus={autoFocus} className={cx("group relative flex items-center", className)}>
      <Icon icon={Search} size={20} className="pointer-events-none absolute left-3 text-ink-2" />
      <Input
        placeholder={placeholder}
        className="min-h-14 w-full rounded-tile bg-surface-2 pr-12 pl-11 text-line text-ink placeholder:text-ink-2/70 outline-none data-[focused]:ring-2 data-[focused]:ring-status-seated [&::-webkit-search-cancel-button]:hidden"
      />
      <AriaButton
        aria-label="Clear search"
        className={cx("absolute right-1 flex size-12 items-center justify-center rounded-tile text-ink-2 outline-none data-[pressed]:bg-surface group-data-[empty]:hidden")}
      >
        <Icon icon={X} size={20} />
      </AriaButton>
    </AriaSearchField>
  );
}
