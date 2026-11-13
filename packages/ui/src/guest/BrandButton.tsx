"use client";

import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button as AriaButton, type ButtonProps as AriaButtonProps } from "react-aria-components";
import { cx } from "../lib/cx";
import { Icon } from "../components/Icon";

export type BrandButtonVariant = "accent" | "secondary" | "outline" | "quiet" | "destructive";

const base =
  "press inline-flex min-h-12 items-center justify-center gap-2 rounded-chip border px-5 font-sans text-[15.5px] select-none touch-manipulation outline-none cursor-default transition-colors duration-[120ms] " +
  "data-[pressed]:scale-[0.98] data-[disabled]:cursor-not-allowed " +
  "data-[disabled]:border-transparent data-[disabled]:bg-surface-2 data-[disabled]:text-ink-disabled " +
  "data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus";

/** The accent pill is the screen's one primary action; the grey pill sits beside it; outline and quiet are for headers and rows. */
const variants: Record<BrandButtonVariant, string> = {
  accent: "border-transparent bg-brand-accent font-semibold text-on-brand-accent data-[hovered]:brightness-110 data-[pressed]:brightness-90",
  secondary: "border-transparent bg-surface-2 font-medium text-ink data-[hovered]:bg-surface-3 data-[pressed]:bg-surface-3",
  outline: "border-rule-strong bg-surface font-medium text-ink data-[hovered]:bg-surface-2 data-[pressed]:bg-surface-2",
  quiet: "border-transparent bg-transparent font-medium text-ink-2 data-[hovered]:bg-surface-2 data-[hovered]:text-ink data-[pressed]:bg-surface-2",
  destructive: "border-transparent bg-transparent font-medium text-status-alert data-[hovered]:bg-status-alert-tint data-[pressed]:bg-status-alert-tint",
};

export type BrandButtonProps = Omit<AriaButtonProps, "className" | "children"> & {
  variant?: BrandButtonVariant;
  /** Full width: the one primary action at the bottom of a guest screen. */
  block?: boolean;
  className?: string;
  /** A verb with its object: "Add to order", "Send to kitchen", "Call staff". */
  children: ReactNode;
};

/**
 * The guest app's button: the brand accent shows here, on a 48px
 * target (7.5). Labels are verbs; amounts in them come from the register.
 */
export function BrandButton({ variant = "secondary", block = false, className, children, isPending, ...rest }: BrandButtonProps) {
  return (
    <AriaButton {...rest} isPending={isPending} className={cx(base, variants[variant], block && "w-full", className)}>
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
