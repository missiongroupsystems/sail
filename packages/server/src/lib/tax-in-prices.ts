/** The tax inside item prices: gross less its discounts less net before refunds (0 when tax is added on top, by definition). */
export function taxInPrices(gross: number, discounts: number, netBeforeRefunds: number): number {
  return gross - Math.abs(discounts) - netBeforeRefunds;
}
