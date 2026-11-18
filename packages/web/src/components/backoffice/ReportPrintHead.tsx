"use client";

import { useLocale } from "@sail/ui";

/**
 * A report's title and scope at the top of its printed page; the screen has them in the header and the action row.
 * The scope reads as words, as the screen shows it: its values only, a business date as "Tue 17 Nov 2026", a range as
 * "Fri 13 Nov 2026 to Tue 17 Nov 2026", and no "any date" (review 5, V8). The CSV keeps the labelled pairs.
 */
export function ReportPrintHead({ title, scope }: { title: string; scope: [string, string][] }) {
  const { businessDay } = useLocale();
  const shown = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? businessDay(v) : v);
  const from = scope.find(([k]) => k === "From")?.[1];
  const to = scope.find(([k]) => k === "To")?.[1];
  const parts = scope.flatMap(([k, v]): string[] => {
    if (!v || v === "Any") return [];
    if (k === "To") return [];
    if (k === "From") return [to && to !== v ? `${shown(v)} to ${shown(to)}` : shown(v)];
    return [shown(v)];
  });
  if (!from && to) parts.push(shown(to));
  return (
    <div data-export="skip" className="col-span-full mb-6 hidden print:block">
      <h2 className="font-heading text-[16px] leading-[1.35] font-semibold tracking-[-0.01em] text-ink">{title}</h2>
      <p className="text-[13.5px] leading-5 text-ink-2">{parts.join(" · ")}</p>
    </div>
  );
}
