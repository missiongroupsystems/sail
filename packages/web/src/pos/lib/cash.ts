"use client";

import { denominationsFrom, useLocale, type Denomination } from "@sail/ui";
import { useMemo } from "react";
import { useMerchant } from "../hooks/queries";

/** The merchant's notes and coins (`cash_denominations`, minor units) for the cash counter and the cash-given buttons, largest first. */
export function useCashDenominations(): Denomination[] {
  const { money } = useLocale();
  const configured = useMerchant().data?.settings.cash_denominations;
  return useMemo(() => denominationsFrom(configured ?? [], money), [configured, money]);
}

/**
 * What a guest is likely to hand over for this amount: the next multiple above it of each note or coin worth at least a
 * tenth of the amount (smaller coins only round up by a few cents), the three smallest distinct ones.
 */
export function likelyTendered(amount: number, denominations: Denomination[]): number[] {
  const out = new Set<number>();
  for (const d of denominations) if (d.cents * 10 >= amount) out.add(Math.ceil((amount + 1) / d.cents) * d.cents);
  return [...out].sort((a, b) => a - b).slice(0, 3);
}
