import type { LucideIcon } from "lucide-react";
import { Icon } from "@sail/ui";
import type { ReactNode } from "react";

/**
 * A full-page, one-idea notice (empty and error states): one icon, a heading, one line of what to do and at most
 * one action under the thumb, centred on the page.
 */
export function Notice({ title, body, icon, tone = "neutral", children }: { title: string; body?: ReactNode; icon?: LucideIcon; tone?: "neutral" | "warning"; children?: ReactNode }) {
  return (
    <main className="flex min-h-dvh w-full flex-col items-center justify-center gap-4 px-8 pb-16 text-center">
      {icon ? (
        <span className={`flex size-14 items-center justify-center rounded-full ${tone === "warning" ? "bg-status-sent-tint text-status-sent" : "bg-surface-2 text-ink"}`}>
          <Icon icon={icon} size={24} />
        </span>
      ) : null}
      <h1 className="font-display text-[22px] leading-tight font-semibold tracking-tight text-balance text-ink wrap-anywhere">{title}</h1>
      {body ? <p className="max-w-[32ch] text-[15.5px] leading-relaxed text-pretty text-ink-2">{body}</p> : null}
      {children ? <div className="mt-2 flex w-full max-w-[280px] flex-col gap-2">{children}</div> : null}
    </main>
  );
}

function Bar({ className }: { className: string }) {
  return <div className={`animate-skeleton bg-surface-3 ${className}`} />;
}

/** First load only: a quiet skeleton in the menu's shape, never a full-screen spinner. */
export function LoadingMenu() {
  return (
    <main className="w-full" aria-busy="true" aria-label="Loading the menu">
      <div className="flex items-start justify-between gap-3 px-4 pt-[max(20px,env(safe-area-inset-top))] pb-3">
        <div className="flex flex-col gap-2 pt-1">
          <Bar className="h-3.5 w-24 rounded-md" />
          <Bar className="h-7 w-44 rounded-lg" />
        </div>
        <Bar className="mt-1 h-11 w-28 rounded-full" />
      </div>
      <div className="flex h-14 items-center gap-2 border-b border-rule-subtle pl-4">
        {["w-28", "w-20", "w-[72px]", "w-24"].map((w) => (
          <Bar key={w} className={`h-11 shrink-0 rounded-full ${w}`} />
        ))}
      </div>
      <div className="flex flex-col gap-5 px-4 py-5">
        <Bar className="h-6 w-28 rounded-lg" />
        {[0, 1, 2, 3, 4, 5].map((row) => (
          <div key={row} className="flex items-center gap-3">
            <div className="flex flex-1 flex-col gap-2">
              <Bar className="h-5 w-2/3 rounded-md" />
              <Bar className="h-4 w-16 rounded-md" />
            </div>
            <Bar className="size-11 rounded-full" />
          </div>
        ))}
      </div>
    </main>
  );
}
