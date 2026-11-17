"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { quoteRound, type GuestApi } from "@/lib/api";
import type { BasketItem } from "@/lib/basket";
import { toRoundModifiers } from "@/lib/modifiers";
import type { RoundLineInput, RoundQuote } from "@/lib/types";

/** The lines as the register takes them, for a quote or a send. */
export function roundLines(items: Pick<BasketItem, "key" | "product_id" | "quantity" | "modifiers" | "notes">[]): RoundLineInput[] {
  return items.map((i) => ({ line_id: i.key, product_id: i.product_id, quantity: i.quantity, modifiers: toRoundModifiers(i.modifiers), notes: i.notes ?? undefined }));
}

export type Quote = {
  /** The register's figures, or null before the first answer and when it refused the lines. */
  quote: RoundQuote | null;
  /** The figures shown are for an earlier version of the lines; a new price is on its way. */
  updating: boolean;
  amountOf: (lineId: string) => number | null;
};

/**
 * The register's price for lines not yet sent (final review C-6): the phone shows each line's amount and the total
 * exactly as the register returns them, never adding anything up. While the lines change the last figures stay on
 * screen, marked as updating, until the new ones arrive.
 */
export function useQuote(api: GuestApi, sessionId: string, lines: RoundLineInput[], enabled = true): Quote {
  const q = useQuery({
    queryKey: ["quote", sessionId, lines.map((l) => [l.line_id, l.product_id, l.quantity, l.modifiers ?? []])],
    queryFn: () => quoteRound(api, lines.map(({ notes: _notes, ...l }) => l)),
    enabled: enabled && lines.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
  });
  const quote = enabled && lines.length > 0 && !q.isError ? (q.data ?? null) : null;
  const updating = q.isPlaceholderData;
  return { quote, updating, amountOf: (id) => quote?.lines.find((l) => l.line_id === id)?.amount ?? null };
}
