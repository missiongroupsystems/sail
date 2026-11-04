"use client";

import { ReasonPicker, Sheet } from "@sail/ui";
import { useState } from "react";

export const REOPEN_REASONS = ["Guest came back", "Closed by mistake", "More items to add", "Payment recorded wrongly"];
export const REJECT_ROUND_REASONS = ["Sold out", "Kitchen is closing", "Cannot make it right now", "Table did not order this"];

/** Reopen a completed order (design 4.12): a reason, then the register's Manager check (same business day). */
export function ReopenSheet({ isOpen, onClose, onReopen }: { isOpen: boolean; onClose: () => void; onReopen: (reason: string) => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  return (
    <Sheet isOpen={isOpen} onOpenChange={(o) => (!o ? onClose() : undefined)} title="Reopen order" description="Why is it being reopened? Needs a Manager, and only on the same business day." isDismissable={!busy}>
      <ReasonPicker
        reasons={REOPEN_REASONS.map((r) => ({ id: r, name: r }))}
        isDisabled={busy}
        onPick={async (r) => {
          setBusy(true);
          const ok = await onReopen(r.text);
          setBusy(false);
          if (ok) onClose();
        }}
      />
    </Sheet>
  );
}

/** Reject a QR order with one tap on a reason (design 4.2 Now rail). The guest sees the reason. */
export function RejectRoundSheet({ roundLabel, isOpen, onClose, onReject }: { roundLabel: string | null; isOpen: boolean; onClose: () => void; onReject: (reason: string) => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  return (
    <Sheet isOpen={isOpen} onOpenChange={(o) => (!o ? onClose() : undefined)} title="Reject QR order" description={roundLabel ? `${roundLabel} · the guest is told why` : "The guest is told why"} isDismissable={!busy}>
      <ReasonPicker
        reasons={REJECT_ROUND_REASONS.map((r) => ({ id: r, name: r }))}
        isDisabled={busy}
        onPick={async (r) => {
          setBusy(true);
          const ok = await onReject(r.text);
          setBusy(false);
          if (ok) onClose();
        }}
      />
    </Sheet>
  );
}
