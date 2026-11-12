"use client";

import { BottomSheet, BrandButton } from "@sail/ui";
import { useEffect, useState } from "react";
import { createRequest, toApiError, type GuestApi } from "@/lib/api";
import { requestLabel } from "@/lib/format";

export type CallStaffSheetProps = {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  api: GuestApi;
  /** The channel's table requests (up to 5), from the session. "Ask for the bill" is always offered. */
  requests: string[];
  guestName: string;
};

type Outcome = { kind: "sending" } | { kind: "sent" } | { kind: "too_soon"; remedy: string | null } | { kind: "error"; message: string; remedy: string | null };

const SENT = "Sent. Someone will be with you shortly.";
/** Pressed again too soon: say so, with the register's remedy ("Try again in 42 seconds."). */
const tooSoon = (remedy: string | null) => `Already sent. ${remedy ?? "Please give us a moment."}`;

/** Call staff: the channel's requests as big buttons, plus "Ask for the bill". Each confirms; repeats say so. */
export function CallStaffSheet({ isOpen, onOpenChange, api, requests, guestName }: CallStaffSheetProps) {
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  useEffect(() => {
    if (isOpen) setOutcomes({});
  }, [isOpen]);

  const send = async (type: string) => {
    setOutcomes((o) => ({ ...o, [type]: { kind: "sending" } }));
    try {
      await createRequest(api, type, guestName.trim() || undefined);
      setOutcomes((o) => ({ ...o, [type]: { kind: "sent" } }));
    } catch (e) {
      const err = toApiError(e);
      setOutcomes((o) => ({ ...o, [type]: err.isRateLimited ? { kind: "too_soon", remedy: err.remedy ?? null } : { kind: "error", message: err.message, remedy: err.remedy ?? null } }));
    }
  };

  const types = [...requests.filter((r) => r !== "call_for_bill"), "call_for_bill"];

  return (
    <BottomSheet isOpen={isOpen} onOpenChange={onOpenChange} title="Call staff" description="Someone will come to your table.">
      <ul className="flex flex-col gap-3" aria-label="Table requests">
        {types.map((type) => {
          const o = outcomes[type];
          const isBill = type === "call_for_bill";
          return (
            <li key={type} className="flex flex-col gap-1">
              <BrandButton variant={isBill ? "accent" : "secondary"} block className="min-h-14" onPress={() => void send(type)} isPending={o?.kind === "sending"} isDisabled={o?.kind === "sent"}>
                {requestLabel(type)}
              </BrandButton>
              <p role="status" aria-live="polite" className={o ? "min-h-6 px-1 text-caption " + (o.kind === "error" ? "text-status-alert" : o.kind === "sent" ? "text-status-paid" : "text-ink-2") : "min-h-6"}>
                {o?.kind === "sent" ? SENT : o?.kind === "too_soon" ? tooSoon(o.remedy) : o?.kind === "error" ? `${o.message}${o.remedy ? ` ${o.remedy}` : ""}` : ""}
              </p>
            </li>
          );
        })}
      </ul>
      <p className="pt-2 text-caption text-ink-2">Pay at the counter or ask your server for the bill.</p>
    </BottomSheet>
  );
}
