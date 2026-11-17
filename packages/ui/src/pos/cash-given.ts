/**
 * What a guest is likely to hand over for an amount, in minor units: the next multiple above it of each note or coin
 * worth at least a tenth of the amount (smaller coins only round up by a few cents), the three smallest of those, and
 * the smallest single note above the amount, which is what most people hand over (€20 for €10.00, not only €11, €12
 * and €15). An amount in whole units is met with whole units: $3 or $5 for $2.00, not $2.25 (review 3, S8).
 */
export function likelyTendered(amount: number, denominations: readonly { cents: number }[]): number[] {
  const out = new Set<number>();
  const whole = amount % 100 === 0;
  for (const d of denominations) {
    if (d.cents * 10 < amount) continue;
    const next = Math.ceil((amount + 1) / d.cents) * d.cents;
    if (!whole || next % 100 === 0) out.add(next);
  }
  const smallest = [...out].sort((a, b) => a - b).slice(0, 3);
  const note = denominations.map((d) => d.cents).filter((c) => c > amount).sort((a, b) => a - b)[0];
  if (note !== undefined && !smallest.includes(note)) smallest.push(note);
  return smallest.sort((a, b) => a - b);
}
