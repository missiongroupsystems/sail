/**
 * What a guest is likely to hand over for an amount, in minor units: the next multiple above it of each note or coin
 * worth at least a tenth of the amount (smaller coins only round up by a few cents), the three smallest of those, and
 * the smallest single note above the amount, which is what most people hand over (€20 for €10.00, not only €11, €12
 * and €15). An amount in whole units is met by Exact and by notes (five units and up): $5 or $10 for $2.00, $15 or $20 for
 * $10.00, never $2.25 or $11 (review 3 S8, review 5 W5). An amount
 * with cents also offers the next whole unit, when there is a one-unit coin or note: €17 for €16.22 (review 4 U7).
 */
export function likelyTendered(amount: number, denominations: readonly { cents: number }[]): number[] {
  const out = new Set<number>();
  const whole = amount % 100 === 0;
  for (const d of denominations) {
    if (d.cents * 10 < amount) continue;
    // A whole amount is met by Exact or by notes: $20 or $50 for $10.00, never $11 (review 5 W5).
    if (whole && d.cents < 500) continue;
    const next = Math.ceil((amount + 1) / d.cents) * d.cents;
    if (!whole || next % 100 === 0) out.add(next);
  }
  if (!whole && denominations.some((d) => d.cents === 100)) out.add(Math.ceil(amount / 100) * 100);
  const smallest = [...out].sort((a, b) => a - b).slice(0, 3);
  const note = denominations.map((d) => d.cents).filter((c) => c > amount).sort((a, b) => a - b)[0];
  if (note !== undefined && !smallest.includes(note)) smallest.push(note);
  return smallest.sort((a, b) => a - b);
}
