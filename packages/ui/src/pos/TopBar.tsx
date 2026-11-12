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
    <header className={cx("flex h-14 shrink-0 items-center gap-4 px-3 hairline-b bg-surface", className)}>
      <div className="flex min-w-0 shrink-0 items-center gap-1">{left}</div>
      <div className="min-w-0 flex-1 truncate text-center text-line text-ink">{title}</div>
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
              "press pos-touch relative flex min-h-11 items-center gap-2 rounded-tile px-4 text-line outline-none",
              selected ? "bg-surface-2 text-ink" : "text-ink-2 data-[hovered]:bg-surface-2",
              "data-[pressed]:scale-[0.97] data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-status-seated",
            )}
          >
            {t.label}
            {t.badge ? <span className="rounded-chip bg-ink px-2 text-caption text-surface tabular">{t.badge}</span> : null}
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
      className="press pos-touch flex min-h-11 items-center gap-1 rounded-tile pr-3 pl-2 text-line text-ink outline-none data-[hovered]:bg-surface-2 data-[pressed]:scale-[0.97] data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-status-seated"
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
    <span className={cx("inline-flex items-center gap-2 whitespace-nowrap text-caption text-ink-2", className)} role="status" aria-live="polite">
      <span aria-hidden className={cx("inline-block size-2 rounded-full", dot[status])} />
      <span>
        {word[status]}
        {status !== "online" && asOf ? <span className="tabular"> · as of {asOf}</span> : null}
      </span>
    </span>
  );
}
