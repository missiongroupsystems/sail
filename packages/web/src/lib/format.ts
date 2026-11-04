const TIME_ZONE = "Asia/Singapore";

const clock = new Intl.DateTimeFormat("en-SG", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: TIME_ZONE });
const dayAndClock = new Intl.DateTimeFormat("en-SG", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true, timeZone: TIME_ZONE });
const longDate = new Intl.DateTimeFormat("en-SG", { weekday: "long", day: "numeric", month: "long", timeZone: TIME_ZONE });
const fullStamp = new Intl.DateTimeFormat("en-SG", { dateStyle: "medium", timeStyle: "medium", timeZone: TIME_ZONE });

/** "7:42 pm" (design 6). */
export function formatClock(iso: string | Date): string {
  return clock.format(typeof iso === "string" ? new Date(iso) : iso).toLowerCase();
}

/** "4 Nov, 7:42 pm" */
export function formatDayClock(iso: string | Date): string {
  return dayAndClock.format(typeof iso === "string" ? new Date(iso) : iso).toLowerCase();
}

/** "Tuesday 4 November" */
export function formatLongDate(d: Date = new Date()): string {
  return longDate.format(d);
}

export function formatFullStamp(iso: string): string {
  return fullStamp.format(new Date(iso));
}

/** "900 bps" -> "9%"; display only, never used for pricing. */
export function formatBps(bps: number): string {
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2)}%`;
}

/** Cash rounding increment in cents -> "5¢", "$1", or "Off". Display only. */
export function formatRounding(increment: number | null): string {
  if (!increment) return "Off";
  if (increment < 100) return `${increment}¢`;
  return increment % 100 === 0 ? `$${increment / 100}` : `$${(increment / 100).toFixed(2)}`;
}

/** Short id for tables: first 8 characters of a UUID. */
export function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : "—";
}
