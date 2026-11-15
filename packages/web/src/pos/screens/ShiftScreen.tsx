"use client";

import { Pill, SegmentedControl, useLocale } from "@sail/ui";
import { useState } from "react";
import { Frame } from "../components/Frame";
import { usePos } from "../components/PosContext";
import { PrintersView } from "./shift/PrintersView";
import { ShiftHome } from "./shift/ShiftHome";
import { SoldOutView } from "./shift/SoldOutView";
import { BlindNote, ZReportView } from "./shift/ZReportView";
import { DayPanel } from "./shift/DayPanel";
import { ZFigures } from "./shift/ZFigures";
import { useZReport } from "../hooks/queries";
import { roleAtLeast } from "../hooks/useOrderActions";

export type ShiftTab = "shift" | "zreport" | "soldout" | "printers";

const TABS: { id: ShiftTab; label: string }[] = [
  { id: "shift", label: "Shift" },
  { id: "zreport", label: "Z-report" },
  { id: "soldout", label: "Sold out" },
  { id: "printers", label: "Printers" },
];

/** The Shift destination: open and close shift, Z-report, sold-out list, printers and reprints. */
export function ShiftScreen() {
  const { floor } = usePos();
  const { businessDay } = useLocale();
  const [tab, setTab] = useState<ShiftTab>("shift");
  // The close is a blind count: from the checklist to the register's answer, nothing that gives expected cash away is shown (A-N3, C-3).
  const [counting, setCounting] = useState(false);
  // The line under the title: the business day and its state (the outlet and station are in the top bar).
  const meta = floor?.business_date ? (
    <span className="inline-flex items-center gap-2">
      Business day {businessDay(floor.business_date)}
      <Pill tone="seated" size="sm">Open</Pill>
    </span>
  ) : null;
  return (
    <Frame sub={{ title: "Shift", meta, actions: <SegmentedControl aria-label="Shift section" options={TABS} selectedId={tab} onSelect={(id) => setTab(id as ShiftTab)} /> }}>
      {tab === "shift" ? (
        // The station's shift and the day side by side, the Z-report's figures so far under them.
        // The shift panel is at most a screen tall, so its pinned actions stay in view; the page scrolls to the figures.
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] items-start gap-4 max-[960px]:grid-cols-1">
            <div className="flex h-fit max-h-[calc(100dvh-148px)] min-h-0 flex-col">
              <ShiftHome onShowReport={() => setTab("zreport")} onCounting={setCounting} />
            </div>
            <DayPanel />
          </div>
          <FiguresSoFar blind={counting} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">{tab === "zreport" ? <ZReportView blind={counting} /> : tab === "soldout" ? <SoldOutView /> : <PrintersView />}</div>
      )}
    </Frame>
  );
}

/** "Z-report · figures so far" for this station, from the register, four panels in a row on a landscape iPad. */
function FiguresSoFar({ blind }: { blind: boolean }) {
  const { station, staff } = usePos();
  const report = useZReport(station.outlet_id, station.id, null, roleAtLeast(staff.role, "cashier") && !blind);
  // The Z-report needs a Cashier: a Server's Shift page leaves the section out rather than showing a refusal each visit.
  if (!roleAtLeast(staff.role, "cashier")) return null;
  if (blind) return <BlindNote />;
  return (
    <div className="mt-4">
      <ZFigures report={report} title="Z-report · figures so far" />
    </div>
  );
}

