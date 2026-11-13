"use client";

import { Button, Icon, UndoToast } from "@sail/ui";
import { AlertTriangle, Check, Info } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavStore } from "../state/nav";
import { useUiStore } from "../state/ui";

/**
 * Bottom-left stack at the bottom edge, left of the order column and its dock: the Undo toast and one-line notices, the opposite
 * corner from the primary action. Sits above sheets (z-50) so a register error from
 * an action started inside a sheet is seen where the action was, and
 * below the idle overlay (z-60).
 */
export function NoticeHost() {
  const undo = useUiStore((s) => s.undo);
  const clearUndo = useUiStore((s) => s.clearUndo);
  const notices = useUiStore((s) => s.notices);
  const dismiss = useUiStore((s) => s.dismissNotice);
  const [undoing, setUndoing] = useState(false);
  // An Undo belongs to the screen it was made on: "Added Chicken Rice" must not follow the person to the bill or a split.
  const screen = useNavStore((s) => s.screen);
  const where = `${screen.kind}:${"orderId" in screen ? screen.orderId : ""}`;
  useEffect(() => {
    if (useUiStore.getState().undo?.screen) clearUndo();
  }, [where, clearUndo]);

  return (
    // Above the 80pt action docks and foot bars, so a notice never covers a primary action or a total.
    <div className="pointer-events-none fixed bottom-5 left-4 z-[55] flex max-w-[480px] flex-col gap-2">
      {notices.map((n) => (
        <div
          key={n.id}
          role={n.tone === "alert" ? "alert" : "status"}
          className={
            "pointer-events-auto flex items-start gap-3 rounded-sheet bg-(--toast) px-4 py-3 text-(--on-toast) shadow-float animate-rise-in"
          }
        >
          <Icon icon={n.tone === "alert" ? AlertTriangle : n.tone === "success" ? Check : Info} size={18} className={"mt-0.5 shrink-0 " + (n.tone === "alert" ? "text-[color-mix(in_oklab,var(--status-alert),var(--on-toast)_45%)]" : n.tone === "success" ? "text-[color-mix(in_oklab,var(--status-paid),var(--on-toast)_45%)]" : "opacity-70")} />
          <div className="min-w-0 flex-1">
            <p className="text-[14.5px] font-medium">{n.text}</p>
            {n.remedy ? <p className="text-[13.5px] opacity-75">{n.remedy}</p> : null}
          </div>
          <Button variant="quiet" size="md" onPress={() => dismiss(n.id)} className="-my-1 -mr-2 text-(--on-toast)! data-[hovered]:bg-[color-mix(in_oklab,var(--toast),var(--on-toast)_15%)]!">
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
