"use client";

import { useState } from "react";
import { cx } from "../lib/cx";
import { Button } from "../components/Button";

export type Tender = { id: string; name: string; is_cash: boolean; is_terminal: boolean };

export type TenderGridProps = {
  /** Configured tender types in the outlet's order. */
  tenders: Tender[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** How many show as buttons before "More…" (three). */
  visible?: number;
  isDisabled?: boolean;
  className?: string;
};

/** Payment methods: the top three as 56pt buttons, the rest unfolded by "More…". */
export function TenderGrid({ tenders, selectedId, onSelect, visible = 3, isDisabled, className }: TenderGridProps) {
  const [more, setMore] = useState(false);
  const selectedHidden = selectedId !== null && tenders.findIndex((t) => t.id === selectedId) >= visible;
  const shown = more || selectedHidden ? tenders : tenders.slice(0, visible);
  const rest = tenders.length - visible;
  return (
    <div role="group" aria-label="Payment method" className={cx("flex flex-wrap gap-2", className)}>
      {shown.map((t) => (
        <Button key={t.id} size="lg" variant={t.id === selectedId ? "primary" : "secondary"} aria-pressed={t.id === selectedId} isDisabled={isDisabled} onPress={() => onSelect(t.id)} className="min-w-[120px] flex-1">
          {t.name}
        </Button>
      ))}
      {rest > 0 && !more && !selectedHidden ? (
        <Button size="lg" variant="quiet" isDisabled={isDisabled} onPress={() => setMore(true)} className="min-w-[96px]" aria-label={`More payment methods (${rest})`}>
          More…
        </Button>
      ) : null}
    </div>
  );
}
