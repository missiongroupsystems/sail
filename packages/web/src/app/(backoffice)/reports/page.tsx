import { SectionHeading } from "@sail/ui";
import Link from "next/link";

const REPORTS = [
  { href: "/reports/z-report", title: "Z-report", detail: "Sales, tenders, cash, voids and refunds for an outlet, date and station. Close the business day from here." },
  { href: "/reports/sales", title: "Sales", detail: "Totals, days, tenders and categories for an outlet over a range of business dates." },
  { href: "/reports/items", title: "Items", detail: "What sold, by item, category or staff member, with each one's share of net sales." },
  { href: "/reports/shifts", title: "Shifts", detail: "Open and closed shifts with expected, counted and variance, and each shift's stored summary." },
  { href: "/reports/print-health", title: "Print health", detail: "Jobs, failures, reroutes, reprints and late tickets by printer, with time to print." },
];

/** Reports: every report the register serves. Never a gap or a 404. */
export default function ReportsIndex() {
  return (
    <div className="flex max-w-[720px] flex-col gap-8">
      <section>
        <SectionHeading title="Reports" />
        <ul className="flex flex-col">
          {REPORTS.map((r) => (
            <li key={r.href} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-3 hairline-b">
              <Link href={r.href} className="text-line text-ink underline underline-offset-4">
                {r.title}
              </Link>
              <span className="text-caption text-ink-2">{r.detail}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
