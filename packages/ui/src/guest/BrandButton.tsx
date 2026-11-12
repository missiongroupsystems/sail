"use client";

import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button as AriaButton, type ButtonProps as AriaButtonProps } from "react-aria-components";
import { cx } from "../lib/cx";
import { Icon } from "../components/Icon";

export type BrandButtonVariant = "accent" | "secondary" | "quiet" | "destructive";

const base =
  "press inline-flex min-h-12 items-center justify-center gap-2 rounded-tile px-5 font-sans text-line select-none touch-manipulation outline-none cursor-default " +
  "data-[pressed]:scale-[0.97] data-[disabled]:opacity-45 data-[disabled]:cursor-not-allowed " +
  "data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-status-seated";

const variants: Record<BrandButtonVariant, string> = {
  accent: "bg-brand-accent text-on-brand-accent data-[hovered]:brightness-105 data-[pressed]:brightness-90",
  secondary: "bg-surface text-ink hairline data-[hovered]:bg-surface-2 data-[pressed]:bg-surface-2",
  quiet: "bg-transparent text-ink data-[hovered]:bg-surface-2 data-[pressed]:bg-surface-2",
  destructive: "bg-surface text-status-alert hairline data-[pressed]:bg-[color-mix(in_srgb,var(--status-alert)_14%,transparent)]",
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
