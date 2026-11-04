/**
 * Business-date arithmetic. A business day rolls over at the outlet's cutoff
 * (for example 04:00), so an order at 01:30 belongs to the previous calendar
 * date. All inputs are explicit; no hidden clock reads in services.
 */
export function localParts(at: Date, timeZone: string): { date: string; time: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

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
