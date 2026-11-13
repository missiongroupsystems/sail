"use client";

import { BrandButton, GuestStepper, Icon, InlineError, Money } from "@sail/ui";
import { ShoppingBag, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button as AriaButton, Input, Label, Text, TextField as AriaTextField } from "react-aria-components";
import type { BasketItem } from "@/lib/basket";
import { offendingKey, type SendError } from "@/lib/send-errors";
import { billNote } from "@/lib/status";
import type { CompiledMenu, GuestSession } from "@/lib/types";
import { Dock, PageHeader } from "./Shell";
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
  /** A new quantity for a line (1 or more; Remove takes it off). */
  onQuantity: (key: string, quantity: number) => void;
  onSend: () => void;
  onBack: () => void;
  onClearError: () => void;
  /** The register's tax mode for the table's order, once there is one. */
  taxMode?: string | null;
};

/**
 * The review page: the items with their choices, a quantity stepper and Remove on each (tap the item to change its
 * choices), an optional name so staff know whose order it is, the plain note
 * about service charge and discounts, then "Send to kitchen".
 */
/** The most of one item a guest may send: the day's cap where there is one, otherwise 50 (as on the item sheet). */
function maxQuantity(menu: CompiledMenu, productId: string): number {
  const cap = menu.products[productId]?.cap_remaining;
  return cap != null ? Math.max(1, Math.min(50, cap)) : 50;
}

export function ReviewView({ session, menu, items, guestName, onGuestName, canOrder, sending, error, onEdit, onRemove, onQuantity, onSend, onBack, onClearError, taxMode }: ReviewViewProps) {
  // How many things go to the kitchen, as on the cart bar (a count, not a figure the register prices).
  const count = items.reduce((n, item) => n + item.quantity, 0);
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
      <PageHeader title="Your order" subtitle={`Table ${session.table.name}`} onBack={onBack} backLabel="Back to the menu" />

      <main className="flex w-full flex-col gap-7 px-4 pb-40 pt-2">
        {!canOrder ? <StaffBanner className="mt-2" /> : null}
        {generalError ? <InlineError error={generalError} className="mt-2" /> : null}

        {items.length === 0 ? (
          <div className="flex flex-col items-center gap-4 px-4 py-24 text-center">
            <span className="flex size-14 items-center justify-center rounded-full bg-surface-2 text-ink">
              <Icon icon={ShoppingBag} size={24} />
            </span>
            <p className="max-w-[32ch] text-[15.5px] leading-relaxed text-ink-2">Nothing to review yet. Add something from the menu.</p>
            <BrandButton variant="accent" onPress={onBack} className="px-6">
              Back to the menu
            </BrandButton>
          </div>
        ) : (
          <ul className="flex flex-col divide-y divide-rule-subtle" aria-label="Your items">
            {items.map((item) => {
              const itemError = badKey === item.key && error ? error.error : null;
              return (
                <li key={item.key} className="flex flex-col gap-2 py-4">
                  <div className="flex items-start justify-between gap-4">
                    {/* The item's words are a button: it opens the item sheet to change choices or the note. */}
                    <AriaButton
                      onPress={() => onEdit(item.key)}
                      isDisabled={sending}
                      aria-label={`Change ${item.name}`}
                      className="min-w-0 flex-1 rounded-chip text-left outline-none data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus"
                    >
                      <p className="font-display text-[16px] leading-snug font-medium text-ink wrap-anywhere">{item.name}</p>
                      {item.modifiers.length ? (
                        <ul className="flex flex-col" aria-label="Choices">
                          {item.modifiers.map((m) => (
                            <li key={`${m.group_id}:${m.product_id}`} className="text-[14px] leading-snug text-ink-2 wrap-anywhere">
                              {m.quantity > 1 ? `${m.quantity}× ` : ""}
                              {m.name}
                              {m.price ? (
                                <>
                                  {" "}
                                  <Money cents={m.price} signed size="caption" className="text-[14px] text-ink-2" />
                                </>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {/* A pasted link or a long unbroken run wraps instead of widening the page past the send button. */}
                      {item.notes ? <p className="mt-0.5 text-[14px] leading-snug text-ink-2 italic wrap-anywhere">Note: {item.notes}</p> : null}
                    </AriaButton>
                    <p className="shrink-0 text-right text-[14px] whitespace-nowrap text-ink-2">
                      <Money cents={item.unit_price} className="text-[15.5px] font-medium text-ink" /> each
                    </p>
                  </div>
                  {itemError ? <InlineError error={{ message: itemError.message, remedy: itemError.remedy ?? (error?.kind === "group" ? "Tap the item to choose." : null) }} /> : null}
                  <div className="flex items-center justify-between gap-3">
                    <GuestStepper value={item.quantity} onChange={(q) => (sending ? undefined : onQuantity(item.key, q))} min={1} max={maxQuantity(menu, item.product_id)} label={`Quantity of ${item.name}`} />
                    <BrandButton variant="quiet" onPress={() => onRemove(item.key)} isDisabled={sending} aria-label={`Remove ${item.name}`} className="min-h-11 gap-1.5 px-3 text-[14.5px] text-ink-2">
                      <Icon icon={Trash2} size={18} />
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
            <BrandButton variant="secondary" block onPress={onBack} isDisabled={sending} className="-mt-3">
              Add more items
            </BrandButton>
            <AriaTextField value={guestName} onChange={onGuestName} maxLength={40} autoComplete="given-name" isDisabled={sending} className="flex flex-col gap-3">
              <Label className="flex items-baseline justify-between gap-3">
                <span className="font-display text-[16px] font-semibold tracking-tight text-ink">
                  Your name<span className="sr-only"> (optional)</span>
                </span>
                <span aria-hidden className="text-[13px] text-ink-3">
                  Optional
                </span>
              </Label>
              <Text slot="description" className="sr-only">
                So staff know whose order it is
              </Text>
              <Input placeholder="So staff know whose order it is" className="h-12 w-full rounded-sheet border border-transparent bg-surface-2 px-4 text-[16px] text-ink outline-none placeholder:text-ink-3 focus:border-rule-strong focus:bg-surface disabled:text-ink-disabled" />
            </AriaTextField>
            <p className="text-[13.5px] leading-relaxed text-ink-3">{billNote(taxMode)}</p>
          </>
        ) : null}
      </main>

      {items.length > 0 ? (
        <Dock>
          <div className="flex flex-col gap-2">
            {error?.kind === "rate_limited" && retryIn > 0 ? (
              <p role="status" className="text-caption text-ink-2">
                {error.error.message} · Try again in {retryIn} s
              </p>
            ) : null}
            <BrandButton variant="accent" block className="min-h-14 text-[16.5px]" onPress={onSend} isPending={sending} isDisabled={!canOrder || retryIn > 0}>
              {canOrder ? `Send ${count} ${count === 1 ? "item" : "items"} to the kitchen` : "Waiting for staff to seat you"}
            </BrandButton>
          </div>
        </Dock>
      ) : null}
    </>
  );
}
