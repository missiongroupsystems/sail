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
  className?: string;
};

/** A one-tap reason list with "Other…". Rows are 56pt. */
export function ReasonPicker({ reasons, onPick, otherLabel = "Other…", isDisabled, className }: ReasonPickerProps) {
  const [other, setOther] = useState(false);
  const [text, setText] = useState("");
  return (
    <div className={cx("flex flex-col gap-2", className)} role="group" aria-label="Reason">
      {reasons.map((r) => (
        <Button key={r.id} size="lg" isDisabled={isDisabled} onPress={() => onPick({ id: r.id, text: r.name })} className="justify-start">
          {r.name}
        </Button>
      ))}
      {otherLabel ? (
        other ? (
          <div className="flex flex-col gap-2 pt-1">
            <TextField aria-label="Reason" value={text} onChange={setText} placeholder="Reason" autoFocus inputClassName="min-h-14 text-line" />
            <Button size="lg" variant="primary" isDisabled={isDisabled || text.trim().length === 0} onPress={() => onPick({ text: text.trim() })}>
              Use this reason
            </Button>
          </div>
        ) : (
          <Button size="lg" variant="quiet" isDisabled={isDisabled} onPress={() => setOther(true)} className="justify-start text-ink-2">
            {otherLabel}
          </Button>
        )
      ) : null}
    </div>
  );
}
