import { parseAmount } from "@sail/shared";

/**
 * Money, date and time formatting for one merchant: currency, locale (BCP 47)
 * and time zone come from the merchant's settings, never from the code. Every
 * surface formats through `useLocale()` under a `LocaleProvider`.
 */
export type LocaleSettings = {
  /** ISO 4217 code. Null while the register has not told this surface (a POS before sign-in): amounts show without a symbol. */
  currency: string | null;
  /** Decimal places of the currency's minor unit from the register (`settings.currency_exponent`); null takes them from Intl. */
  currencyExponent: number | null;
  locale: string;
  timeZone: string;
};

/** The first tag of an Accept-Language header ("en-GB,en;q=0.9" → "en-GB"), for server rendering before the merchant's locale is known. */
export function localeFromAcceptLanguage(header: string | null | undefined): string | null {
  const tag = header?.split(",")[0]?.split(";")[0]?.trim();
  if (!tag || tag === "*") return null;
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? null;
  } catch {
    return null;
  }
}

/** The device's own locale and time zone, used where the merchant's are not known yet. */
export function deviceLocale(): string {
  return new Intl.DateTimeFormat().resolvedOptions().locale;
}
export function deviceTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export type MoneyFormatOptions = {
  /** Show "+" on positive amounts (deltas). */
  signed?: boolean;
  /** Drop a zero fraction: "$20" rather than "$20.00" (note buttons). */
  dropZeroFraction?: boolean;
};

export type LocaleFormat = LocaleSettings & {
  /** Minor units of the currency (JPY 0, USD 2, KWD 3): the register's exponent, else Intl's. */
  minorDigits: number;
  /** "$", "¥", "KD" (narrow symbol), or "" without a currency. */
  symbol: string;
  /** The locale's decimal separator, for amount entry. */
  decimalSeparator: string;
  /** Integer minor units → "$1,234.50" in the merchant's locale. Display only: no arithmetic, no rounding. */
  money: (minor: number, opts?: MoneyFormatOptions) => string;
  /** Integer minor units → "1234.50" for an input: no symbol, no grouping, the locale's decimal separator. */
  moneyText: (minor: number | null | undefined) => string;
  /** "16", "16.5", "$1,600.00" → minor units. Text arithmetic only. Null for empty, undefined for malformed. */
  parseMoney: (text: string) => number | null | undefined;
  /** A plain number in the locale, up to `maxFractionDigits` decimals: 2.35 → "2.4" (1), "2,4" in de-DE. */
  number: (n: number, maxFractionDigits?: number) => string;
  /** "7:42 pm" */
  clock: (d: string | Date) => string;
  /** "4 Nov, 7:42 pm" */
  dayClock: (d: string | Date) => string;
  /** "Tuesday 4 November" */
  longDate: (d?: string | Date) => string;
  /** "4 Nov 2026, 7:42:10 pm" */
  fullStamp: (d: string | Date) => string;
  /** "4 Nov 2026, 7:42 pm" */
  stamp: (d: string | Date) => string;
  /** The calendar date in the merchant's zone, as YYYY-MM-DD. */
  isoDate: (d?: Date) => string;
  /** A business date the register sends as YYYY-MM-DD, for people: "Fri 13 Nov 2026" (anything else is shown as sent). */
  businessDay: (ymd: string) => string;
};

const MINUS = "−"; // true minus sign

function toDate(d: string | Date): Date {
  return typeof d === "string" ? new Date(d) : d;
}

/**
 * Lower-cases only the day period ("PM" → "pm"); other parts stay as the locale writes them. Node's ICU puts a
 * narrow no-break space before the day period where browsers put a plain space, so server-rendered times would not
 * hydrate; the narrow space is written as a plain one on both sides.
 */
function safeHourCycle(locale: string, timeZone: string): string | undefined {
  try {
    return new Intl.DateTimeFormat(locale, { hour: "numeric", timeZone }).resolvedOptions().hourCycle;
  } catch {
    return undefined;
  }
}

function dateFormatter(locale: string, opts: Intl.DateTimeFormatOptions): (d: Date) => string {
  const f = new Intl.DateTimeFormat(locale, opts);
  return (d) =>
    f
      .formatToParts(d)
      .map((p) => (p.type === "dayPeriod" ? p.value.toLowerCase() : p.type === "literal" ? p.value.replace(/\u202f/g, " ") : p.value))
      .join("");
}

/** Integer minor units as an exact decimal string ("-123450", 2 → "-1234.50"); no floating point. */
function decimalString(minor: number, digits: number): `${number}` {
  const negative = minor < 0;
  const raw = String(Math.abs(minor)).padStart(digits + 1, "0");
  const whole = raw.slice(0, raw.length - digits);
  const fraction = raw.slice(raw.length - digits);
  return `${negative ? "-" : ""}${whole}${digits > 0 ? `.${fraction}` : ""}` as `${number}`;
}

export function makeLocaleFormat(settings: LocaleSettings): LocaleFormat {
  const { currency, currencyExponent, locale, timeZone } = settings;
  // The register's exponent wins over Intl's table, so amounts in minor units never show with the wrong number of decimals.
  const digits = currencyExponent ?? (currency ? undefined : 2);
  const base: Intl.NumberFormatOptions = {
    ...(currency ? { style: "currency", currency, currencyDisplay: "narrowSymbol" } : { style: "decimal" }),
    ...(digits === undefined ? {} : { minimumFractionDigits: digits, maximumFractionDigits: digits }),
  };
  const minorDigits = new Intl.NumberFormat(locale, base).resolvedOptions().maximumFractionDigits ?? 2;
  const fmt = new Intl.NumberFormat(locale, base);
  const fmtSigned = new Intl.NumberFormat(locale, { ...base, signDisplay: "exceptZero" });
  const fmtWhole = new Intl.NumberFormat(locale, { ...base, minimumFractionDigits: 0 });
  const fmtWholeSigned = new Intl.NumberFormat(locale, { ...base, minimumFractionDigits: 0, signDisplay: "exceptZero" });
  const parts = fmt.formatToParts(-1234.5);
  const symbol = parts.find((p) => p.type === "currency")?.value ?? "";
  const decimalSeparator = new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === "decimal")?.value ?? ".";

  const money = (minor: number, opts: MoneyFormatOptions = {}): string => {
    if (!Number.isFinite(minor) || !Number.isInteger(minor)) return "—";
    const whole = opts.dropZeroFraction && minor % 10 ** minorDigits === 0;
    const f = whole ? (opts.signed ? fmtWholeSigned : fmtWhole) : opts.signed ? fmtSigned : fmt;
    return f
      .formatToParts(decimalString(minor, minorDigits))
      .map((p) => (p.type === "minusSign" ? MINUS : p.value))
      .join("");
  };

  // An input shows the amount as the locale writes numbers (its own digits and decimal separator), without grouping.
  const fmtText = new Intl.NumberFormat(locale, { useGrouping: false, minimumFractionDigits: minorDigits, maximumFractionDigits: minorDigits });
  const moneyText = (minor: number | null | undefined): string => {
    if (minor === null || minor === undefined || !Number.isInteger(minor)) return "";
    return fmtText.format(decimalString(minor, minorDigits));
  };

  // The shared parser: it reads back everything `money` and `moneyText` write, in the locale's digits or Latin ones.
  const parseMoney = (text: string): number | null | undefined => {
    if (text.trim() === "") return null;
    try {
      return parseAmount(text, { locale, exponent: minorDigits, currency });
    } catch {
      return undefined;
    }
  };

  // A 24-hour clock writes the hour with two digits ("09:05" in Ireland or Germany); a 12-hour one keeps "9:05 am".
  const hour: "numeric" | "2-digit" = /^h2[34]$/.test(safeHourCycle(locale, timeZone) ?? "") ? "2-digit" : "numeric";
  const clockF = dateFormatter(locale, { hour, minute: "2-digit", timeZone });
  const dayClockF = dateFormatter(locale, { day: "numeric", month: "short", hour, minute: "2-digit", timeZone });
  const longDateF = dateFormatter(locale, { weekday: "long", day: "numeric", month: "long", timeZone });
  const fullStampF = dateFormatter(locale, { dateStyle: "medium", timeStyle: "medium", timeZone });
  const stampF = dateFormatter(locale, { day: "numeric", month: "short", year: "numeric", hour, minute: "2-digit", timeZone });
  // A business date is a calendar day, not a moment: formatted in UTC so no zone moves it to the day before.
  const businessDayF = dateFormatter(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const isoDateF = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });

  return {
    ...settings,
    minorDigits,
    symbol,
    decimalSeparator,
    money,
    moneyText,
    parseMoney,
    number: (n, maxFractionDigits = 0) => new Intl.NumberFormat(locale, { maximumFractionDigits: maxFractionDigits }).format(n),
    clock: (d) => clockF(toDate(d)),
    dayClock: (d) => dayClockF(toDate(d)),
    longDate: (d = new Date()) => longDateF(toDate(d)),
    fullStamp: (d) => fullStampF(toDate(d)),
    stamp: (d) => stampF(toDate(d)),
    // en-CA writes dates as YYYY-MM-DD; this is a machine format, not shown to people.
    isoDate: (d = new Date()) => isoDateF.format(d),
    businessDay: (ymd) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
      return m ? businessDayF(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))) : ymd;
    },
  };
}
