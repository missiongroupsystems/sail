"use client";

import { SegmentedControl, useLocale } from "@sail/ui";
import { useState } from "react";
import { usePos } from "../../components/PosContext";
import { useZReport } from "../../hooks/queries";
import { DayPanel } from "./DayPanel";
import { ZFigures } from "./ZFigures";

/** The Z-report: sales, tenders with the card total at 34pt, expected vs counted, voids, refunds and covers, every figure from the register. */
export function ZReportView() {
  const { clock, businessDay } = useLocale();
  const { station } = usePos();
  const [scope, setScope] = useState<"station" | "outlet">("station");
  const report = useZReport(station.outlet_id, scope === "station" ? station.id : null, null);
  const r = report.data;

  return (
    <div className="flex w-full flex-col gap-4 px-4 pt-1 pb-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-heading text-[22px] leading-tight font-semibold tracking-[-0.01em] text-ink">Z-report</h2>
          <p className="text-body text-ink-2">{r ? `${businessDay(r.scope.business_date)} · ${scope === "station" ? station.name : "whole outlet"} · as of ${clock(r.generated_at)}` : "Today, from the register"}</p>
        </div>
        <SegmentedControl aria-label="Report scope" options={[{ id: "station", label: "This station" }, { id: "outlet", label: "Whole outlet" }]} selectedId={scope} onSelect={(id) => setScope(id as "station" | "outlet")} />
      </div>

      {/* The day's close sits above the figures, as on the Close page, so it never falls below the fold. */}
      <DayPanel layout="row" />

      <ZFigures report={report} />
    </div>
  );
}
