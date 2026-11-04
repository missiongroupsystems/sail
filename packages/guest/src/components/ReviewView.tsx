"use client";

import { BrandButton, InlineError, Money, TextField } from "@sail/ui";
import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { BasketItem } from "@/lib/basket";
import { offendingKey, type SendError } from "@/lib/send-errors";
import type { CompiledMenu, GuestSession } from "@/lib/types";
import { StaffBanner } from "./StaffBanner";

export type { SendError };

export type ReviewViewProps = {
  session: GuestSession;
  menu: CompiledMenu;
  items: BasketItem[];
  guestName: string;
  onGuestName: (name: string) => void;
  canOrder: boolean;
  sending: boolean;
  error: SendError | null;
  onEdit: (key: string) => void;
  onRemove: (key: string) => void;
  onSend: () => void;
  onBack: () => void;
  onClearError: () => void;
};

/**
 * The review page (design 4.11): the items with quantities and choices, edit
 * and remove, an optional name so staff know whose order it is, the plain note
 * about service charge and discounts, then "Send to kitchen".
 */
export function ReviewView({ session, menu, items, guestName, onGuestName, canOrder, sending, error, onEdit, onRemove, onSend, onBack, onClearError }: ReviewViewProps) {
  const badKey = offendingKey(error, items, menu);
  const [retryIn, setRetryIn] = useState<number>(0);
  const clearError = useRef(onClearError);
  clearError.current = onClearError;

  // "Sent too recently, try again in N s": count down, then let them try.
  useEffect(() => {
    if (error?.kind !== "rate_limited") {
      setRetryIn(0);
      return;
    }
    setRetryIn(error.retryIn);
    const t = setInterval(() => {
      setRetryIn((n) => {
        if (n <= 1) {
          clearInterval(t);
          clearError.current();
          return 0;
        }
        return n - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [error]);

  const generalError = error && !badKey && error.kind !== "table_not_open" && error.kind !== "rate_limited" ? error.error : null;

  return (
    <>
      <header className="sticky top-0 z-20 bg-bg/95 backdrop-blur-sm hairline-b">
        <div className="mx-auto flex w-full max-w-[560px] items-center gap-2 px-2 pb-2 pt-[max(8px,env(safe-area-inset-top))]">
          <BrandButton variant="quiet" onPress={onBack} aria-label="Back to the menu" className="px-3">
            <ArrowLeft size={22} aria-hidden />
            <span>Menu</span>
          </BrandButton>
          <div className="min-w-0 flex-1 text-right">
            <h1 className="truncate font-display text-heading text-ink">Review your order</h1>
            <p className="text-caption text-ink-2">Table {session.table.name}</p>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[560px] flex-col gap-6 px-4 pb-40 pt-4">
        {!canOrder ? <StaffBanner /> : null}
        {generalError ? <InlineError error={generalError} /> : null}

        {items.length === 0 ? (
          <div className="flex flex-col items-start gap-3 py-8">
            <p className="text-body text-ink-2">Nothing to review yet. Add something from the menu.</p>
            <BrandButton onPress={onBack}>Back to the menu</BrandButton>
          </div>
        ) : (
          <ul className="flex flex-col hairline-t" aria-label="Your items">
            {items.map((item) => {
              const itemError = badKey === item.key && error ? error.error : null;
              return (
                <li key={item.key} className="flex flex-col gap-2 py-4 hairline-b">
                  <div className="flex items-baseline gap-3">
                    <span className="w-7 shrink-0 text-body tabular text-ink-2">{item.quantity}×</span>
                    <span className="min-w-0 flex-1 font-display text-line text-ink">{item.name}</span>
                    <span className="shrink-0 text-body text-ink">
                      <Money cents={item.unit_price} />
                      {item.quantity > 1 ? <span className="text-ink-2"> each</span> : null}
                    </span>
                  </div>
                  {item.modifiers.length ? (
                    <ul className="flex flex-col gap-0.5 pl-10 text-body text-ink-2" aria-label="Choices">
                      {item.modifiers.map((m) => (
                        <li key={`${m.group_id}:${m.product_id}`} className="flex items-baseline justify-between gap-3">
                          <span>
                            {m.quantity > 1 ? `${m.quantity}× ` : ""}
                            {m.name}
                          </span>
                          {m.price ? <Money cents={m.price} signed /> : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {item.notes ? <p className="pl-10 text-body text-ink-2">Note: {item.notes}</p> : null}
                  {itemError ? <InlineError error={{ message: itemError.message, remedy: itemError.remedy ?? (error?.kind === "group" ? "Tap Edit to choose." : null) }} className="ml-10" /> : null}
                  <div className="flex gap-2 pl-10 pt-1">
                    <BrandButton onPress={() => onEdit(item.key)} isDisabled={sending}>
                      Edit
                    </BrandButton>
                    <BrandButton variant="destructive" onPress={() => onRemove(item.key)} isDisabled={sending}>
                      Remove
                    </BrandButton>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {items.length > 0 ? (
          <>
            <TextField label="Your name (optional)" description="So staff know whose order it is" value={guestName} onChange={onGuestName} maxLength={40} autoComplete="given-name" inputClassName="min-h-12" isDisabled={sending} />
            <p className="text-body text-ink-2">Service charge and any discounts are added to your bill.</p>
          </>
        ) : null}
      </main>

      {items.length > 0 ? (
        <div className="fixed inset-x-0 bottom-0 z-30 bg-bg/95 backdrop-blur-sm hairline-t">
          <div className="mx-auto flex w-full max-w-[560px] flex-col gap-2 px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3">
            {error?.kind === "rate_limited" && retryIn > 0 ? (
              <p role="status" className="text-caption text-ink-2">
                Sent too recently, try again in {retryIn} s
              </p>
            ) : null}
            <BrandButton variant="accent" block className="min-h-14" onPress={onSend} isPending={sending} isDisabled={!canOrder || retryIn > 0}>
              {canOrder ? "Send to kitchen" : "Waiting for staff to seat you"}
            </BrandButton>
          </div>
        </div>
      ) : null}
    </>
  );
}
