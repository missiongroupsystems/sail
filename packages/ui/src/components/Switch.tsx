"use client";

import type { ReactNode } from "react";
import { Switch as AriaSwitch, type SwitchProps as AriaSwitchProps } from "react-aria-components";
import { cx } from "../lib/cx";

export type SwitchProps = Omit<AriaSwitchProps, "className" | "children"> & {
  /** The thing being switched, as a noun phrase: "Pay before sending", "Seats". */
  children: ReactNode;
  /** One quiet line under the label. */
  description?: ReactNode;
  className?: string;
};

export function Switch({ children, description, className, ...rest }: SwitchProps) {
  return (
    <AriaSwitch
      {...rest}
      className={cx(
        "group flex min-h-11 cursor-default items-start gap-3 py-2 text-body text-ink outline-none data-[disabled]:opacity-50",
        className,
      )}
    >
      <span
        aria-hidden
        className={cx(
          "mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-chip border border-transparent bg-line p-0.5 press",
          "group-data-[selected]:bg-status-paid group-data-[pressed]:scale-[0.97]",
          "group-data-[focus-visible]:outline-2 group-data-[focus-visible]:outline-offset-2 group-data-[focus-visible]:outline-status-seated",
        )}
      >
        <span className="size-5 rounded-full bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.25)] transition-transform duration-[120ms] ease-(--ease-enter) group-data-[selected]:translate-x-5" />
      </span>
      <span className="flex flex-col">
        <span>{children}</span>
        {description ? <span className="text-caption text-ink-2">{description}</span> : null}
      </span>
    </AriaSwitch>
  );
}
