"use client";

import { denominationsFrom, fallbackDenominationValues, useLocale, type Denomination } from "@sail/ui";
import { useMemo } from "react";
import { useMerchant } from "../hooks/queries";

/**
 * The merchant's notes and coins for the cash counter and the cash-given buttons, largest first: the register's
 * `cash_denominations` (minor units) when it sends them, otherwise a series derived from the currency.
 */
export function useCashDenominations(): Denomination[] {
  const { money, minorDigits } = useLocale();
  const settings = useMerchant().data?.settings;
  const configured = settings?.cash_denominations;
  const smallestCoin = settings?.cash_rounding_increment ?? null;
  return useMemo(() => {
    const values = Array.isArray(configured) && configured.length > 0 ? configured : fallbackDenominationValues(minorDigits, smallestCoin);
    return denominationsFrom(values, money);
  }, [configured, smallestCoin, minorDigits, money]);
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
