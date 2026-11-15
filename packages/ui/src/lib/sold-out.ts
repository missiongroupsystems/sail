/**
 * The words for an item's sold-out state. The register sends `sold_out_until` as null (sold out with no end set),
 * the literal "indefinite" (until someone restores it) or an ISO time; only an ISO time is a moment to format.
 */
export function soldOutText(entry: { sold_out: boolean; sold_out_until: string | null }, formatTime: (iso: string) => string): string {
  if (!entry.sold_out) return "";
  const until = entry.sold_out_until;
  if (!until || until === "indefinite" || Number.isNaN(Date.parse(until))) return "Sold out until restored";
  return `Sold out until ${formatTime(until)}`;
}
