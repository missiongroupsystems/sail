"use client";

import { useLocale } from "../lib/locale";

/** A business date the register sends as YYYY-MM-DD, written for people ("Fri 13 Nov 2026"). */
export function BusinessDay({ value }: { value: string }) {
  const { businessDay } = useLocale();
  return <>{businessDay(value)}</>;
}
