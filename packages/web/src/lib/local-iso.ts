/**
 * A moment as an ISO 8601 local time with its offset in `timeZone` ("2026-11-17T23:30:00-05:00"), so an export says
 * the time the screen shows, on the day it shows, and stays exact.
 */
export function localIso(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset" }).formatToParts(d).map((p) => [p.type, p.value]));
  const offset = String(parts.timeZoneName ?? "GMT").replace(/^GMT$/, "GMT+00:00").replace(/^GMT/, "");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}
