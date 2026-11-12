import type { LocaleFormat } from "@sail/ui";

/** "900 bps" -> "9%"; display only, never used for pricing. */
export function formatBps(bps: number): string {
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2)}%`;
}

/** Cash rounding increment in minor units -> "$0.05", "$1", or "Off", in the merchant's currency. Display only. */
export function formatRounding(increment: number | null, money: LocaleFormat["money"]): string {
  return increment ? money(increment, { dropZeroFraction: true }) : "Off";
}

/** Short id for tables: first 8 characters of a UUID. */
export function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : "—";
}
