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

/** The cash-given buttons: see `likelyTendered` in @sail/ui. */
export { likelyTendered } from "@sail/ui";
