"use client";

import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button as AriaButton, Link as AriaLink, type ButtonProps as AriaButtonProps, type LinkProps as AriaLinkProps } from "react-aria-components";
import { cx, withClass } from "../lib/cx";
import { Icon } from "./Icon";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "destructive";
/**
 * `md` is the 44px minimum (back office default); `lg` is the 56px POS standard; `sm` is the 36px desktop button for
 * back-office toolbars and table headers (opt-in, pointer screens only: never on the POS).
 */
export type ButtonSize = "sm" | "md" | "lg";

/** Pills. Disabled changes fill and ink rather than fading the whole button (opacity alone is not a state). */
const base =
  "press inline-flex items-center justify-center gap-2 rounded-chip border font-sans whitespace-nowrap select-none " +
  "touch-manipulation outline-none cursor-default " +
  "data-[pressed]:scale-[0.97] data-[disabled]:cursor-not-allowed " +
  "data-[disabled]:border-transparent data-[disabled]:bg-surface-2 data-[disabled]:text-ink-disabled " +
  "data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus";

const variants: Record<ButtonVariant, string> = {
  primary:
    "border-transparent bg-primary font-semibold text-on-primary data-[hovered]:bg-[color-mix(in_oklab,var(--primary),var(--surface)_12%)] data-[pressed]:bg-[color-mix(in_oklab,var(--primary),var(--surface)_20%)]",
  secondary: "border-transparent bg-surface-2 font-medium text-ink data-[hovered]:bg-surface-3 data-[pressed]:bg-surface-3",
  // A quiet control that cannot be used fades its ink only: a grey fill made disabled arrows look more pressable.
  quiet: "border-transparent bg-transparent font-medium text-ink data-[hovered]:bg-surface-2 data-[pressed]:bg-surface-3 data-[disabled]:bg-transparent!",
  destructive:
    "border-transparent bg-status-alert font-semibold text-on-primary data-[hovered]:bg-[color-mix(in_oklab,var(--status-alert),var(--ink)_12%)] data-[pressed]:bg-[color-mix(in_oklab,var(--status-alert),var(--ink)_20%)]",
};

const sizes: Record<ButtonSize, { text: string; icon: string }> = {
  sm: { text: "min-h-9 px-3.5 text-[14px] leading-5", icon: "min-h-9 min-w-9 px-0 text-[14px]" },
  md: { text: "min-h-11 px-4 text-line", icon: "min-h-11 min-w-11 px-0 text-line" },
  lg: { text: "min-h-14 px-6 text-line", icon: "min-h-14 min-w-14 px-0 text-line" },
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
