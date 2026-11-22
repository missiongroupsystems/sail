"use client";

import { Button } from "@sail/ui";
import type { Station } from "../api/types";
import { Frame } from "./Frame";

/** A POS station saved without a brand has no menu and cannot open an order; it still takes payments and runs its shift. */
export const hasNoBrand = (station: Pick<Station, "kind" | "brand_id">) => station.kind === "pos" && !station.brand_id;

export const NO_BRAND_TITLE = "This station has no brand";
export const NO_BRAND_HINT = "In the back office, open Settings › Stations and choose one.";

/** In place of the floor, where tables are seated: one message that says where to fix it. Orders and Shift stay in the top bar. */
export function NoBrandScreen({ checking, onCheck, onLock }: { checking: boolean; onCheck: () => void; onLock: () => void }) {
  return (
    <Frame>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-8 text-center">
        <div className="flex max-w-[520px] flex-col gap-2">
          <h1 className="font-heading text-[26px] leading-tight font-semibold tracking-[-0.02em] text-ink">{NO_BRAND_TITLE}</h1>
          <p role="alert" className="text-[14.5px] text-ink-2">
            {NO_BRAND_HINT}
          </p>
        </div>
        <div className="flex gap-3">
          <Button variant="secondary" size="lg" onPress={onLock}>
            Lock
          </Button>
          <Button variant="primary" size="lg" isPending={checking} onPress={onCheck}>
            Check again
          </Button>
        </div>
      </div>
    </Frame>
  );
}
