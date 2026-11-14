"use client";

import { CalendarDays, X } from "lucide-react";
import { useId, type ReactNode } from "react";
import { cx } from "../lib/cx";
import { useLocale } from "../lib/locale";
import { fieldDescription, fieldLabel, fieldWrap } from "./field";
import { Icon } from "./Icon";

export type DateFieldProps = {
  /** A visible label; or `aria-label` alone and a `prefix` inside the field ("From"). */
  label?: ReactNode;
  "aria-label"?: string;
  /** A word inside the field before the date: "From", "To". */
  prefix?: string;
  /** "YYYY-MM-DD" (date) or "YYYY-MM-DDTHH:MM" (datetime), as the browser's own control gives it; "" for none. */
  value: string;
  onChange: (value: string) => void;
  type?: "date" | "datetime";
  /** Shown when empty: "Any date". */
  placeholder?: string;
  description?: ReactNode;
  errorMessage?: ReactNode;
  isInvalid?: boolean;
  size?: "sm" | "md";
  className?: string;
};

/**
 * A date written the way people read it ("Fri, 13 Nov 2026"), not the browser's "11/13/2026". The browser's own date
 * control sits over the field, transparent, so a click opens its calendar and the keyboard still types a date.
 */
export function DateField({ label, prefix, value, onChange, type = "date", placeholder = "Any date", description, errorMessage, isInvalid, size = "sm", className, ...rest }: DateFieldProps) {
  const { businessDay } = useLocale();
  const id = useId();
  const [day, time] = value.split("T");
  // After a prefix the placeholder reads on from it: "From any date".
  const shown = value ? `${businessDay(day!)}${type === "datetime" && time ? ` ${time.slice(0, 5)}` : ""}` : prefix ? placeholder.charAt(0).toLowerCase() + placeholder.slice(1) : placeholder;
  return (
    <div className={cx(fieldWrap, className)}>
      {label ? (
        <label htmlFor={id} className={fieldLabel}>
          {label}
        </label>
      ) : null}
      <div
        className={cx(
          "sail-field group relative flex w-full items-center gap-2 rounded-field border border-transparent bg-surface-2 text-ink transition-colors duration-[120ms] has-[:focus-visible]:border-ink has-[:hover]:bg-surface-3",
          size === "sm" ? "min-h-9 max-sm:min-h-11 px-2.5 text-[14px]" : "min-h-11 px-3 text-body",
          isInvalid && "border-status-alert",
        )}
        data-invalid={isInvalid || undefined}
      >
        <Icon icon={CalendarDays} size={16} className="shrink-0 text-ink-3" />
        <span aria-hidden className={cx("min-w-0 flex-1 truncate tabular", !value && "text-ink-3")}>
          {prefix ? <span className="text-ink-2">{prefix} </span> : null}
          {shown}
        </span>
        <input
          id={id}
          type={type === "datetime" ? "datetime-local" : "date"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={rest["aria-label"]}
          aria-invalid={isInvalid || undefined}
          aria-describedby={isInvalid && errorMessage ? `${id}-error` : description ? `${id}-description` : undefined}
          // Typing by keyboard shows the browser's own segments while the field has focus; the pointer still opens the calendar.
          className="absolute inset-0 h-full w-full cursor-pointer rounded-field bg-surface px-2.5 text-[14px] text-ink opacity-0 outline-none focus-visible:opacity-100 [&::-webkit-calendar-picker-indicator]:absolute [&::-webkit-calendar-picker-indicator]:inset-0 [&::-webkit-calendar-picker-indicator]:h-full [&::-webkit-calendar-picker-indicator]:w-full [&::-webkit-calendar-picker-indicator]:cursor-pointer"
        />
        {value ? (
          <button type="button" onClick={() => onChange("")} aria-label={`Clear ${rest["aria-label"] ?? (typeof label === "string" ? label : "the date")}`} className="relative z-10 -mr-1 flex size-7 shrink-0 items-center justify-center rounded-full text-ink-3 outline-none hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-focus">
            <Icon icon={X} size={14} />
          </button>
        ) : null}
      </div>
      {description && !(isInvalid && errorMessage) ? <p id={`${id}-description`} className={fieldDescription}>{description}</p> : null}
      {isInvalid && errorMessage ? <p id={`${id}-error`} className="text-caption text-status-alert">{errorMessage}</p> : null}
    </div>
  );
}
