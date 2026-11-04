"use client";

import { Frame } from "../components/Frame";
import { usePos } from "../components/PosContext";

/** Shift (design 4.9) arrives in a later phase (v0.6). One quiet line; never a gap. */
export function ShiftScreen() {
  const { outlet, station } = usePos();
  return (
    <Frame title={`${outlet?.name ?? ""} · ${station.name}`}>
      <div className="flex flex-1 flex-col gap-2 px-8 py-10">
        <h1 className="text-title text-ink">Shift</h1>
        <p className="text-line text-ink-2">Arrives in a later phase (v0.6: open and close shift, Z-report, sold-out list, printers, reprints).</p>
      </div>
    </Frame>
  );
}
