import { formatMoney, type MoneyFormat } from "@sail/shared";

/**
 * Text for PDFs drawn with the standard fonts, which encode WinAnsi only: Latin-1 plus the euro sign and a few
 * punctuation marks. A character with a WinAnsi look-alike becomes it (the minus sign, narrow spaces, the fullwidth yen
 * sign); bidirectional marks drop out; anything else is a "?". Scripts outside WinAnsi (Arabic, CJK) need an embedded
 * font, which these documents do not have yet.
 */
export function winAnsi(s: string): string {
  return s
    .replace(/[‎‏؜‪-‮⁦-⁩]/g, "")
    .replace(/−/g, "-")
    .replace(/[  ]/g, " ")
    .replace(/￥/g, "¥")
    .replace(/[^ -~ -ÿ€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/g, "?");
}

/** The locale with Latin digits, so amounts and dates on a PDF are readable whatever the locale's own digits are. */
export function latinDigits(locale: string): string {
  return new Intl.Locale(locale, { numberingSystem: "latn" }).toString();
}

/** Amounts as a PDF can draw them: Latin digits, and the currency's ISO code where its symbol is not in WinAnsi ("KWD 2.125"). */
export function pdfMoney(money: MoneyFormat): (amount: number) => string {
  const fmt = { currency: money.currency, locale: latinDigits(money.locale) };
  return (amount) => {
    const s = winAnsi(formatMoney(amount, fmt));
    return s.includes("?") ? winAnsi(formatMoney(amount, fmt, { currencyDisplay: "code" })) : s;
  };
}

/** A date and time as a PDF can draw it: the locale's own style with Latin digits, else "2026-01-01 00:00" in the zone. */
export function pdfDateTime(iso: string, locale: string, timeZone: string): string {
  const d = new Date(iso);
  const s = winAnsi(d.toLocaleString(latinDigits(locale), { timeZone, dateStyle: "medium", timeStyle: "short" }));
  if (!s.includes("?")) return s;
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
