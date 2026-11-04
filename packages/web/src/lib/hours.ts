import type { OutletHours, OutletHoursRead } from "./api/types";

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const WEEKDAY_LABEL: Record<Weekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** One range per day in the form; the API allows several (a follow-up for split shifts). */
export type DayHoursForm = { open: boolean; from: string; to: string };
export type HoursForm = Record<Weekday, DayHoursForm>;

export const DEFAULT_DAY: DayHoursForm = { open: true, from: "11:00", to: "22:00" };

export function hoursToForm(hours: OutletHoursRead | undefined): HoursForm {
  const out = {} as HoursForm;
  for (const day of WEEKDAYS) {
    const ranges = hours?.[day] ?? [];
    const first = ranges[0];
    out[day] = first && first[0] !== undefined && first[1] !== undefined ? { open: true, from: first[0], to: first[1] } : { open: false, from: DEFAULT_DAY.from, to: DEFAULT_DAY.to };
  }
  return out;
}

export function formToHours(form: HoursForm): OutletHours {
  const out: OutletHours = {};
  for (const day of WEEKDAYS) {
    const d = form[day];
    out[day] = d.open ? [[d.from, d.to]] : [];
  }
  return out;
}

/** "Mon–Fri 11:00–22:00 · Sat–Sun 11:00–23:00", or "Closed" when no day is open. */
export function summariseHours(hours: OutletHoursRead | undefined): string {
  if (!hours) return "Hours not set";
  const groups: { days: Weekday[]; text: string }[] = [];
  for (const day of WEEKDAYS) {
    const ranges = hours[day] ?? [];
    const text = ranges.length ? ranges.map((r) => `${r[0] ?? "?"}–${r[1] ?? "?"}`).join(", ") : "";
    const last = groups[groups.length - 1];
    if (last && last.text === text) last.days.push(day);
    else groups.push({ days: [day], text });
  }
  const parts = groups
    .filter((g) => g.text)
    .map((g) => {
      const first = g.days[0]!;
      const lastDay = g.days[g.days.length - 1]!;
      const label = g.days.length > 1 ? `${cap(first)}–${cap(lastDay)}` : cap(first);
      return `${label} ${g.text}`;
    });
  return parts.length ? parts.join(" · ") : "Closed";
}

function cap(day: Weekday): string {
  return day.charAt(0).toUpperCase() + day.slice(1);
}
