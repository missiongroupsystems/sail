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
        // One line of label centres on the toggle; with a description under it, the toggle sits by the first line.
        "group flex min-h-11 cursor-default gap-3 py-2 text-body text-ink outline-none data-[disabled]:text-ink-disabled",
        description ? "items-start" : "items-center",
        className,
      )}
    >
      <span
        aria-hidden
        className={cx(
          description ? "mt-0.5" : null,
          "inline-flex h-5 w-[34px] shrink-0 items-center rounded-chip bg-control-off p-0.5 transition-colors duration-[120ms]",
          "group-data-[selected]:bg-primary group-data-[disabled]:bg-surface-3 group-data-[selected]:group-data-[disabled]:bg-ink-disabled",
          "group-data-[focus-visible]:outline-2 group-data-[focus-visible]:outline-offset-2 group-data-[focus-visible]:outline-focus",
        )}
      >
        <span className="size-4 rounded-full bg-surface shadow-thumb transition-transform duration-[120ms] ease-(--ease-enter) group-data-[selected]:translate-x-[14px]" />
      </span>
      <span className="flex flex-col">
        <span>{children}</span>
        {description ? <span className="text-caption text-ink-3">{description}</span> : null}
      </span>
    </AriaSwitch>
  );
}
