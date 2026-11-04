"use client";

import { Sheet } from "@sail/ui";

/** Bill and Pay are present but payments arrive in the next phase (v0.6): one quiet line, never a gap. */
export function LaterPhaseSheet({ isOpen, onClose, title }: { isOpen: boolean; onClose: () => void; title: string }) {
  return (
    <Sheet isOpen={isOpen} onOpenChange={(o) => (!o ? onClose() : undefined)} title={title}>
      <p className="text-line text-ink-2">Payments arrive in the next phase.</p>
    </Sheet>
  );
}
