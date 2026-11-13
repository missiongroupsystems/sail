"use client";

import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Button as AriaButton } from "react-aria-components";
import { cx } from "../lib/cx";
import { Icon } from "../components/Icon";

export type TopBarProps = {
  /** Destination tabs, or a back button when inside an order. */
  left: ReactNode;
  /** The screen's noun: "Casa · Main dining", "Table 12 · 4 guests · Dine-in · 0:42". */
  title?: ReactNode;
  right: ReactNode;
  className?: string;
};

/** The POS top bar: 56pt, destinations left, user menu and connection right. */
export function TopBar({ left, title, right, className }: TopBarProps) {
  return (
    <header className={cx("flex h-14 shrink-0 items-center gap-4 border-b border-rule-subtle bg-surface px-3", className)}>
      <div className="flex min-w-0 shrink-0 items-center gap-1">{left}</div>
      <div className="min-w-0 flex-1 truncate text-center text-line font-medium text-ink">{title}</div>
      <div className="flex shrink-0 items-center gap-2">{right}</div>
    </header>
  );
}

export type TopTab = { id: string; label: string; badge?: number };

export type TopTabsProps = {
  tabs: TopTab[];
  selectedId: string;
  onSelect: (id: string) => void;
};

/** Floor | Orders | Shift: three destinations, no more. */
export function TopTabs({ tabs, selectedId, onSelect }: TopTabsProps) {
  return (
    <nav aria-label="Destinations" className="flex items-center gap-1">
      {tabs.map((t) => {
        const selected = t.id === selectedId;
        return (
          <AriaButton
            key={t.id}
            aria-current={selected ? "page" : undefined}
            onPress={() => onSelect(t.id)}
            className={cx(
              "press pos-touch relative flex min-h-11 items-center gap-2 rounded-chip px-4 text-[15px] outline-none transition-colors duration-[120ms]",
              selected ? "bg-surface-2 font-medium text-ink" : "text-ink-2 data-[hovered]:bg-surface-2 data-[hovered]:text-ink",
              "data-[pressed]:scale-[0.97] data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus",
            )}
          >
            {t.label}
            {t.badge ? <span className="flex h-5 min-w-5 items-center justify-center rounded-chip bg-primary px-1.5 text-[11.5px] font-semibold text-on-primary tabular">{t.badge}</span> : null}
          </AriaButton>
        );
      })}
    </nav>
  );
}

/** "◂ Floor": back is always top left, labelled with where it goes. */
export function BackButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <AriaButton
      onPress={onPress}
      className="press pos-touch flex min-h-11 items-center gap-1 rounded-chip pr-3 pl-2 text-[15px] text-ink-2 outline-none transition-colors duration-[120ms] data-[hovered]:bg-surface-2 data-[hovered]:text-ink data-[pressed]:scale-[0.97] data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus"
    >
      <Icon icon={ChevronLeft} size={20} />
      {label}
    </AriaButton>
  );
}

export type ConnectionStatus = "online" | "reconnecting" | "offline";

export type ConnectionIndicatorProps = {
  status: ConnectionStatus;
  /** Clock text shown with "as of" when not online: "8:24 pm". */
  asOf?: string | null;
  className?: string;
};

const dot: Record<ConnectionStatus, string> = { online: "bg-status-paid", reconnecting: "bg-status-sent", offline: "bg-status-alert" };
const word: Record<ConnectionStatus, string> = { online: "online", reconnecting: "reconnecting…", offline: "offline" };

/** The connection indicator: online, reconnecting, offline with the "as of" time. */
export function ConnectionIndicator({ status, asOf, className }: ConnectionIndicatorProps) {
  return (
    <span className={cx("inline-flex items-center gap-2 whitespace-nowrap text-caption font-medium text-ink", className)} role="status" aria-live="polite">
      <span aria-hidden className={cx("inline-block size-[7px] rounded-full", dot[status])} />
      <span>
        {word[status]}
        {status !== "online" && asOf ? <span className="tabular"> · as of {asOf}</span> : null}
      </span>
    </span>
  );
}
