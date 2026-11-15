"use client";

import { Banknote, CreditCard, WalletCards } from "lucide-react";
import { useState } from "react";
import { Button as AriaButton } from "react-aria-components";
import { cx } from "../lib/cx";
import { Button } from "../components/Button";
import { Icon } from "../components/Icon";

/** A method is a 64pt card-like key, not a pill: ink when chosen, white with a firm edge otherwise. */
const tender =
  "press pos-touch flex min-h-16 min-w-0 items-center justify-center gap-2 rounded-tile border px-2.5 py-1.5 text-[15px] font-medium outline-none " +
  "transition-[background-color,border-color,transform] duration-[120ms] data-[pressed]:scale-[0.97] " +
  "data-[disabled]:border-transparent data-[disabled]:bg-surface-2 data-[disabled]:text-ink-disabled " +
  "data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus";

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
    <div role="group" aria-label="Payment method" className={cx("grid grid-cols-3 gap-2", className)}>
      {shown.map((t) => (
        <AriaButton
          key={t.id}
          aria-pressed={t.id === selectedId}
          isDisabled={isDisabled}
          onPress={() => onSelect(t.id)}
          className={cx(tender, t.id === selectedId ? "border-transparent bg-primary text-on-primary" : "border-rule-strong bg-surface text-ink data-[hovered]:bg-surface-2")}
        >
          <Icon icon={t.is_cash ? Banknote : t.is_terminal ? CreditCard : WalletCards} size={18} className="shrink-0" />
          {/* Up to two lines, broken between words ("Card" / "(terminal)"), so a usual name is never cut (A-N6, C-9). */}
          <span className="min-w-0 text-left leading-tight line-clamp-2 [overflow-wrap:normal]" title={t.name}>{t.name}</span>
        </AriaButton>
      ))}
      {rest > 0 && !more && !selectedHidden ? (
        <Button size="lg" variant="quiet" isDisabled={isDisabled} onPress={() => setMore(true)} className="min-h-16 rounded-tile! border! border-rule-strong! bg-surface! text-ink-2! data-[hovered]:bg-surface-2!" aria-label={`More payment methods (${rest})`}>
          More…
        </Button>
      ) : null}
    </div>
  );
}
