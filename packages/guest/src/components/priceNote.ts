import type { GuestTax } from "@/lib/types";

/** "VAT", "GST"; a tax with parts that share a name ("State sales tax", "Local sales tax") reads "sales tax". */
export function taxName(names: readonly string[]): string {
  if (names.length === 1) return names[0]!;
  const words = names.map((n) => n.split(/\s+/));
  const common: string[] = [];
  for (let i = 1; words.length > 0 && words.every((w) => w.length >= i && w[w.length - i]!.toLowerCase() === words[0]![words[0]!.length - i]!.toLowerCase()); i++) {
    common.unshift(words[0]![words[0]!.length - i]!.toLowerCase());
  }
  return common.length ? common.join(" ") : "tax";
}

const midSentence = (name: string) => (name === name.toUpperCase() ? name : name.charAt(0).toLowerCase() + name.slice(1));
const sentenceStart = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/**
 * The note under the prices, right from the first scan: whether the merchant's prices include its tax, in the tax's
 * own name, from the merchant's tax settings (final review C-7). Before the register has answered it says only what
 * the bill may add.
 */
export function priceNote(tax: GuestTax | null | undefined): string {
  if (!tax || tax.names.length === 0) return "Any service charge is added to your bill.";
  const name = taxName(tax.names);
  if (tax.mode === "inclusive") return `Prices include ${midSentence(name)}. Any service charge is added to your bill.`;
  return `${sentenceStart(name)} is added to your bill, with any service charge.`;
}
