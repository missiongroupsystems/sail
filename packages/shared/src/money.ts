/**
 * Money helpers. Every amount in Sail is an integer number of minor units of
 * the merchant's currency (cents for EUR, yen for JPY, fils for KWD). The type
 * and helper names say "cents" for brevity; nothing here assumes two decimals.
 *
 * The largest-remainder allocator is the single place where an amount is
 * split across parts. The pricing pipeline uses it to spread a rule's total
 * across lines, bill splits use it to spread a line across checks, and
 * refunds use it to reverse a share of each adjustment. Because all three
 * share this one function, the invariant "the parts add up to the whole, to
 * the cent" is proven once.
 */

export type Cents = number;

export function assertCents(value: unknown, what = "amount"): asserts value is Cents {
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isSafeInteger(value)) {
    throw new TypeError(`${what} must be an integer number of cents, got ${String(value)}`);
  }
}

/**
 * Split `total` cents across `weights` so that the parts sum exactly to `total`.
 *
 * - Parts are proportional to the weights, rounded with the largest-remainder
 *   method: each part is floored, then the leftover cents go, one each, to
 *   the parts with the largest fractional remainder.
 * - Ties are broken by index order (earlier parts first), so the result is
 *   deterministic for the same inputs.
 * - `total` may be negative; the sign is applied after allocating |total|.
 * - If every weight is 0 (or the list is empty), the amount is split evenly.
 */
export function allocateLargestRemainder(total: Cents, weights: readonly number[]): Cents[] {
  assertCents(total, "total");
  const n = weights.length;
  if (n === 0) {
    if (total !== 0) throw new RangeError("cannot allocate a non-zero total across zero parts");
    return [];
  }
  for (const w of weights) {
    if (!Number.isFinite(w) || w < 0) throw new RangeError(`weights must be finite and >= 0, got ${w}`);
  }
  const sum = weights.reduce((a, b) => a + b, 0);
  const effective = sum === 0 ? weights.map(() => 1) : weights;
  const effSum = sum === 0 ? n : sum;

  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);

  // Work in exact integers when the weights are integers: share numerator = abs * w, denominator = effSum. The
  // product passes 2^53 for large amounts (an IDR order and its discount), so it is taken in BigInt.
  const allInt = effective.every((w) => Number.isInteger(w));
  const floors: number[] = new Array(n);
  const remainders: (number | bigint)[] = new Array(n);
  let allocated = 0;
  for (let i = 0; i < n; i++) {
    const w = effective[i]!;
    if (allInt) {
      const num = BigInt(abs) * BigInt(w);
      const den = BigInt(effSum);
      const q = num / den;
      floors[i] = Number(q);
      remainders[i] = num - q * den; // integer remainder, comparable exactly
    } else {
      const exact = (abs * w) / effSum;
      const q = Math.floor(exact);
      floors[i] = q;
      remainders[i] = exact - q;
    }
    allocated += floors[i]!;
  }
  let leftover = abs - allocated;
  if (leftover > 0) {
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => {
      const ra = remainders[a]!;
      const rb = remainders[b]!;
      return rb > ra ? 1 : rb < ra ? -1 : a - b;
    });
    for (let k = 0; k < order.length && leftover > 0; k++) {
      floors[order[k]!]! += 1;
      leftover -= 1;
    }
  }
  // Defensive: floating-point weights could in theory leave leftover > 0 after
  // one pass only if n < leftover, which cannot happen since each floor is at
  // most 1 below its exact share.
  if (leftover !== 0) throw new Error("allocation did not converge");
  return floors.map((v) => sign * v);
}

export type Share = { num: number; den: number };

/** Allocate `total` across fractional shares (for example 1/3, 1/3, 1/3). Shares need not sum to 1. */
export function allocateByShares(total: Cents, shares: readonly Share[]): Cents[] {
  for (const s of shares) {
    if (!Number.isInteger(s.num) || !Number.isInteger(s.den) || s.den <= 0 || s.num < 0) {
      throw new RangeError(`invalid share ${s.num}/${s.den}`);
    }
  }
  const lcm = shares.reduce((acc, s) => lcmOf(acc, s.den), 1);
  const weights = shares.map((s) => s.num * (lcm / s.den));
  return allocateLargestRemainder(total, weights);
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}
function lcmOf(a: number, b: number): number {
  return (a / gcd(a, b)) * b;
}

/** Percent of an amount in cents, where `bps` is basis points (10 000 = 100%). Rounded half up, exactly. */
export function percentOfCents(amount: Cents, bps: number): Cents {
  assertCents(amount);
  if (!Number.isInteger(bps) || bps < 0) throw new RangeError(`bps must be a non-negative integer, got ${bps}`);
  // amount × bps passes 2^53 for large amounts, so the product is taken in BigInt; the result is at most the amount.
  const num = BigInt(Math.abs(amount)) * BigInt(bps);
  const q = num / 10_000n;
  const rounded = Number((num - q * 10_000n) * 2n >= 10_000n ? q + 1n : q);
  return amount < 0 ? -rounded : rounded;
}

/**
 * Round `amount` to the nearest `increment` minor units, halves rounded up
 * (away from zero): 5 for CHF (0.05), 100 for SEK (1 krona), 10 for JPY. Used only for cash tenders. Returns the rounded
 * amount and the difference `rounded - amount`.
 */
export function roundCash(amount: Cents, increment: number): { rounded: Cents; roundingCents: Cents } {
  assertCents(amount);
  if (!Number.isInteger(increment) || increment <= 0) throw new RangeError("increment must be a positive integer");
  if (increment === 1) return { rounded: amount, roundingCents: 0 };
  const sign = amount < 0 ? -1 : 1;
  const abs = Math.abs(amount);
  const q = Math.floor(abs / increment);
  const r = abs - q * increment;
  const roundedAbs = r * 2 >= increment ? (q + 1) * increment : q * increment;
  const rounded = sign * roundedAbs;
  return { rounded, roundingCents: rounded - amount };
}

export function sumCents(values: readonly Cents[]): Cents {
  let s = 0;
  for (const v of values) s += v;
  return s;
}

/**
 * ISO 4217 minor-unit exponents that are not 2. Every other active code has
 * two decimal places. Intl's CLDR data disagrees with ISO for a few codes
 * (for example IQD), so the stored amount follows this table, not Intl.
 */
const MINOR_UNIT_EXPONENTS: Record<string, number> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  CLF: 4, UYW: 4,
};

/** True for an ISO 4217 code this runtime knows, for example "EUR". */
export function isCurrencyCode(code: string): boolean {
  return /^[A-Z]{3}$/.test(code) && Intl.supportedValuesOf("currency").includes(code);
}

/** Number of decimal places of the currency's minor unit: 0 for JPY, 2 for EUR, 3 for KWD. */
export function currencyExponent(currency: string): number {
  if (!isCurrencyCode(currency)) throw new RangeError(`unknown currency ${currency}`);
  return MINOR_UNIT_EXPONENTS[currency] ?? 2;
}

/** The currency and locale every formatter and parser needs. There is no default. */
export type MoneyFormat = { currency: string; locale: string };

/** Decimal string for an amount in minor units: 1600 EUR → "16.00", 1600 JPY → "1600", 1234 KWD → "1.234". */
function decimalString(abs: number, exponent: number): string {
  if (exponent === 0) return String(abs);
  const digits = String(abs).padStart(exponent + 1, "0");
  return `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}

/**
 * Format an amount in minor units as a currency string in the given locale,
 * for example 1600 EUR in de-DE → "16,00 €". Negative amounts take a true
 * minus sign. Formatting only; never arithmetic.
 */
export function formatMoney(amount: Cents, money: MoneyFormat, opts: { sign?: "auto" | "always"; currencyDisplay?: "narrowSymbol" | "code" } = {}): string {
  assertCents(amount);
  const exponent = currencyExponent(money.currency);
  const fmt = new Intl.NumberFormat(money.locale, { style: "currency", currency: money.currency, currencyDisplay: opts.currencyDisplay ?? "narrowSymbol", minimumFractionDigits: exponent, maximumFractionDigits: exponent });
  // A decimal string keeps large amounts exact (Intl formats strings without converting to a float).
  const s = fmt.format(decimalString(Math.abs(amount), exponent) as Intl.StringNumericLiteral);
  if (amount < 0) return `−${s}`;
  if (opts.sign === "always") return `+${s}`;
  return s;
}

/**
 * Parse what a person typed into minor units, in the given locale: "16,50" in
 * de-DE → 1650 (EUR), "1,600" in ja-JP → 1600 (JPY), "٢٫١٢٥" in ar-KW → 2125
 * (KWD). Currency symbols, codes and spaces are ignored. Throws a RangeError
 * for text that is not an amount, has more decimal places than the currency
 * allows, or groups digits in a way the locale does not ("16.50" in de-DE is
 * not 1650.00, "1,00,000" in en-US is not 100000.00). See `parseAmount`.
 */
export function parseMoney(text: string, money: MoneyFormat): Cents {
  return parseAmount(text, { locale: money.locale, exponent: currencyExponent(money.currency), currency: money.currency });
}

/** Every decimal digit Intl writes (Latin, Arabic-Indic, Persian, Devanagari, Thai and the rest), mapped to its value. */
const DIGITS: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const ns of Intl.supportedValuesOf("numberingSystem")) {
    const f = new Intl.NumberFormat(`en-u-nu-${ns}`, { useGrouping: false });
    if (f.resolvedOptions().numberingSystem !== ns) continue;
    const digits = Array.from({ length: 10 }, (_, i) => f.format(i));
    if (digits.every((d) => /^\p{Nd}$/u.test(d))) digits.forEach((d, i) => map.set(d, String(i)));
  }
  return map;
})();

type Separators = { decimal: string; group: string | null; primary: number; secondary: number };

/**
 * The decimal and group separators of a locale and the sizes of its digit groups (3 and 3, or 3 and 2 in en-IN),
 * for plain numbers or for amounts in a currency, which some locales group differently (mr-IN).
 */
function separatorsOf(locale: string, currency: string | null): Separators {
  const parts = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, ...(currency ? { style: "currency", currency } : {}) }).formatToParts(1_234_567_890.5);
  const integers = parts.filter((p) => p.type === "integer").map((p) => p.value);
  const group = parts.find((p) => p.type === "group")?.value ?? null;
  return { decimal: parts.find((p) => p.type === "decimal")?.value ?? ".", group, primary: integers.at(-1)!.length, secondary: integers.length > 2 ? integers.at(-2)!.length : integers.at(-1)!.length };
}

/** Bidirectional marks Intl puts around numbers in right-to-left locales. */
const BIDI = /[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/gu;
const SPACE = /[\s\u00a0\u202f]/u;

/** One way to read the digits and separators left once the sign and symbols are gone; null when this set does not fit. */
function readDigits(t: string, sep: Separators): { whole: string; fraction: string } | null {
  let body = t;
  if (sep.group != null) {
    if (/^['’]$/.test(sep.group)) body = body.replace(/['’]/g, sep.group);
    if (SPACE.test(sep.group)) body = body.replace(/[\s\u00a0\u202f]/gu, sep.group);
  }
  const pieces = body.split(sep.decimal);
  if (pieces.length > 2) return null;
  const [whole = "", fraction = ""] = pieces;
  if (!/^\d*$/.test(fraction) || (whole === "" && fraction === "")) return null;
  if (/^\d*$/.test(whole)) return { whole, fraction };
  if (sep.group == null) return null;
  // Groups as the locale writes them: the first of one up to the secondary size, the middle ones secondary, the last primary.
  const groups = whole.split(sep.group);
  if (groups.length < 2 || groups.some((g) => !/^\d+$/.test(g))) return null;
  if (groups[0]!.length > sep.secondary || groups.at(-1)!.length !== sep.primary || groups.slice(1, -1).some((g) => g.length !== sep.secondary)) return null;
  return { whole: groups.join(""), fraction };
}

/**
 * Parse an amount into minor units, given the decimal places directly (the
 * register's exponent) and optionally the currency whose symbols may surround
 * it. This is the one parser every money field uses.
 *
 * - Digits may be the locale's own (Arabic-Indic in ar-KW, Devanagari in mr-IN)
 *   or Latin, which every keyboard can type. Each digit has one value, so they
 *   are read the same whatever the system.
 * - Separators are the locale's own, or, in a locale whose own digits are not
 *   Latin, those it uses with Latin digits ("2.125" and "٢٫١٢٥" are both 2.125 in
 *   ar-KW). Text that reads as two different amounts is refused.
 * - A sign (-, −, + or brackets), spaces, any currency symbol and the currency's
 *   own symbol and code may stand before or after the number, nowhere else.
 *
 * Everything `formatMoney` writes for a currency and locale parses back to the
 * same amount (property-tested across native digit systems and 0, 2 and 3
 * decimals).
 */
export function parseAmount(text: string, opts: { locale: string; exponent: number; currency: string | null }): Cents {
  const locales = [opts.locale];
  if (new Intl.NumberFormat(opts.locale).resolvedOptions().numberingSystem !== "latn") locales.push(new Intl.Locale(opts.locale, { numberingSystem: "latn" }).toString());
  const sets = [...new Map(locales.flatMap((l) => [separatorsOf(l, null), ...(opts.currency ? [separatorsOf(l, opts.currency)] : [])]).map((x) => [JSON.stringify(x), x])).values()];
  const symbols = opts.currency ? [...new Set((["narrowSymbol", "symbol", "code"] as const).map((d) => new Intl.NumberFormat(opts.locale, { style: "currency", currency: opts.currency!, currencyDisplay: d }).formatToParts(1).find((p) => p.type === "currency")?.value.replace(BIDI, "") ?? opts.currency!))] : [];
  const affix = `(?:[\\s\\u00a0\\u202f\\p{Sc}+\\-−()]${symbols.sort((a, b) => b.length - a.length).map((x) => `|${escapeRegExp(x)}`).join("")})+`;
  let t = [...text.replace(BIDI, "").trim()].map((c) => DIGITS.get(c) ?? c).join("");
  const lead = new RegExp(`^${affix}`, "u").exec(t)?.[0] ?? "";
  t = t.slice(lead.length);
  const trail = new RegExp(`${affix}$`, "u").exec(t)?.[0] ?? "";
  t = t.slice(0, t.length - trail.length);
  const negative = /[-−(]/.test(lead) || /[-−)]/.test(trail);
  const readings = [...new Map(sets.map((sep) => readDigits(t, sep)).filter((r) => r != null).map((r) => [`${r.whole}.${r.fraction}`, r])).values()];
  if (readings.length === 0) throw new RangeError(`not an amount in ${opts.locale}: ${text}`);
  if (readings.length > 1) throw new RangeError(`ambiguous amount in ${opts.locale}: ${text}`);
  const { whole, fraction } = readings[0]!;
  if (fraction.length > opts.exponent) throw new RangeError(`${opts.currency ?? "the currency"} has ${opts.exponent} decimal place${opts.exponent === 1 ? "" : "s"}: ${text}`);
  const minor = Number((whole || "0") + fraction.padEnd(opts.exponent, "0"));
  if (!Number.isSafeInteger(minor)) throw new RangeError(`amount too large: ${text}`);
  return negative ? -minor : minor;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
