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

/** Convert a local date and time in `timeZone` to a UTC instant (handles any fixed or DST offset by iteration). */
export function zonedToUtc(isoDate: string, time: string, timeZone: string): Date {
  const [y, mo, d] = isoDate.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  let guess = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
  for (let i = 0; i < 2; i++) {
    const local = localParts(new Date(guess), timeZone);
    const [ly, lmo, ld] = local.date.split("-").map(Number) as [number, number, number];
    const [lh, lmi] = local.time.split(":").map(Number) as [number, number];
    const asIfUtc = Date.UTC(ly, lmo - 1, ld, lh, lmi, 0, 0);
    const diff = asIfUtc - guess; // how far the zone is ahead of UTC at this instant
    guess = Date.UTC(y, mo - 1, d, h, mi, 0, 0) - diff;
  }
  return new Date(guess);
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
