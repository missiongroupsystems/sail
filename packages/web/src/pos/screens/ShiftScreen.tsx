"use client";

import { SegmentedControl } from "@sail/ui";
import { useState } from "react";
import { Frame } from "../components/Frame";
import { usePos } from "../components/PosContext";
import { PrintersView } from "./shift/PrintersView";
import { ShiftHome } from "./shift/ShiftHome";
import { SoldOutView } from "./shift/SoldOutView";
import { ZReportView } from "./shift/ZReportView";

export type ShiftTab = "shift" | "zreport" | "soldout" | "printers";

const TABS: { id: ShiftTab; label: string }[] = [
  { id: "shift", label: "Shift" },
  { id: "zreport", label: "Z-report" },
  { id: "soldout", label: "Sold out" },
  { id: "printers", label: "Printers" },
];

/** The Shift destination (design 3.1, 4.9): open and close shift, Z-report, sold-out list, printers and reprints. */
export function ShiftScreen() {
  const { outlet, station } = usePos();
  const [tab, setTab] = useState<ShiftTab>("shift");
  return (
    <Frame title={`${outlet?.name ?? ""} · ${station.name}`} right={<SegmentedControl aria-label="Shift section" options={TABS} selectedId={tab} onSelect={(id) => setTab(id as ShiftTab)} />}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "shift" ? <ShiftHome onShowReport={() => setTab("zreport")} /> : tab === "zreport" ? <ZReportView /> : tab === "soldout" ? <SoldOutView /> : <PrintersView />}
      </div>
    </Frame>
  );
}
