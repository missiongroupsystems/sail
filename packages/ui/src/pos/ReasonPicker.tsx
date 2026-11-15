"use client";

import { useState } from "react";
import { cx } from "../lib/cx";
import { Button } from "../components/Button";
import { TextField } from "../components/TextField";

export type Reason = { id: string; name: string };

export type PickedReason = { id?: string; text: string };

export type ReasonPickerProps = {
  /** Configured reasons from the register (void reasons, or quick chips). */
  reasons: Reason[];
  /** Called with the chosen reason. "Other…" sends free text. */
  onPick: (reason: PickedReason) => void;
  /** Label for the free-text option; omit to hide it. */
  otherLabel?: string | null;
  isDisabled?: boolean;
  /** The reason picked so far, for a picker whose choice is confirmed by a separate action: shown pressed. */
  selected?: string | null;
  className?: string;
};

/** The register keeps a typed reason to 200 characters. */
export const REASON_MAX = 200;

/**
 * Reasons as grey chips in a row, one tap each, then "Other…" for a reason typed in.
 */
export function ReasonPicker({ reasons, onPick, otherLabel = "Other…", isDisabled, selected, className }: ReasonPickerProps) {
  const [other, setOther] = useState(false);
  const [text, setText] = useState("");
  // A configured reason named "Other" keeps its chip (and its id for reports); the free-text option then reads
  // "Type a reason…" so the two are not both "Other".
  const configuredOther = reasons.some((r) => r.name.trim().toLowerCase() === "other");
  const shown = reasons;
  const freeText = configuredOther && otherLabel === "Other…" ? "Type a reason…" : otherLabel;
  const chip = "min-h-12 rounded-chip border-transparent bg-surface-2 px-4 font-medium text-ink data-[hovered]:bg-surface-3 data-[pressed]:bg-surface-3";
  return (
    <div className={cx("flex flex-col gap-3", className)} role="group" aria-label="Reason">
      <div className="flex flex-wrap gap-2">
        {shown.map((r) => (
          <Button key={r.id} size="md" isDisabled={isDisabled} onPress={() => onPick({ id: r.id, text: r.name })} aria-pressed={selected === undefined ? undefined : selected === r.name} className={cx(chip, selected === r.name && "bg-primary! text-on-primary! data-[hovered]:bg-primary!")}>
            {r.name}
          </Button>
        ))}
        {otherLabel && !other ? (
          // Typing a reason is a link-like action, not one more reason chip.
          <Button size="md" variant="quiet" isDisabled={isDisabled} onPress={() => setOther(true)} className="min-h-12 px-3 font-medium text-ink-2 underline decoration-rule-strong underline-offset-4">
            {freeText}
          </Button>
        ) : null}
      </div>
      {otherLabel && other ? (
        <div className="flex flex-col gap-2">
          <TextField aria-label="Reason" value={text} onChange={setText} placeholder="Reason" autoFocus maxLength={REASON_MAX} inputClassName="min-h-14 text-line" description={text.length > REASON_MAX - 40 ? `${text.length} of ${REASON_MAX} characters` : undefined} />
          <Button size="lg" variant="primary" isDisabled={isDisabled || text.trim().length === 0} onPress={() => onPick({ text: text.trim().slice(0, REASON_MAX) })}>
            Use this reason
          </Button>
        </div>
      ) : null}
    </div>
  );
}
