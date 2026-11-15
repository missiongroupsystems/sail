"use client";

import { Banner, Icon, SailLogo, TopTabs, useLocale } from "@sail/ui";
import { ChevronLeft, Lock } from "lucide-react";
import type { ReactNode } from "react";
import { Button as AriaButton } from "react-aria-components";
import { useApi } from "../hooks/useApi";
import { useNow } from "../lib/device";
import { lockStation } from "../lib/lock";
import { useNavStore } from "../state/nav";
import { useConnectionStore } from "../state/ui";
import { usePos } from "./PosContext";
import { PrintBanner } from "./PrintBanner";
import { UserMenu } from "./UserMenu";

export type SubHeader = {
  /** "‹ Floor": back is always first in the row, labelled with where it goes. */
  back?: { label: string; onPress: () => void };
  /** The screen's noun, 20pt: "Table 1", "Pay", "Shift". */
  title: ReactNode;
  /** One quiet line after the title: "2 guests · Dine-in · 0:42". */
  meta?: ReactNode;
  /** Actions at the right of the row (the order menu, the split mode, the shift sections). */
  actions?: ReactNode;
};

export type FrameProps = {
  /** Inner screens: the second row under the top bar. Home screens (Floor, Orders) have none. */
  sub?: SubHeader;
  children: ReactNode;
};

const TABS = [
  { id: "floor", label: "Floor" },
  { id: "orders", label: "Orders" },
  { id: "shift", label: "Shift" },
];

/** Grey pill for quiet actions in the bars: 44pt, ink-2 until hovered. */
export const BAR_BUTTON =
  "press pos-touch flex min-h-11 items-center gap-1.5 rounded-chip px-3.5 text-[14.5px] font-medium text-ink-2 outline-none transition-colors duration-[120ms] data-[hovered]:bg-surface-2 data-[hovered]:text-ink data-[pressed]:scale-[0.97] data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus";

/**
 * The station frame: one 56pt top bar that never changes (the wordmark, the three destinations, the station, who is
 * signed in, Lock, the connection and the clock), a banner only when there is something to say, an optional second
 * row for inner screens (back, title, meta, actions) and the screen on the sunken canvas.
 */
export function Frame({ sub, children }: FrameProps) {
  const screen = useNavStore((s) => s.screen);
  const go = useNavStore((s) => s.go);
  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-rule bg-surface pr-3 pl-5">
        <SailLogo size="bar" className="pr-3" />
        <TopTabs tabs={TABS} selectedId={screen.kind} onSelect={(id) => go({ kind: id as "floor" | "orders" | "shift" })} />
        <StationName />
        <div className="ml-auto flex items-center gap-1">
          <span aria-hidden className="mx-1.5 h-6 w-px bg-rule" />
          <UserMenu />
          <LockButton />
          <Clock />
        </div>
      </header>
      <ConnectionBanner />
      <main className="flex min-h-0 flex-1 flex-col">
        {sub ? <SubRow {...sub} /> : null}
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </main>
    </>
  );
}

function StationName() {
  const { outlet, station } = usePos();
  return <p className="mx-auto hidden min-w-0 truncate px-3 text-[14px] text-ink-2 min-[1000px]:block">{[outlet?.name, station.name].filter(Boolean).join(" · ")}</p>;
}

/** The second row of an inner screen: back, title and meta at left, actions at right. */
function SubRow({ back, title, meta, actions }: SubHeader) {
  return (
    <header className="flex min-h-14 shrink-0 items-center gap-3 px-4 pt-1">
      {back ? (
        <AriaButton onPress={back.onPress} className={BAR_BUTTON + " gap-1 pr-4 pl-2.5 text-[15px]"}>
          <Icon icon={ChevronLeft} size={20} />
          {back.label}
        </AriaButton>
      ) : null}
      <h1 className="flex min-w-0 flex-1 items-baseline gap-2.5 font-heading text-[20px] font-semibold tracking-[-0.01em] text-ink">
        <span className="shrink-0 truncate">{title}</span>
        {meta ? <span className="truncate font-sans text-[14.5px] font-normal tracking-normal text-ink-2">{meta}</span> : null}
      </h1>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** Lock: end this person's session on the register and go to the PIN pad; the screen they were on stays. */
function LockButton() {
  const api = useApi();
  return (
    <AriaButton
      onPress={() => void lockStation(api, "Locked. Sign in to continue.")}
      className={BAR_BUTTON}
    >
      <Icon icon={Lock} size={16} />
      Lock
    </AriaButton>
  );
}

const dot = { online: "bg-status-paid", reconnecting: "bg-status-sent", offline: "bg-status-alert" } as const;
const word = { online: "online", reconnecting: "reconnecting…", offline: "offline" } as const;

/** The connection dot and the outlet's clock. Not online, the word shows too; the banner under the bar carries the "as of" time, so the bar never shows two times. */
function Clock() {
  const { clock } = useLocale();
  const { status, asOf } = useConnectionStore();
  const now = useNow(15_000);
  return (
    <span className="flex min-h-11 items-center gap-2 pr-2 pl-1.5 text-[14px] font-medium whitespace-nowrap text-ink tabular">
      <span aria-hidden className={"inline-block size-2 rounded-full " + dot[status]} />
      {/* Only the connection is announced; the clock would otherwise be read out every minute. */}
      <span role="status" aria-live="polite" className={status === "online" ? "sr-only" : status === "offline" ? "text-status-alert" : "text-status-sent"}>
        {word[status]}
        {status !== "online" && asOf ? <span className="sr-only"> · as of {clock(new Date(asOf))}</span> : null}
      </span>
      <span>{clock(new Date(now))}</span>
    </span>
  );
}

/** The one banner: the connection first, otherwise the print failure alert. Nothing is reserved when all is well. */
function ConnectionBanner() {
  const { clock } = useLocale();
  const { status, asOf, recoveredAt } = useConnectionStore();
  const now = useNow(1000);
  if (status !== "online") {
    return (
      <Slot>
        <Banner tone={status === "reconnecting" ? "waiting" : "alert"}>
          {status === "reconnecting" ? "Connection lost · reconnecting…" : <>Connection lost · offline{asOf ? ` · as of ${clock(new Date(asOf))}` : ""} · reading the last known state</>}
        </Banner>
      </Slot>
    );
  }
  if (recoveredAt && now - recoveredAt < 4000)
    return (
      <Slot>
        <Banner tone="success">Connected · caught up with the register</Banner>
      </Slot>
    );
  return <PrintBanner wrap={(b) => <Slot>{b}</Slot>} />;
}

function Slot({ children }: { children: ReactNode }) {
  return <div className="animate-rise-in shrink-0 border-b border-rule-subtle">{children}</div>;
}
