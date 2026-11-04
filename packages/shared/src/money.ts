/**
 * Money helpers. Every amount in Sail is an integer number of cents.
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

  // Work in integers when the weights are integers to avoid floating-point
  // drift: exact share numerator = abs * w, denominator = effSum.
  const allInt = effective.every((w) => Number.isInteger(w));
  const floors: number[] = new Array(n);
  const remainders: number[] = new Array(n);
  let allocated = 0;
  for (let i = 0; i < n; i++) {
    const w = effective[i]!;
    if (allInt) {
      const num = abs * w;
      const q = Math.floor(num / effSum);
      floors[i] = q;
      remainders[i] = num - q * effSum; // integer remainder, comparable exactly
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
      const d = remainders[b]! - remainders[a]!;
      return d !== 0 ? d : a - b;
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

/** Percent of an amount in cents, where `bps` is basis points (10 000 = 100%). Rounded half up. */
export function percentOfCents(amount: Cents, bps: number): Cents {
  assertCents(amount);
  if (!Number.isInteger(bps) || bps < 0) throw new RangeError(`bps must be a non-negative integer, got ${bps}`);
  const num = Math.abs(amount) * bps;
  const q = Math.floor(num / 10_000);
  const r = num - q * 10_000;
  const rounded = r * 2 >= 10_000 ? q + 1 : q;
  return amount < 0 ? -rounded : rounded;
}

/**
 * Round `amount` to the nearest `increment` cents, halves rounded up (away
 * from zero). Used only for cash tenders (scope doc 4.3). Returns the rounded
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

/** Format integer cents as an en-SG currency string, for example 1600 → "$16.00". Formatting only; never arithmetic. */
export function formatCents(cents: Cents, opts: { currency?: string; sign?: "auto" | "always" } = {}): string {
  const currency = opts.currency ?? "SGD";
  const fmt = new Intl.NumberFormat("en-SG", { style: "currency", currency, currencyDisplay: "narrowSymbol" });
  const s = fmt.format(Math.abs(cents) / 100);
  if (cents < 0) return `−${s}`;
  if (opts.sign === "always") return `+${s}`;
  return s;
}
