"use client";

import { DescriptionList, Money, SectionHeading, Stat, taxRows, useLocale } from "@sail/ui";
import { useSession } from "@/lib/session-context";
import { label, ORDER_TYPE_LABEL, REPORT_CLASS_LABEL } from "./labels";
import { plural, type ZReport } from "./register";

/**
 * The Z-report as the register computed it (services/shifts.ts): figures first,
 * then tenders, cash, adjustments, voids and refunds. Used by the Z-report page
 * and the stored summary on a closed shift. Nothing here is computed.
 */
export function ZReportBody({ report, stationName }: { report: ZReport; stationName?: (id: string | null) => string }) {
  const { stamp } = useLocale();
  const r = report;
  const tax = taxRows(r.sales.taxes, useSession().merchant.settings.tax_mode);
  const types = Object.entries(r.orders.by_type);
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap gap-x-10 gap-y-4">
        <Stat label="Net sales" value={<Money cents={r.sales.net} size="title" />} hint={plural(r.orders.count, "completed order")} />
        <Stat label="Covers" value={r.orders.covers} hint={r.orders.open_count ? `${r.orders.open_count} still open` : undefined} />
        <Stat label="Tax" value={<Money cents={r.sales.tax} size="heading" />} />
        <Stat label="Discounts" value={<Money cents={r.sales.discounts} size="heading" />} />
        <Stat label="Fees" value={<Money cents={r.sales.fees} size="heading" />} />
        <Stat label="Refunds" value={<Money cents={r.refunds.amount} size="heading" />} hint={plural(r.refunds.count, "refund")} tone={r.refunds.amount ? "alert" : "default"} />
      </div>

      <div className="grid gap-8 lg:grid-cols-2">
        <section>
          <SectionHeading title="Sales" aside={types.length ? types.map(([t, n]) => `${label(ORDER_TYPE_LABEL, t)} ${n}`).join(" · ") : undefined} />
          <DescriptionList
            className="mt-1"
            items={[
              { term: "Gross (items)", detail: <Money cents={r.sales.gross} />, numeric: true },
              { term: "Discounts", detail: <Money cents={-r.sales.discounts} />, numeric: true },
              { term: "Refunds (before tax)", detail: <Money cents={-r.sales.refunds} />, numeric: true },
              { term: <span className="text-ink">Net sales</span>, detail: <Money cents={r.sales.net} size="heading" />, numeric: true },
              { term: "Fees (before tax)", detail: <Money cents={r.sales.fees} />, numeric: true },
              ...tax.before.map((t) => ({ term: t.label, detail: <Money cents={t.amount} />, numeric: true })),
              { term: <span className="text-ink">Collected</span>, detail: <Money cents={r.sales.total} />, numeric: true },
              ...tax.after.map((t) => ({ term: t.label, detail: <Money cents={t.amount} />, numeric: true })),
            ]}
          />
        </section>

        <section>
          <SectionHeading title="Tenders" aside={r.tenders.length ? plural(r.tenders.reduce((n, t) => n + t.count, 0), "payment") : undefined} />
          {r.tenders.length === 0 ? (
            <p className="mt-2 text-ink-2">No payments on this day.</p>
          ) : (
            <table className="mt-1 w-full text-body">
              <thead>
                <tr className="text-caption text-ink-2">
                  <th className="py-1 text-left font-medium">Tender</th>
                  <th className="py-1 text-right font-medium">Count</th>
                  <th className="py-1 text-right font-medium">Amount</th>
                  <th className="py-1 text-right font-medium">Rounding</th>
                  <th className="py-1 text-right font-medium">Tips</th>
                </tr>
              </thead>
              <tbody>
                {r.tenders.map((t) => (
                  <tr key={t.tender_type_id} className="hairline-t">
                    <td className="py-1.5 text-ink">
                      {t.tender}
                      {t.is_cash ? <span className="text-caption text-ink-2"> · cash</span> : null}
                    </td>
                    <td className="py-1.5 text-right tabular">{t.count}</td>
                    <td className="py-1.5 text-right tabular">
                      <Money cents={t.amount} />
                    </td>
                    <td className="py-1.5 text-right tabular text-ink-2">{t.rounding ? <Money cents={t.rounding} signed /> : "—"}</td>
                    <td className="py-1.5 text-right tabular text-ink-2">{t.tips ? <Money cents={t.tips} /> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {r.tenders.some((t) => !t.is_cash) ? <p className="mt-2 text-caption text-ink-2">Compare the card total with the terminal's end-of-day total.</p> : null}
        </section>

        <section>
          <SectionHeading title="Cash" />
          <DescriptionList
            className="mt-1"
            items={[
              { term: "Float", detail: <Money cents={r.cash.float} />, numeric: true },
              { term: "Cash payments", detail: <Money cents={r.cash.cash_payments} />, numeric: true },
              { term: "Rounding", detail: <Money cents={r.cash.rounding} signed />, numeric: true },
              { term: "Cash refunds", detail: <Money cents={-r.cash.refunds} />, numeric: true },
              { term: <span className="text-ink">Expected in drawer</span>, detail: <Money cents={r.cash.expected} size="heading" />, numeric: true },
              { term: "Counted", detail: r.cash.counted === null ? <span className="text-ink-2">Not counted yet</span> : <Money cents={r.cash.counted} />, numeric: true },
              {
                term: "Variance",
                detail: r.cash.variance === null ? <span className="text-ink-2">—</span> : <Money cents={r.cash.variance} signed className={r.cash.variance !== 0 ? "text-status-alert" : "text-status-paid"} />,
                numeric: true,
              },
            ]}
          />
        </section>

        <section>
          <SectionHeading title="Adjustments" aside={r.adjustments.length ? `${r.adjustments.length}` : undefined} />
          {r.adjustments.length === 0 ? (
            <p className="mt-2 text-ink-2">No fees or discounts applied.</p>
          ) : (
            <ul className="mt-1 flex flex-col">
              {r.adjustments.map((a) => (
                <li key={`${a.rule_key}-${a.name}`} className="flex flex-wrap items-baseline justify-between gap-x-4 py-1.5 hairline-b">
                  <span className="text-ink">
                    {a.name}
                    <span className="text-caption text-ink-2">
                      {" "}
                      · {label(REPORT_CLASS_LABEL, a.report_class)} · {plural(a.count, "order")}
                    </span>
                  </span>
                  <Money cents={a.kind === "discount" ? -Math.abs(a.total) : a.total} />
                </li>
              ))}
            </ul>
          )}
          <DescriptionList className="mt-4" items={[{ term: "Voided items", detail: `${r.voids.quantity} on ${plural(r.voids.count, "line")}`, numeric: true }, { term: "Voided value", detail: <Money cents={r.voids.value} />, numeric: true }]} />
        </section>
      </div>

      <p className="text-caption text-ink-2 tabular">
        Business day {r.scope.business_date}
        {r.scope.station_id ? ` · ${stationName ? stationName(r.scope.station_id) : "one station"}` : " · all stations"} · generated {stamp(r.generated_at)}
      </p>
    </div>
  );
}
