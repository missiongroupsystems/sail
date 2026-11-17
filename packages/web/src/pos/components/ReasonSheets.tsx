"use client";

import { Button, Checkbox, ReasonPicker, Sheet } from "@sail/ui";
import { useEffect, useState } from "react";

export const REOPEN_REASONS = ["Guest came back", "Closed by mistake", "More items to add", "Payment recorded wrongly"];
export const VOID_PAYMENT_REASONS = ["Wrong payment method", "Charged twice", "Wrong amount", "Guest changed how to pay"];
export const REJECT_ROUND_REASONS = ["Sold out", "Kitchen is closing", "Cannot make it right now", "Table did not order this"];

/** Reopen a completed order: a reason, then the register's Manager check (same business day). */
export function ReopenSheet({ isOpen, onClose, onReopen, payments = [], checkRefusal }: { isOpen: boolean; onClose: () => void; onReopen: (reason: string) => Promise<unknown>; payments?: string[]; checkRefusal?: () => Promise<{ message: string; remedy: string | null } | null> }) {
  const [busy, setBusy] = useState(false);
  // The register is asked first (a dry run), so nobody gives a reason or a PIN for a reopen it would refuse.
  const [refusal, setRefusal] = useState<{ message: string; remedy: string | null } | null | undefined>(undefined);
  useEffect(() => {
    if (!isOpen) return setRefusal(undefined);
    if (!checkRefusal) return setRefusal(null);
    let live = true;
    void checkRefusal().then((r) => live && setRefusal(r));
    return () => {
      live = false;
    };
  }, [isOpen, checkRefusal]);
  if (refusal) {
    return (
      <Sheet labelledClose isOpen={isOpen} onOpenChange={(o) => (!o ? onClose() : undefined)} title="This order cannot be reopened" description={refusal.message}>
        {refusal.remedy ? <p className="text-body text-ink">{refusal.remedy}</p> : null}
      </Sheet>
    );
  }
  return (
    <Sheet labelledClose isOpen={isOpen} onOpenChange={(o) => (!o ? onClose() : undefined)} title="Reopen order" description="Why is it being reopened? Needs a Manager, and only on the same business day." isDismissable={!busy}>
      {/* Reopening gives back what was paid (live test B-N2): said before anyone confirms, with each payment. Nothing is
          said or asked until the register has answered the dry run, so a refused reopen never shows a reason or a
          reversal it would not make (review 2, N3). */}
      {refusal === null && payments.length ? (
        <div role="note" className="mb-4 rounded-tile bg-status-bill-tint px-4 py-3 text-body text-ink">
          <p className="font-medium">Reopening reverses {payments.length === 1 ? "its payment" : `its ${payments.length} payments`}.</p>
          <p className="text-ink-2">{payments.join(" · ")}. The bill is then open for its full balance and is paid again.</p>
        </div>
      ) : null}
      {refusal === null ? (
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
      ) : null}
    </Sheet>
  );
}

/** Reject a QR order with one tap on a reason. The guest sees the reason. */
export function RejectRoundSheet({ roundLabel, lines, isOpen, onClose, onReject, onMarkSoldOut }: { roundLabel: string | null; lines?: { id: string; name: string; quantity: number; modifiers: string[] }[]; isOpen: boolean; onClose: () => void; onReject: (reason: string) => Promise<unknown>; onMarkSoldOut?: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  // "Sold out" also marks the items sold out (on by default), with the register's sold-out operation, so the guest menu stops offering them.
  const [markSoldOut, setMarkSoldOut] = useState(true);
  return (
    <Sheet labelledClose isOpen={isOpen} onOpenChange={(o) => (!o ? onClose() : undefined)} title="Reject QR order" description={roundLabel ? `${roundLabel} · the guest is told why` : "The guest is told why"} isDismissable={!busy}>
      {/* What is being turned down, so nobody rejects the wrong round (final review C Low). */}
      {lines?.length ? (
        <ul aria-label="Items in this order" className="mb-4 flex flex-col gap-1 rounded-tile bg-surface-2 px-4 py-3 text-body text-ink">
          {lines.map((l) => (
            <li key={l.id} className="break-words">
              <span className="tabular font-medium">{l.quantity}</span> {l.name}
              {l.modifiers.length ? <span className="text-ink-2"> · {l.modifiers.join(", ")}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {onMarkSoldOut ? (
        <Checkbox isSelected={markSoldOut} onChange={setMarkSoldOut} isDisabled={busy} className="mb-3">
          <span className="text-line">If sold out, also mark these items sold out for today</span>
        </Checkbox>
      ) : null}
      <ReasonPicker
        reasons={REJECT_ROUND_REASONS.map((r) => ({ id: r, name: r }))}
        isDisabled={busy}
        onPick={async (r) => {
          setBusy(true);
          const ok = await onReject(r.text);
          if (ok && r.text === REJECT_ROUND_REASONS[0] && markSoldOut && onMarkSoldOut) await onMarkSoldOut();
          setBusy(false);
          if (ok) onClose();
        }}
      />
    </Sheet>
  );
}

/** Void a payment taken in error: a reason, then a Manager's PIN for anyone below Manager. A terminal payment is given back on the terminal. */
export function VoidPaymentSheet({ label, onTerminal = false, isOpen, onClose, onVoid }: { label: string | null; onTerminal?: boolean; isOpen: boolean; onClose: () => void; onVoid: (reason: string) => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const what = `The bill owes it again.${onTerminal ? " The terminal gives the money back to the card." : ""} Needs a Manager.`;
  return (
    <Sheet labelledClose isOpen={isOpen} onOpenChange={(o) => (!o ? onClose() : undefined)} title="Void payment" description={label ? `${label} · ${what}` : what} isDismissable={!busy}>
      <ReasonPicker
        reasons={VOID_PAYMENT_REASONS.map((r) => ({ id: r, name: r }))}
        isDisabled={busy}
        onPick={async (r) => {
          setBusy(true);
          const ok = await onVoid(r.text);
          setBusy(false);
          if (ok) onClose();
        }}
      />
    </Sheet>
  );
}

/**
 * Pay was pressed while a guest's QR order waits: its items are on no bill until accepted, so the choice comes first.
 * Accept puts them on the bill; Reject opens the reasons; paying the rest leaves the round waiting.
 */
export function WaitingRoundSheet({ isOpen, roundLabel, canPayRest, onClose, onAccept, onReject, onPayRest }: { isOpen: boolean; roundLabel: string | null; canPayRest: boolean; onClose: () => void; onAccept: () => Promise<unknown>; onReject: () => void; onPayRest: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Sheet
      labelledClose
      isOpen={isOpen}
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title="A QR order is waiting"
      description={`${roundLabel ? `${roundLabel} · ` : ""}its items are not on the bill until you accept them`}
      isDismissable={!busy}
      footer={
        <>
          {canPayRest ? (
            <Button variant="quiet" size="lg" isDisabled={busy} onPress={onPayRest} className="mr-auto">
              Pay without it
            </Button>
          ) : null}
          <Button variant="secondary" size="lg" isDisabled={busy} onPress={onReject}>
            Reject
          </Button>
          <Button
            variant="primary"
            size="lg"
            isPending={busy}
            onPress={async () => {
              setBusy(true);
              const ok = await onAccept();
              setBusy(false);
              if (ok) onClose();
            }}
          >
            Accept
          </Button>
        </>
      }
    >
      {canPayRest ? <p className="text-body text-ink-2">Paying without it takes only what is on the bill now; the QR order keeps waiting.</p> : null}
    </Sheet>
  );
}
