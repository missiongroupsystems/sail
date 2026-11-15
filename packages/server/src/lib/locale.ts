/** Validators for the settings that make a merchant country-neutral: time zone, locale, cash rounding and denominations. */

/** A valid IANA time zone: `Intl` throws on unknown zones, which would otherwise break every request's business-date stamp. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A BCP 47 locale the runtime can format money and dates in. */
export function isValidLocale(locale: string): boolean {
  try {
    return Intl.getCanonicalLocales(locale).length === 1 && Intl.NumberFormat.supportedLocalesOf(locale).length === 1;
  } catch {
    return false;
  }
}

/** Cash rounds to 1, 2 or 5 times a power of ten minor units: 5 (CHF 0.05), 10 (JPY 10), 50 (DKK 0.50), 100 (SEK 1). */
export function isCashRoundingIncrement(n: number): boolean {
  if (!Number.isInteger(n) || n < 1 || n > 100_000) return false;
  let m = n;
  while (m % 10 === 0) m /= 10;
  return m === 1 || m === 2 || m === 5;
}

/** Notes and coins for the cash counter: distinct positive minor-unit values, largest first. */
export function validDenominations(d: readonly number[]): boolean {
  return d.length <= 30 && d.every((v, i) => Number.isInteger(v) && v > 0 && (i === 0 || v < d[i - 1]!));
}
