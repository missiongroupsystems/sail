import { cx } from "../lib/cx";

const MINUS = "−"; // true minus sign (design 6)

const symbolCache = new Map<string, string>();
const groupCache = new Map<string, Intl.NumberFormat>();

function currencySymbol(locale: string, currency: string): string {
  const key = `${locale}|${currency}`;
  let sym = symbolCache.get(key);
  if (sym === undefined) {
    const parts = new Intl.NumberFormat(locale, { style: "currency", currency, currencyDisplay: "narrowSymbol" }).formatToParts(0);
    sym = parts.find((p) => p.type === "currency")?.value ?? currency;
    symbolCache.set(key, sym);
  }
  return sym;
}

function groupFormatter(locale: string): Intl.NumberFormat {
  let f = groupCache.get(locale);
  if (!f) {
    f = new Intl.NumberFormat(locale, { useGrouping: true, maximumFractionDigits: 0 });
    groupCache.set(locale, f);
  }
  return f;
}

export type FormatCentsOptions = {
  locale?: string;
  currency?: string;
  /** Show "+" on positive amounts (deltas). */
  signed?: boolean;
  /** Minor units of the currency; SGD has 2. */
  fractionDigits?: number;
};

/**
 * Formats integer minor units (cents) as a currency string using Intl for the
 * symbol and digit grouping. The integer is split as text, so there is no
 * floating-point arithmetic and no rounding: the register's cents are shown as
 * they are. "−" is a true minus sign.
 */
export function formatCents(cents: number, opts: FormatCentsOptions = {}): string {
  const { locale = "en-SG", currency = "SGD", signed = false, fractionDigits = 2 } = opts;
  if (!Number.isFinite(cents) || !Number.isInteger(cents)) return "—";
  const negative = cents < 0;
  const digits = String(negative ? -cents : cents).padStart(fractionDigits + 1, "0");
  const whole = digits.slice(0, digits.length - fractionDigits);
  const fraction = digits.slice(digits.length - fractionDigits);
  const grouped = groupFormatter(locale).format(BigInt(whole));
  const sign = negative ? MINUS : signed && cents > 0 ? "+" : "";
  return `${sign}${currencySymbol(locale, currency)}${grouped}${fractionDigits > 0 ? `.${fraction}` : ""}`;
}

export type MoneyProps = FormatCentsOptions & {
  /** Integer cents from the API. This component never adds, subtracts or rounds. */
  cents: number;
  className?: string;
  /** Type style: `body` (default), `line`, `title`, or `amount-xl` for balances. */
  size?: "caption" | "body" | "line" | "heading" | "title" | "amount-xl" | "display";
  /** Dim the figure while the register is repricing (7.8 pricing state). */
  pending?: boolean;
};

const sizeClass: Record<NonNullable<MoneyProps["size"]>, string> = {
  caption: "text-caption",
  body: "text-body",
  line: "text-line",
  heading: "text-heading",
  title: "text-title",
  "amount-xl": "text-amount-xl",
  display: "text-display",
};

export function Money({ cents, className, size = "body", pending, locale, currency, signed, fractionDigits }: MoneyProps) {
  const text = formatCents(cents, { locale, currency, signed, fractionDigits });
  return (
    <span
      className={cx("tabular whitespace-nowrap", sizeClass[size], pending && "opacity-60", className)}
      aria-busy={pending || undefined}
    >
      {text}
    </span>
  );
}
