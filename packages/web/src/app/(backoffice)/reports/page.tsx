import { Icon } from "@sail/ui";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
const REPORTS = [
  { href: "/reports/z-report", title: "Z-report", detail: "Sales, tenders, cash, voids and refunds for an outlet, date and station. Close the business day from here." },
  { href: "/reports/sales", title: "Sales", detail: "Totals, days, tenders and categories for an outlet over a range of business dates." },
  { href: "/reports/items", title: "Items", detail: "What sold, by item, category or staff member, with each one's share of net sales." },
  { href: "/reports/shifts", title: "Shifts", detail: "Open and closed shifts with expected, counted and variance, and each shift's stored summary." },
  { href: "/reports/print-health", title: "Print health", detail: "Jobs, failures, reroutes, reprints and late tickets by printer, with time to print." },
];

/** Reports: every report the register serves, one card each. Never a gap or a 404. */
export default function ReportsIndex() {
  return (
    <section aria-labelledby="reports-list">
      <h2 id="reports-list" className="sr-only">
        Reports
      </h2>
      <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {REPORTS.map((r) => (
          <li key={r.href}>
            <Link
              href={r.href}
              className="press group flex h-full flex-col gap-1.5 rounded-[14px] border border-rule bg-surface px-5 py-4 no-underline outline-none transition-colors duration-[120ms] hover:border-rule-strong hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              <span className="flex items-center justify-between gap-3">
                <span className="font-heading text-[16px] leading-[1.35] font-semibold tracking-[-0.01em] text-ink">{r.title}</span>
                <Icon icon={ChevronRight} size={16} className="text-ink-3 transition-transform duration-[120ms] group-hover:translate-x-0.5" />
              </span>
              <span className="text-[13.5px] leading-5 text-ink-2">{r.detail}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
