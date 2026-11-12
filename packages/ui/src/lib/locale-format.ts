/**
 * Money, date and time formatting for one merchant: currency, locale (BCP 47)
 * and time zone come from the merchant's settings, never from the code. Every
 * surface formats through `useLocale()` under a `LocaleProvider`.
 */
export type LocaleSettings = {
  /** ISO 4217 code. Null while the register has not told this surface (the guest app today): amounts show without a symbol. */
  currency: string | null;
  locale: string;
  timeZone: string;
};

/** The merchant settings fields read here (`GET /v1/merchant` → `data.settings`). `locale` is optional until the register sends it. */
export type LocaleSettingsSource = { currency?: string | null; timezone?: string | null; locale?: string | null };

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

/** Settings from the merchant record; the locale falls back to `fallbackLocale` (the request's or the device's) until the register has one. */
export function localeSettings(source: LocaleSettingsSource | null | undefined, fallbackLocale: string): LocaleSettings {
  return {
    currency: source?.currency || null,
    locale: source?.locale || fallbackLocale,
    timeZone: source?.timezone || deviceTimeZone(),
  };
}

export type MoneyFormatOptions = {
  /** Show "+" on positive amounts (deltas). */
  signed?: boolean;
  /** Drop a zero fraction: "$20" rather than "$20.00" (note buttons). */
  dropZeroFraction?: boolean;
};

export type LocaleFormat = LocaleSettings & {
  /** Minor units of the currency (JPY 0, USD 2, KWD 3), from ISO 4217 via Intl. */
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
};

const MINUS = "−"; // true minus sign (design 6)

function toDate(d: string | Date): Date {
  return typeof d === "string" ? new Date(d) : d;
}

/**
 * Lower-cases only the day period ("PM" → "pm", design 6); other parts stay as the locale writes them. Node's ICU puts a
 * narrow no-break space before the day period where browsers put a plain space, so server-rendered times would not
 * hydrate; the narrow space is written as a plain one on both sides.
 */
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
  const { currency, locale, timeZone } = settings;
  const base: Intl.NumberFormatOptions = currency ? { style: "currency", currency, currencyDisplay: "narrowSymbol" } : { style: "decimal", minimumFractionDigits: 2, maximumFractionDigits: 2 };
  const minorDigits = new Intl.NumberFormat(locale, base).resolvedOptions().maximumFractionDigits ?? 2;
  const fmt = new Intl.NumberFormat(locale, base);
  const fmtSigned = new Intl.NumberFormat(locale, { ...base, signDisplay: "exceptZero" });
  const fmtWhole = new Intl.NumberFormat(locale, { ...base, minimumFractionDigits: 0 });
  const fmtWholeSigned = new Intl.NumberFormat(locale, { ...base, minimumFractionDigits: 0, signDisplay: "exceptZero" });
  const parts = fmt.formatToParts(-1234.5);
  const symbol = parts.find((p) => p.type === "currency")?.value ?? "";
  const decimalSeparator = new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === "decimal")?.value ?? ".";
  const groupSeparator = new Intl.NumberFormat(locale).formatToParts(12345).find((p) => p.type === "group")?.value ?? ",";

  const money = (minor: number, opts: MoneyFormatOptions = {}): string => {
    if (!Number.isFinite(minor) || !Number.isInteger(minor)) return "—";
    const whole = opts.dropZeroFraction && minor % 10 ** minorDigits === 0;
    const f = whole ? (opts.signed ? fmtWholeSigned : fmtWhole) : opts.signed ? fmtSigned : fmt;
    return f
      .formatToParts(decimalString(minor, minorDigits))
      .map((p) => (p.type === "minusSign" ? MINUS : p.value))
      .join("");
  };

  const moneyText = (minor: number | null | undefined): string => {
    if (minor === null || minor === undefined || !Number.isInteger(minor)) return "";
    return decimalString(minor, minorDigits).replace(".", decimalSeparator);
  };

  const parseMoney = (text: string): number | null | undefined => {
    // The symbol and sign drop out; the locale's group separator is allowed only between groups of three digits, so a
    // separator the locale does not use ("16.50" where the decimal is ",") is malformed rather than a hundredfold amount.
    const negative = /^[^\d]*[-−]/.test(text);
    const body = text.replace(/[^\d.,'’\s\u00a0\u202f]/g, "").trim();
    if (body === "") return null;
    const pieces = body.split(decimalSeparator);
    if (pieces.length > 2) return undefined;
    const [wholeRaw = "", fraction = ""] = pieces;
    const group = groupSeparator.replace(/[\s\u00a0\u202f]/, " ");
    const wholeNorm = wholeRaw.replace(/[\s\u00a0\u202f]/g, " ");
    const grouped = wholeNorm.split(group);
    const wholeOk = /^\d*$/.test(wholeNorm) || (grouped.length > 1 && /^\d{1,3}$/.test(grouped[0]!) && grouped.slice(1).every((g) => /^\d{3}$/.test(g)));
    if (!wholeOk || !/^\d*$/.test(fraction)) return undefined;
    const whole = grouped.join("");
    if (whole === "" && fraction === "") return null;
    if (fraction.length > minorDigits) return undefined;
    const value = Number(`${whole || "0"}${fraction.padEnd(minorDigits, "0")}`);
    if (!Number.isSafeInteger(value)) return undefined;
    return negative ? -value : value;
  };

  const clockF = dateFormatter(locale, { hour: "numeric", minute: "2-digit", timeZone });
  const dayClockF = dateFormatter(locale, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone });
  const longDateF = dateFormatter(locale, { weekday: "long", day: "numeric", month: "long", timeZone });
  const fullStampF = dateFormatter(locale, { dateStyle: "medium", timeStyle: "medium", timeZone });
  const stampF = dateFormatter(locale, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone });
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
  };
}
