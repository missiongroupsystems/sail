/**
 * An independent tax oracle for the money fuzzer: the tax rules of pricing-semantics §2 step 5, written apart from the
 * engine (no shared code but the rate lookup), so a regression in the engine's arithmetic cannot hide in its own tests.
 * Exact for every amount the register accepts: products are taken in BigInt.
 */

/** n / d rounded half up, for n ≥ 0 and d > 0. */
export function halfUp(n: bigint, d: bigint): bigint {
  const q = n / d;
  return (n - q * d) * 2n >= d ? q + 1n : q;
}

/** The tax on one amount at a combined rate: exclusive adds bps/10000 of it; inclusive is the part of it that is tax. */
export function taxOf(amount: number, bps: number, mode: "inclusive" | "exclusive" | string): number {
  if (bps === 0) return 0;
  const a = BigInt(Math.abs(amount));
  const t = Number(mode === "exclusive" ? halfUp(a * BigInt(bps), 10_000n) : halfUp(a * BigInt(bps), BigInt(10_000 + bps)));
  return amount < 0 ? -t : t;
}

export type TaxedItem = { components: { name: string; bps: number }[]; amount: number; tax: number };

/**
 * Check an order's tax against the rules. `per_line`: each taxed item (a line's net amount, one fee on one line) is
 * rounded on its own. `per_rate`: items are grouped by their rate and each group is rounded once on its total. Returns
 * one message per item or group that disagrees.
 */
export function taxDisagreements(items: TaxedItem[], mode: string, rounding: string): string[] {
  const out: string[] = [];
  const bpsOf = (c: TaxedItem["components"]) => c.reduce((s, x) => s + x.bps, 0);
  if (rounding === "per_line") {
    for (const i of items) {
      const exp = taxOf(i.amount, bpsOf(i.components), mode);
      if (exp !== i.tax) out.push(`per_line: tax on ${i.amount} at ${bpsOf(i.components)} bps is ${i.tax}, expected ${exp}`);
    }
    return out;
  }
  const groups = new Map<string, { bps: number; amount: number; tax: number }>();
  for (const i of items) {
    const key = i.components.map((c) => `${c.bps}|${c.name}`).join("+");
    const g = groups.get(key) ?? { bps: bpsOf(i.components), amount: 0, tax: 0 };
    g.amount += i.amount;
    g.tax += i.tax;
    groups.set(key, g);
  }
  for (const [key, g] of groups) {
    const exp = taxOf(g.amount, g.bps, mode);
    if (exp !== g.tax) out.push(`per_rate: rate ${key} on ${g.amount} is ${g.tax}, expected ${exp}`);
  }
  return out;
}
