"use client";

import { BottomSheet, cx, Icon } from "@sail/ui";
import { Check, ConciergeBell, Flame, GlassWater, Hand, Loader2, ReceiptText, UtensilsCrossed, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button as AriaButton } from "react-aria-components";
import { createRequest, toApiError, type GuestApi } from "@/lib/api";
import { requestLabel } from "@/lib/format";

export type CallStaffSheetProps = {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  api: GuestApi;
  /** The channel's table requests (up to 5), from the session. "Ask for the bill" is always offered. */
  requests: string[];
  guestName: string;
  /** A request reached the staff: the page says so once the sheet has closed. */
  onSent?: (label: string) => void;
};

type Outcome = { kind: "sending" } | { kind: "sent" } | { kind: "too_soon"; remedy: string | null } | { kind: "error"; message: string; remedy: string | null };

const SENT = "Sent. Someone will be with you shortly.";
/** Pressed again too soon: say so, with the register's remedy ("Try again in 42 seconds."). */
// The limit is per table, so the phone that pressed may not be this one (live-test D-11).
const tooSoon = (remedy: string | null) => `Already asked from this table, someone is on the way. ${remedy ?? "Please give us a moment."}`;

/** Call staff: the channel's requests as large rows, plus "Ask for the bill". Each confirms under its row; repeats say so. */
export function CallStaffSheet({ isOpen, onOpenChange, api, requests, guestName, onSent }: CallStaffSheetProps) {
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const rows = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (isOpen) setOutcomes({});
  }, [isOpen]);

  const send = async (type: string) => {
    setOutcomes((o) => ({ ...o, [type]: { kind: "sending" } }));
    try {
      await createRequest(api, type, guestName.trim() || undefined);
      setOutcomes((o) => ({ ...o, [type]: { kind: "sent" } }));
      onSent?.(requestLabel(type));
      // The row just pressed is now disabled, which drops focus out of the sheet, and Escape with it: hand focus to the
      // sheet's Close button so the keyboard (and Escape) still work.
      setTimeout(() => rows.current?.closest<HTMLElement>('[role="dialog"]')?.querySelector<HTMLElement>('button[aria-label="Close"]')?.focus(), 0);
    } catch (e) {
      const err = toApiError(e);
      setOutcomes((o) => ({ ...o, [type]: err.isRateLimited ? { kind: "too_soon", remedy: err.remedy ?? null } : { kind: "error", message: err.message, remedy: err.remedy ?? null } }));
    }
  };

  const types = [...requests.filter((r) => r !== "call_for_bill"), "call_for_bill"];

  return (
    <BottomSheet isOpen={isOpen} onOpenChange={onOpenChange} title="Call staff" description="Someone will come to your table.">
      <ul ref={rows} className="flex flex-col gap-2 pt-1" aria-label="Table requests">
        {types.map((type) => {
          const o = outcomes[type];
          const sent = o?.kind === "sent";
          return (
            <li key={type} className="flex flex-col gap-1">
              <AriaButton
                onPress={() => void send(type)}
                isPending={o?.kind === "sending"}
                isDisabled={sent}
                className="press flex min-h-14 w-full items-center gap-3 rounded-sheet border border-rule px-4 text-left text-[16px] font-medium text-ink outline-none transition-colors duration-[120ms] data-[hovered]:bg-surface-2 data-[pressed]:bg-surface-2 data-[disabled]:text-ink-2 data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus"
              >
                <Icon icon={o?.kind === "sending" ? Loader2 : requestIcon(type)} size={20} className={cx("text-ink-2", o?.kind === "sending" && "keep-motion animate-spin")} />
                <span className="min-w-0 flex-1 wrap-anywhere">{requestLabel(type)}</span>
                {sent ? <Icon icon={Check} size={18} className="text-status-paid" /> : null}
              </AriaButton>
              <p role="status" aria-live="polite" className={o ? "min-h-5 px-1 text-caption " + (o.kind === "error" ? "text-status-alert" : o.kind === "sent" ? "text-status-paid" : "text-ink-2") : "min-h-0"}>
                {o?.kind === "sent" ? SENT : o?.kind === "too_soon" ? tooSoon(o.remedy) : o?.kind === "error" ? `${o.message}${o.remedy ? ` ${o.remedy}` : ""}` : ""}
              </p>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 rounded-sheet bg-surface-2 px-4 py-3 text-[14px] leading-snug text-ink-2">Pay at the counter or ask your server for the bill.</p>
    </BottomSheet>
  );
}

/** An icon for each common request; anything else gets the bell. */
function requestIcon(type: string): LucideIcon {
  if (type === "call_for_bill") return ReceiptText;
  const t = type.toLowerCase();
  if (/water|drink/.test(t)) return GlassWater;
  if (/cutlery|fork|spoon|chopstick/.test(t)) return UtensilsCrossed;
  if (/chilli|chili|sauce|spice/.test(t)) return Flame;
  if (/serviette|napkin|tissue/.test(t)) return Hand;
  return ConciergeBell;
}
