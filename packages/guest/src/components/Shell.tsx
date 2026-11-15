"use client";

import { Icon } from "@sail/ui";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Button as AriaButton } from "react-aria-components";

/**
 * A page header: a 44px back control, the page's heading (which takes focus when the screen changes) with one
 * line under it, and an optional control at the right. Sticky, on a frosted white with a hairline under it.
 */
export function PageHeader({ title, subtitle, onBack, backLabel, right }: { title: string; subtitle?: ReactNode; onBack: () => void; backLabel: string; right?: ReactNode }) {
  return (
    <header className="sticky top-0 z-20 border-b border-rule-subtle bg-surface/95 backdrop-blur-md">
      <div className="flex min-h-14 items-center gap-1 px-2 pt-[env(safe-area-inset-top)]">
        <AriaButton
          onPress={onBack}
          aria-label={backLabel}
          className="press flex size-11 shrink-0 items-center justify-center rounded-full text-ink outline-none transition-colors duration-[120ms] data-[hovered]:bg-surface-2 data-[pressed]:bg-surface-2 data-[focus-visible]:outline-2 data-[focus-visible]:outline-focus"
        >
          <Icon icon={ChevronLeft} size={24} />
        </AriaButton>
        <div className="min-w-0 flex-1 py-2">
          <h1 tabIndex={-1} className="truncate font-display text-[18px] leading-tight font-semibold tracking-tight text-ink outline-none">
            {title}
          </h1>
          {subtitle ? <p className="truncate text-[13px] text-ink-3">{subtitle}</p> : null}
        </div>
        {right ? <div className="shrink-0 pr-2">{right}</div> : null}
      </div>
    </header>
  );
}

/** The bottom bar that keeps a screen's actions under the thumb, clear of the home bar, in the column's width. */
export function Dock({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-30">
      <div className="mx-auto w-full max-w-[480px] border-t border-rule-subtle bg-surface/95 px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] backdrop-blur-md">{children}</div>
    </div>
  );
}

/** A titled block of a page: "Earlier from this phone", "Your name". */
export function Section({ title, hint, children, className, label }: { title: string; hint?: ReactNode; children: ReactNode; className?: string; label?: string }) {
  return (
    <section aria-label={label} className={`flex flex-col gap-3 ${className ?? ""}`}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-[16px] font-semibold tracking-tight text-ink">{title}</h2>
        {hint ? <span className="text-[13px] text-ink-3">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}
