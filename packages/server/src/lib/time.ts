import { localParts, zonedToUtc } from "@sail/shared";

/**
 * Business-date arithmetic. A business day rolls over at the outlet's cutoff
 * (for example 04:00), so an order at 01:30 belongs to the previous calendar
 * date. All inputs are explicit; no hidden clock reads in services.
 */
export function businessDateFor(at: Date, cutoff: string, timeZone: string): string {
  const { date, time } = localParts(at, timeZone);
  if (time < cutoff) return shiftDate(date, -1);
  return date;
}

export function shiftDate(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** The next business-day cutoff strictly after `now`. */
export function nextCutoff(now: Date, cutoff: string, timeZone: string): Date {
  const { date } = localParts(now, timeZone);
  let candidate = zonedToUtc(date, cutoff, timeZone);
  if (candidate.getTime() <= now.getTime()) candidate = zonedToUtc(shiftDate(date, 1), cutoff, timeZone);
  return candidate;
}
