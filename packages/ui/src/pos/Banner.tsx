"use client";

import { AlertTriangle, CheckCircle2, Info, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import { Icon } from "../components/Icon";

export type BannerTone = "alert" | "waiting" | "success" | "info";

export type BannerProps = {
  tone: BannerTone;
  children: ReactNode;
  actions?: ReactNode;
  /** Others queued behind this one ("+2"). */
  queued?: number;
  className?: string;
};

const tones: Record<BannerTone, { icon: typeof Info; cls: string }> = {
  alert: { icon: AlertTriangle, cls: "bg-status-alert-tint text-ink" },
  waiting: { icon: Loader2, cls: "bg-status-sent-tint text-ink" },
  success: { icon: CheckCircle2, cls: "bg-status-paid-tint text-ink" },
  info: { icon: Info, cls: "bg-surface-2 text-ink" },
};

/** An L4 banner: full width under the top bar, never a modal, never over the action dock. */
export function Banner({ tone, children, actions, queued, className }: BannerProps) {
  const t = tones[tone];
  return (
    <div role={tone === "alert" ? "alert" : "status"} aria-live={tone === "alert" ? "assertive" : "polite"} className={cx("flex h-12 items-center gap-3 px-5 text-[14.5px] font-medium", t.cls, className)}>
      <Icon icon={t.icon} size={18} className={cx(tone === "alert" && "text-status-alert", tone === "success" && "text-status-paid", tone === "waiting" && "keep-motion animate-spin text-status-sent")} />
      <div className="min-w-0 flex-1 truncate">{children}</div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      {queued ? <span className="shrink-0 text-caption font-normal text-ink-2 tabular">+{queued}</span> : null}
    </div>
  );
}

/** The reserved 48pt slot: present whether or not a banner shows, so nothing jumps. */
export function BannerSlot({ children, className }: { children?: ReactNode; className?: string }) {
  return <div className={cx("h-12 shrink-0 overflow-hidden", className)}>{children ? <div className="animate-rise-in h-full">{children}</div> : null}</div>;
}
