"use client";

import { Button, UndoToast } from "@sail/ui";
import { useState } from "react";
import { useUiStore } from "../state/ui";

/** Bottom-left stack (design 2.5): the Undo toast and one-line notices, the opposite corner from the primary action. */
export function NoticeHost() {
  const undo = useUiStore((s) => s.undo);
  const clearUndo = useUiStore((s) => s.clearUndo);
  const notices = useUiStore((s) => s.notices);
  const dismiss = useUiStore((s) => s.dismissNotice);
  const [undoing, setUndoing] = useState(false);

  return (
    <div className="pointer-events-none fixed bottom-4 left-4 z-40 flex max-w-[480px] flex-col gap-2">
      {notices.map((n) => (
        <div
          key={n.id}
          role={n.tone === "alert" ? "alert" : "status"}
          className={
            "pointer-events-auto flex items-start gap-3 rounded-tile px-4 py-3 shadow-sheet animate-rise-in " +
            (n.tone === "alert" ? "bg-[color-mix(in_srgb,var(--status-alert)_14%,var(--surface))] hairline" : n.tone === "success" ? "bg-[color-mix(in_srgb,var(--status-paid)_14%,var(--surface))] hairline" : "bg-surface hairline")
          }
        >
          <div className="min-w-0 flex-1">
            <p className="text-body text-ink">{n.text}</p>
            {n.remedy ? <p className="text-caption text-ink-2">{n.remedy}</p> : null}
          </div>
          <Button variant="quiet" size="md" onPress={() => dismiss(n.id)} className="-my-1 -mr-2 text-ink-2">
            Dismiss
          </Button>
        </div>
      ))}
      {undo ? (
        <UndoToast
          nonce={undo.id}
          label={undo.label}
          isPending={undoing}
          onUndo={async () => {
            setUndoing(true);
            try {
              await undo.undo();
            } finally {
              setUndoing(false);
              clearUndo();
            }
          }}
          onDone={clearUndo}
        />
      ) : null}
    </div>
  );
}
