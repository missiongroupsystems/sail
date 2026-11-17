"use client";

import { Button, SegmentedControl, useLocale } from "@sail/ui";
import { useState } from "react";
import { usePos } from "../../components/PosContext";
import { useZReport } from "../../hooks/queries";
import { DayPanel } from "./DayPanel";
import { ZFigures } from "./ZFigures";

/** The Z-report: sales, tenders with the card total at 34pt, expected vs counted, voids, refunds and covers, every figure from the register. */
export function ZReportView({ blind = false }: { blind?: boolean }) {
  const { clock, businessDay } = useLocale();
  const { station } = usePos();
  const [scope, setScope] = useState<"station" | "outlet">("station");
  // A closed day's report is the register's snapshot for the whole outlet, offered beside today's once the day rolls over.
  const [day, setDay] = useState<string | null>(null);
  const report = useZReport(station.outlet_id, day || scope === "outlet" ? null : station.id, day);
  const r = report.data;
  const previous = !day ? (r?.previous_closed_date ?? null) : null;

  return (
    <div className="flex w-full flex-col gap-4 px-4 pt-1 pb-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-heading text-[22px] leading-tight font-semibold tracking-[-0.01em] text-ink">Z-report</h2>
          <p className="text-body text-ink-2">{r ? (r.closed ? `${businessDay(r.scope.business_date)} · whole outlet · closed at ${clock(r.closed.closed_at)}` : `${businessDay(r.scope.business_date)} · ${scope === "station" ? station.name : "whole outlet"} · as of ${clock(r.generated_at)}`) : "Today, from the register"}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {previous ? (
            <Button size="lg" variant="quiet" onPress={() => setDay(previous)}>
              {businessDay(previous)}, closed
            </Button>
          ) : null}
          {day ? (
            <Button size="lg" variant="quiet" onPress={() => setDay(null)}>
              Back to today
            </Button>
          ) : (
            <SegmentedControl aria-label="Report scope" options={[{ id: "station", label: "This station" }, { id: "outlet", label: "Whole outlet" }]} selectedId={scope} onSelect={(id) => setScope(id as "station" | "outlet")} />
          )}
        </div>
      </div>

      {/* The day's close sits above the figures, as on the Close page, so it never falls below the fold. */}
      {day ? null : <DayPanel layout="row" />}

      {blind ? <BlindNote /> : <ZFigures report={report} />}
    </div>
  );
}

/** In place of the figures while the drawer is counted. */
export function BlindNote() {
  return <p className="mt-4 rounded-panel border border-rule bg-surface px-5 py-4 text-body text-ink-2">The figures are hidden while the drawer is counted. They show again once the shift is closed.</p>;
}
