"use client";

import { Banner, BannerSlot, ConnectionIndicator, TopBar, TopTabs, useLocale } from "@sail/ui";
import type { ReactNode } from "react";
import { useNow } from "../lib/device";
import { useNavStore } from "../state/nav";
import { useConnectionStore } from "../state/ui";
import { PrintBanner } from "./PrintBanner";
import { UserMenu } from "./UserMenu";

export type FrameProps = {
  /** Back button inside an order; otherwise the three destination tabs. */
  left?: ReactNode;
  title?: ReactNode;
  /** Extra controls before the user menu (the order menu). */
  right?: ReactNode;
  children: ReactNode;
};

const TABS = [
  { id: "floor", label: "Floor" },
  { id: "orders", label: "Orders" },
  { id: "shift", label: "Shift" },
];

/** Top bar (56pt), the reserved banner slot (48pt) and the screen. */
export function Frame({ left, title, right, children }: FrameProps) {
  const { clock } = useLocale();
  const screen = useNavStore((s) => s.screen);
  const go = useNavStore((s) => s.go);
  const { status, asOf } = useConnectionStore();
  return (
    <>
      <TopBar
        left={left ?? <TopTabs tabs={TABS} selectedId={screen.kind} onSelect={(id) => go({ kind: id as "floor" | "orders" | "shift" })} />}
        title={title}
        right={
          <>
            {right}
            <UserMenu />
            <ConnectionIndicator status={status} asOf={asOf ? clock(new Date(asOf)) : null} className="ml-1" />
          </>
        }
      />
      <BannerSlot>
        <ConnectionBanner />
      </BannerSlot>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </>
  );
}

/** The one banner slot: the connection first, otherwise the print failure alert. */
function ConnectionBanner() {
  const { clock } = useLocale();
  const { status, asOf, recoveredAt } = useConnectionStore();
  const now = useNow(1000);
  if (status !== "online") {
    return (
      <Banner tone={status === "reconnecting" ? "waiting" : "alert"}>
        {status === "reconnecting" ? "Connection lost · reconnecting…" : <>Connection lost · offline{asOf ? ` · as of ${clock(new Date(asOf))}` : ""} · reading the last known state</>}
      </Banner>
    );
  }
  if (recoveredAt && now - recoveredAt < 4000) return <Banner tone="success">Connected · caught up with the register</Banner>;
  return <PrintBanner />;
}
