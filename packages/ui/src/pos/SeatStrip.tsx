"use client";

import { Plus } from "lucide-react";
import { Button as AriaButton } from "react-aria-components";
import { cx } from "../lib/cx";
import { Icon } from "../components/Icon";

export type SeatStripProps = {
  /** Number of seats shown as chips. */
  seats: number;
  /** The active seat; `null` means Shared. New lines go to the active seat. */
  active: number | null;
  onChange: (seat: number | null) => void;
  onAddSeat?: () => void;
  className?: string;
};

const chip =
  "press pos-touch flex min-h-11 min-w-11 items-center justify-center rounded-chip px-3 text-[14.5px] font-medium tabular outline-none transition-colors duration-[120ms] " +
  "data-[pressed]:scale-[0.97] data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus";

/** The seat strip: Shared, 1…N, and +. Only shown when the station has seats turned on. */
export function SeatStrip({ seats, active, onChange, onAddSeat, className }: SeatStripProps) {
  const items: (number | null)[] = [null, ...Array.from({ length: seats }, (_, i) => i + 1)];
  return (
    <div role="group" aria-label="Seat for new lines" className={cx("flex items-center gap-2 overflow-x-auto px-4 py-2", className)}>
      <span className="pr-1 text-caption text-ink-3">Seat</span>
      {items.map((seat) => {
        const selected = seat === active;
        return (
          <AriaButton
            key={seat ?? "shared"}
            aria-pressed={selected}
            onPress={() => onChange(seat)}
            className={cx(chip, selected ? "bg-primary text-on-primary" : "bg-surface-2 text-ink-2 data-[hovered]:text-ink")}
          >
            {seat ?? "Shared"}
          </AriaButton>
        );
      })}
      {onAddSeat ? (
        <AriaButton onPress={onAddSeat} aria-label="Add a seat" className={cx(chip, "border border-rule-strong bg-surface text-ink-2 data-[hovered]:bg-surface-2")}>
          <Icon icon={Plus} size={18} />
        </AriaButton>
      ) : null}
    </div>
  );
}
