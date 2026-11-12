"use client";

import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button as AriaButton, Link as AriaLink, type ButtonProps as AriaButtonProps, type LinkProps as AriaLinkProps } from "react-aria-components";
import { cx, withClass } from "../lib/cx";
import { Icon } from "./Icon";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "destructive";
/** `md` is the 44px minimum (back office); `lg` is the 56px POS standard. */
export type ButtonSize = "md" | "lg";

const base =
  "press inline-flex items-center justify-center gap-2 rounded-tile font-sans text-line whitespace-nowrap select-none " +
  "touch-manipulation outline-none cursor-default " +
  "data-[pressed]:scale-[0.97] data-[disabled]:opacity-45 data-[disabled]:cursor-not-allowed " +
  "data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-status-seated";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-primary text-on-primary data-[hovered]:brightness-110 data-[pressed]:brightness-90",
  secondary: "bg-surface text-ink hairline data-[hovered]:bg-surface-2 data-[pressed]:bg-surface-2",
  quiet: "bg-transparent text-ink data-[hovered]:bg-surface-2 data-[pressed]:bg-surface-2",
  destructive:
    "bg-surface text-status-alert hairline data-[hovered]:bg-[color-mix(in_srgb,var(--status-alert)_8%,transparent)] data-[pressed]:bg-[color-mix(in_srgb,var(--status-alert)_14%,transparent)]",
};

const sizes: Record<ButtonSize, { text: string; icon: string }> = {
  md: { text: "min-h-11 px-4", icon: "min-h-11 min-w-11 px-0" },
  lg: { text: "min-h-14 px-5", icon: "min-h-14 min-w-14 px-0" },
};

export type ButtonProps = Omit<AriaButtonProps, "className" | "children"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Icon-only buttons must carry an `aria-label` (POS: every action also has a visible label). */
  iconOnly?: boolean;
  className?: string;
  /** Always a verb phrase: "Add outlet", "Save changes", never "OK" or "Submit". */
  children: ReactNode;
};

export function Button({ variant = "secondary", size = "md", iconOnly = false, className, children, isPending, ...rest }: ButtonProps) {
  return (
    <AriaButton
      {...rest}
      isPending={isPending}
      className={cx(base, variants[variant], iconOnly ? sizes[size].icon : sizes[size].text, className)}
    >
      {isPending ? (
        <>
          <Icon icon={Loader2} size={18} className="keep-motion animate-spin" />
          <span className="opacity-70">{children}</span>
        </>
      ) : (
        children
      )}
    </AriaButton>
  );
}

export type LinkButtonProps = Omit<AriaLinkProps, "className" | "children"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  iconOnly?: boolean;
  className?: string;
  children: ReactNode;
};

/** A link that looks like a button, for navigation that reads as an action ("Open outlet"). */
export function LinkButton({ variant = "secondary", size = "md", iconOnly = false, className, children, ...rest }: LinkButtonProps) {
  return (
    <AriaLink {...rest} className={withClass(cx(base, variants[variant], iconOnly ? sizes[size].icon : sizes[size].text, className), undefined)}>
      {children}
    </AriaLink>
  );
}
