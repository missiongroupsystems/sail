/**
 * Wall-clock time in an IANA zone. Pure: the zone is always passed in, never
 * taken from the process or the browser.
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

const offsetFormats = new Map<string, Intl.DateTimeFormat>();

/** How far `timeZone` is ahead of UTC at the instant `t` (ms since the epoch, whole seconds), in ms. */
function offsetAt(t: number, timeZone: string): number {
  let fmt = offsetFormats.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    offsetFormats.set(timeZone, fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - t;
}

/**
 * Convert a local date and time in `timeZone` to a UTC instant. A time the
 * clocks skip (the spring-forward gap) maps to the first valid instant after
 * the gap, the moment the clocks change; a time that happens twice (the
 * fall-back overlap) maps to its first occurrence.
 */
export function zonedToUtc(isoDate: string, time: string, timeZone: string): Date {
  const [y, mo, d] = isoDate.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
  // The offsets a day either side; a zone changes at most once in that window.
  const before = offsetAt(wall - 86_400_000, timeZone);
  const after = offsetAt(wall + 86_400_000, timeZone);
  const valid = [wall - before, wall - after].filter((t) => t + offsetAt(t, timeZone) === wall);
  if (valid.length) return new Date(Math.min(...valid));
  // In the gap: wall − after is still on the old offset and wall − before already on the new one; find the change.
  let lo = wall - after;
  let hi = wall - before;
  while (hi - lo > 1000) {
    const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
    if (offsetAt(mid, timeZone) === before) lo = mid;
    else hi = mid;
  }
  return new Date(hi);
}

const INPUT_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/;

/** A `<input type="datetime-local">` value ("2026-07-01T17:00") read in `timeZone`, as an ISO instant; undefined when empty or malformed. */
export function zonedInputToIso(value: string, timeZone: string): string | undefined {
  const m = INPUT_RE.exec(value);
  if (!m) return undefined;
  const at = zonedToUtc(m[1]!, m[2]!, timeZone);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

/** An ISO instant as a `<input type="datetime-local">` value in `timeZone`; empty when missing or malformed. */
export function isoToZonedInput(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const { date, time } = localParts(at, timeZone);
  return `${date}T${time}`;
}
