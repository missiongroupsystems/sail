"use client";

import { BusinessDay, Badge, kindTone, Money, Panel, refundBlocks, taxRows, useLocale, ValueRows, type ReportRow } from "@sail/ui";
import { useSession } from "@/lib/session-context";
import { label, ORDER_TYPE_LABEL, REPORT_CLASS_LABEL } from "./labels";
import { plural, type ZReport } from "./register";

type Tender = ZReport["tenders"][number];

/** A report block's rows as label/value rows; the amounts are the register's. */
export function blockRows(rows: ReportRow[]) {
  return rows.map((r) => ({ key: r.key, label: r.label, value: <Money cents={r.amount} signed={r.signed} />, strong: r.strong, indent: r.indent }));
}

/**
 * The Z-report as the register computed it (services/shifts.ts): figures first,
 * then sales, tenders, cash, adjustments, voids and refunds, each in a panel of label/value rows.
 * Used by the Z-report page and the stored summary on a closed shift. Nothing here is computed.
 */
export function ZReportBody({ report, stationName }: { report: ZReport; stationName?: (id: string | null) => string }) {
  const { stamp } = useLocale();
  const r = report;
  const taxMode = useSession().merchant.settings.tax_mode;
  const tax = taxRows(r.sales.taxes, taxMode);
  const types = Object.entries(r.orders.by_type);
  const blocks = refundBlocks(r.sales, r.refunds, taxMode, r.tax_due);
  const salesAside = types.length ? types.map(([t, n]) => `${label(ORDER_TYPE_LABEL, t)} ${n}`).join(" · ") : undefined;
  const sales = blocks ? (
    <>
      <Panel title="Sales" aside={salesAside}>
        <ValueRows rows={blockRows(blocks.before)} />
        <ValueRows
          className="mt-1.5 border-t border-rule-subtle pt-1.5"
          rows={[
            { label: "Orders completed", value: r.orders.count },
            ...(r.orders.open_count ? [{ label: "Still open", value: r.orders.open_count }] : []),
            { label: "Covers", value: r.orders.covers },
          ]}
        />
      </Panel>
      <Panel title="Refunds" aside={plural(r.refunds.count, "refund")}>
        <ValueRows rows={blockRows(blocks.refunds)} />
        {blocks.tipsBack ? <ValueRows className="mt-1.5 border-t border-rule-subtle pt-1.5" rows={blockRows([blocks.tipsBack])} /> : null}
      </Panel>
      <Panel title="After refunds">
        <ValueRows rows={blockRows(blocks.after)} />
        {blocks.taxDue.length ? <ValueRows className="mt-1.5 border-t border-rule-subtle pt-1.5" rows={blockRows(blocks.taxDue)} /> : null}
      </Panel>
    </>
  ) : (
    <Panel title="Sales" aside={salesAside}>
      <ValueRows
        rows={[
          { label: "Gross (items)", value: <Money cents={r.sales.gross} /> },
          { label: "Discounts", value: <Money cents={-r.sales.discounts} /> },
          { label: "Refunds (before tax)", value: <Money cents={-r.sales.refunds} /> },
          { label: "Net sales", value: <Money cents={r.sales.net} />, strong: true },
          { label: "Fees (before tax)", value: <Money cents={r.sales.fees} /> },
          ...tax.before.map((t) => ({ key: t.key, label: t.label, value: <Money cents={t.amount} /> })),
          { label: "Collected", value: <Money cents={r.sales.total} />, strong: true },
          ...tax.after.map((t) => ({ key: t.key, label: t.label, value: <Money cents={t.amount} /> })),
          { label: "Orders completed", value: r.orders.count },
          ...(r.orders.open_count ? [{ label: "Still open", value: r.orders.open_count }] : []),
          { label: "Covers", value: r.orders.covers },
        ]}
      />
    </Panel>
  );

  // Two columns of panels, sales on the left, payments and the drawer on the right. No tile row:
  // every figure is in a panel once.
  return (
    <div className="flex flex-col gap-6">
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-6">
          {sales}
          <Panel title="Fees and discounts" body="flush" aside={r.adjustments.length ? `${r.adjustments.length}` : undefined}>
            {r.adjustments.length === 0 ? (
              <p className="px-5 pt-4 pb-1 text-ink-2">No fees or discounts applied.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-rule-subtle">
                {r.adjustments.map((a) => (
                  <li key={`${a.rule_key}-${a.name}`} className="flex flex-wrap items-baseline justify-between gap-x-4 px-5 py-2.5">
                    <span className="text-ink">
                      {a.name} <Badge tone={kindTone(a.kind)}>{a.kind}</Badge>
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
            <ValueRows
              className={r.adjustments.length ? "border-t border-rule-subtle px-5 py-3" : "px-5 pt-1 pb-3"}
              rows={[
                { label: "Voided items", value: `${r.voids.quantity} on ${plural(r.voids.count, "line")}` },
                { label: "Voided value", value: <Money cents={r.voids.value} /> },
              ]}
            />
          </Panel>
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          <Panel title="Payments" aside={r.tenders.length ? plural(r.tenders.reduce((n, t) => n + t.count, 0), "payment") : undefined}>
            {r.tenders.length === 0 ? (
              <p className="text-ink-2">No payments on this day.</p>
            ) : (
              <ValueRows
                rows={[
                  ...r.tenders.map((t: Tender) => ({ key: t.tender_type_id, label: `${t.tender}${t.count ? ` (${t.count})` : ""}`, value: <Money cents={t.amount} /> })),
                  ...r.tenders.filter((t: Tender) => t.tips).map((t: Tender) => ({ key: `${t.tender_type_id}:tips`, label: `Tips on ${t.tender}`, value: <Money cents={t.tips} />, indent: true })),
                  ...r.tenders.filter((t: Tender) => t.rounding).map((t: Tender) => ({ key: `${t.tender_type_id}:rounding`, label: `Rounding on ${t.tender}`, value: <Money cents={t.rounding} signed />, indent: true })),
                ]}
              />
            )}
            {r.tenders.some((t) => !t.is_cash) ? <p className="mt-2 text-caption text-ink-2">Compare each card figure with the terminal&rsquo;s end-of-day total.</p> : null}
          </Panel>

          <Panel title="Cash drawer">
            <ValueRows
              rows={[
                { label: "Opening float", value: <Money cents={r.cash.float} /> },
                { label: "Cash payments", value: <Money cents={r.cash.cash_payments} /> },
                { label: "Rounding", value: <Money cents={r.cash.rounding} signed /> },
                { label: "Cash tips", value: <Money cents={r.cash.tips} /> },
                { label: "Cash refunds", value: <Money cents={-r.cash.refunds} /> },
                { label: "Expected in the drawer", value: <Money cents={r.cash.expected} />, strong: true },
                { label: "Counted", value: r.cash.counted === null ? <span className="text-ink-2">Not counted yet</span> : <Money cents={r.cash.counted} /> },
                {
                  label: "Variance",
                  value: r.cash.variance === null ? <span className="text-ink-2">After the count</span> : <Money cents={r.cash.variance} signed className={r.cash.variance !== 0 ? "text-status-alert" : "text-status-paid"} />,
                },
              ]}
            />
          </Panel>
        </div>
      </div>

      <p className="text-caption text-ink-2 tabular">
        Business day <BusinessDay value={r.scope.business_date} />
        {r.scope.station_id ? ` · ${stationName ? stationName(r.scope.station_id) : "one station"}` : " · all stations"} · generated {stamp(r.generated_at)}
      </p>
    </div>
  );
}
