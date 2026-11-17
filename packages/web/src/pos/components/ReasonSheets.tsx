"use client";

import { ALLERGY_NOTE_CLASS, Button, Checkbox, CheckboxGroup, cx, mentionsAllergy, ReasonPicker, Sheet, Skeleton } from "@sail/ui";
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
      <Sheet labelledClose isOpen={isOpen} onOpenChange={(o) => (!o ? onClose() : undefined)} title="Reopen order" description={refusal.message}>
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
      {refusal === undefined ? <Skeleton lines={3} /> : null}
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

type RejectLine = { id: string; product_id?: string; name: string; quantity: number; modifiers: string[]; notes?: string | null };

/** A QR order's lines as staff decide on them: quantity, name, choices and the guest's note (final review C Low, review 4 U5). */
function RoundLines({ lines }: { lines: RejectLine[] }) {
  return (
    <ul aria-label="Items in this order" className="mb-4 flex flex-col gap-1 rounded-tile bg-surface-2 px-4 py-3 text-body text-ink">
      {lines.map((l) => (
        <li key={l.id} className="break-words">
          <span className="tabular font-medium">{l.quantity}</span> {l.name}
          {l.modifiers.length ? <span className="text-ink-2"> · {l.modifiers.join(", ")}</span> : null}
          {l.notes ? <span className={cx("block", mentionsAllergy(l.notes) ? ALLERGY_NOTE_CLASS : "text-ink-2 italic")}>{l.notes}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Reject a QR order with one tap on a reason. The guest sees the reason. "Sold out" asks which items are sold out (the
 * sheet's list of items becomes the choice: the one item ticked when the round has one, none when it has more), and the
 * register rejects and marks only those sold out for today in the same request, so the guest menu stops offering them
 * and a lost answer cannot leave one done without the other (review 4 U1). The same sheet serves the Now card and the
 * order screen (live-test final2 C-2). `canMarkSoldOut`: the signed-in role may mark sold out (Cashier or above).
 */
export function RejectRoundSheet({ roundLabel, lines, isOpen, onClose, onReject, canMarkSoldOut = false }: { roundLabel: string | null; lines?: RejectLine[]; isOpen: boolean; onClose: () => void; onReject: (reason: string, soldOut: string[]) => Promise<unknown>; canMarkSoldOut?: boolean }) {
  const [busy, setBusy] = useState(false);
  // Each product once, in the round's order: sold out is a product's state, not a line's.
  const products = [...new Map((lines ?? []).flatMap((l) => (l.product_id ? [[l.product_id, l] as const] : []))).entries()];
  const [choosing, setChoosing] = useState(false);
  const [ticked, setTicked] = useState<string[]>([]);
  useEffect(() => {
    if (!isOpen) setChoosing(false);
  }, [isOpen]);
  const reject = async (reason: string, soldOut: string[]) => {
    setBusy(true);
    const ok = await onReject(reason, soldOut);
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Sheet labelledClose isOpen={isOpen} onOpenChange={(o) => (!o ? onClose() : undefined)} title="Reject QR order" description={roundLabel ? `${roundLabel} · the guest is told why` : "The guest is told why"} isDismissable={!busy}>
      {choosing ? (
        <div className="flex flex-col gap-4">
          <CheckboxGroup label="Which items are sold out?" description="They are marked sold out for today." value={ticked} onChange={setTicked} isDisabled={busy}>
            {products.map(([id, l]) => (
              <Checkbox key={id} value={id}>
                <span className="break-words">{l.name}</span>
              </Checkbox>
            ))}
          </CheckboxGroup>
          {/* Sold out names what is sold out: nothing ticked, nothing to reject as sold out (another reason is a tap away). */}
          <Button size="lg" variant="primary" isDisabled={busy || ticked.length === 0} isPending={busy} onPress={() => void reject(REJECT_ROUND_REASONS[0]!, ticked)}>
            Reject as sold out
          </Button>
          <Button size="lg" variant="quiet" isDisabled={busy} onPress={() => setChoosing(false)}>
            Choose another reason
          </Button>
        </div>
      ) : (
        <>
          {/* What is being turned down, so nobody rejects the wrong round (final review C Low). */}
          {lines?.length ? <RoundLines lines={lines} /> : null}
          <ReasonPicker
            reasons={REJECT_ROUND_REASONS.map((r) => ({ id: r, name: r }))}
            isDisabled={busy}
            onPick={(r) => {
              if (r.text === REJECT_ROUND_REASONS[0] && canMarkSoldOut && products.length) {
                setTicked(products.length === 1 ? [products[0]![0]] : []);
                setChoosing(true);
                return;
              }
              void reject(r.text, []);
            }}
          />
        </>
      )}
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
export function WaitingRoundSheet({ isOpen, roundLabel, lines, canPayRest, onClose, onAccept, onReject, onPayRest }: { isOpen: boolean; roundLabel: string | null; lines?: RejectLine[]; canPayRest: boolean; onClose: () => void; onAccept: () => Promise<unknown>; onReject: () => void; onPayRest: () => void }) {
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
      {lines?.length ? <RoundLines lines={lines} /> : null}
      {canPayRest ? <p className="text-body text-ink-2">Paying without it takes only what is on the bill now; the QR order keeps waiting.</p> : null}
    </Sheet>
  );
}
