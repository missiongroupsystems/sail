"use client";

import { useEffect, useState } from "react";
import { cx } from "../lib/cx";
import { Button } from "../components/Button";

export type UndoToastProps = {
  /** "Added Iced coffee ×2". */
  label: string;
  onUndo: () => void;
  /** Lifetime. */
  durationMs?: number;
  /** Called when the toast expires or Undo was pressed. */
  onDone: () => void;
  /** Re-arms the timer when it changes (a new T1 action replaces the toast). */
  nonce?: number | string;
  isPending?: boolean;
  className?: string;
};

/** The Undo toast: bottom left, 8 s, the opposite corner from the primary action. */
export function UndoToast({ label, onUndo, durationMs = 8000, onDone, nonce, isPending, className }: UndoToastProps) {
  const [remaining, setRemaining] = useState(durationMs);
  useEffect(() => {
    const started = Date.now();
    setRemaining(durationMs);
    const tick = setInterval(() => setRemaining(Math.max(0, durationMs - (Date.now() - started))), 250);
    const end = setTimeout(onDone, durationMs);
    return () => {
      clearInterval(tick);
      clearTimeout(end);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, durationMs]);

  return (
    <div
      role="status"
      aria-live="polite"
      className={cx("pointer-events-auto flex min-h-14 items-center gap-3 rounded-tile bg-ink pr-2 pl-4 text-surface shadow-sheet", "animate-rise-in", className)}
    >
      <span className="text-line">{label}</span>
      <span aria-hidden className="h-1 w-10 overflow-hidden rounded-chip bg-surface/30">
        <span className="block h-full bg-surface" style={{ width: `${(remaining / durationMs) * 100}%`, transition: "width 250ms linear" }} />
      </span>
      <Button
        variant="quiet"
        size="md"
        isPending={isPending}
        onPress={() => {
          onUndo();
        }}
        className="text-surface data-[hovered]:bg-surface/15 data-[pressed]:bg-surface/25"
      >
        Undo
      </Button>
    </div>
  );
}
