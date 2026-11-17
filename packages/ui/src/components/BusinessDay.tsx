"use client";

import { useLocale } from "../lib/locale";

/** A business date the register sends as YYYY-MM-DD, written for people ("Fri 13 Nov 2026"); the date itself stays on the element for exports. */
export function BusinessDay({ value }: { value: string }) {
  const { businessDay } = useLocale();
  return <time dateTime={value}>{businessDay(value)}</time>;
}
