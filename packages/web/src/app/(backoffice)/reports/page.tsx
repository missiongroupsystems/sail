import { SectionHeading } from "@sail/ui";
import Link from "next/link";

/** Reports (design 3.2, 4.10): the Z-report and shifts are live; the rest arrives in a later phase. Never a gap or a 404. */
export default function ReportsIndex() {
  return (
    <div className="flex max-w-[720px] flex-col gap-8">
      <section>
        <SectionHeading title="Available now" />
        <ul className="flex flex-col">
          <li className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-3 hairline-b">
            <Link href="/reports/z-report" className="text-line text-ink underline underline-offset-4">
              Z-report
            </Link>
            <span className="text-caption text-ink-2">Sales, tenders, cash, voids and refunds for an outlet, date and station. Close the business day from here.</span>
          </li>
          <li className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-3 hairline-b">
            <Link href="/reports/shifts" className="text-line text-ink underline underline-offset-4">
              Shifts
            </Link>
            <span className="text-caption text-ink-2">Open and closed shifts with expected, counted and variance, and each shift's stored summary.</span>
          </li>
        </ul>
      </section>
      <section>
        <SectionHeading title="Later" />
        <p className="pt-3 text-ink-2">Sales by item, hour and outlet, print health, and exports arrive in a later phase.</p>
      </section>
    </div>
  );
}
