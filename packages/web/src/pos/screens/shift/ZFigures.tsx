"use client";

import { cx, refundBlocks, Skeleton, taxRows, useLocale, type ReportRow } from "@sail/ui";
import { toApiError } from "@/lib/api";
import { useMerchant } from "../../hooks/queries";
import { ORDER_TYPE_LABEL } from "../../lib/format";
import type { OrderType, ZReport, ZReportWithheld } from "../../api/types";
import { Row } from "./ShiftHome";

/**
 * The Z-report's figures, every one from the register: sales, tenders, cash, and orders with voids and refunds. Two
 * columns of panels on the Z-report tab; under the shift (`title`), one panel with the groups in columns, headed
 * "Z-report · figures so far".
 */
export function ZFigures({ report, title }: { report: { data?: ZReport | ZReportWithheld; isError: boolean; error: unknown }; title?: string }) {
  const { money } = useLocale();
  // While a drawer is open the register leaves the money out for a role that may count it (a blind count, S-9).
  const withheld = report.data && "withheld" in report.data ? report.data : null;
  const r = report.data && !("withheld" in report.data) ? report.data : undefined;
  const taxMode = useMerchant().data?.settings.tax_mode ?? "exclusive";
  // A merchant without tips sees no tips row, unless a tip was taken anyway (F notes).
  const tipsOn = Boolean(useMerchant().data?.settings.tips_enabled);
  const tax = taxRows(r?.sales.taxes ?? [], taxMode);
  // One basis per block, as the back office's Z-report: as charged, what was refunded, and after refunds (R new 2).
  const blocks = r ? refundBlocks(r.sales, r.refunds, taxMode, r.tax_due) : null;
  const adjustments = r?.adjustments.length ? (
    <dl className="mt-2 pt-2 border-t border-rule">
      {r.adjustments.map((a) => (
        <Row key={a.rule_key} label={`${a.name} · ${a.count}`} cents={a.kind === "discount" ? -Math.abs(a.total) : a.total} />
      ))}
    </dl>
  ) : null;
  const rows = (list: ReportRow[]) => list.map((x) => <Row key={x.key} label={x.label} cents={x.amount} strong={x.strong} indent={x.indent} />);
  // Terminal tenders are compared one by one; the register does not return a combined figure and the iPad never adds one up.
  const nonCash = r ? r.tenders.filter((t) => !t.is_cash) : [];
  const one = Boolean(title);
  // In the one panel each group is a column under a small grey heading; on the tab each is its own panel.
  const group = one ? "min-w-0" : "rounded-panel border border-rule bg-surface px-5 py-4";
  const head = one ? "mb-1 text-caption font-medium text-ink-2" : "-mx-5 mb-2 border-b border-rule px-5 pb-3 font-heading text-[16px] font-semibold text-ink";
  const figures = (
    <>
      {!r && report.isError ? (
        // A refusal (a Server may not read the Z-report) or a failed read says why instead of loading for ever.
        <p role="alert" className="rounded-panel border border-rule bg-surface px-5 py-4 text-body text-ink">
          {toApiError(report.error).message.replace(/([^.!?])$/, "$1.")}
          {toApiError(report.error).remedy ? <span className="text-ink-2"> {toApiError(report.error).remedy}</span> : null}
        </p>
      ) : withheld ? (
        <div className={one ? "px-5 py-4" : "rounded-panel border border-rule bg-surface px-5 py-4"}>
          <p className="text-body text-ink">The money figures are hidden while {withheld.cash.open_shifts.count === 1 ? "a shift is" : `${withheld.cash.open_shifts.count} shifts are`} open, so the drawer count stays blind. They show once {withheld.cash.open_shifts.count === 1 ? "it is" : "they are"} closed.</p>
          <p className="pt-1 text-caption text-ink-2">
            Float in the open {withheld.cash.open_shifts.count === 1 ? "drawer" : "drawers"} {money(withheld.cash.open_shifts.float)} · {withheld.orders.count} {withheld.orders.count === 1 ? "order" : "orders"} completed{withheld.orders.open_count ? ` · ${withheld.orders.open_count} open` : ""}
          </p>
        </div>
      ) : !r ? (
        <Skeleton lines={6} />
      ) : (
        <div className={cx("grid", one ? "grid-cols-3 gap-x-8 gap-y-5 px-5 py-4 max-[1150px]:grid-cols-2" : "grid-cols-2 gap-4")}>
          {blocks ? (
            <>
              <section className={group}>
                <h3 className={head}>Sales</h3>
                <dl>{rows(blocks.before)}</dl>
                {adjustments}
              </section>
              <section className={group}>
                <h3 className={head}>{`Refunds · ${r.refunds.count}`}</h3>
                <dl>
                  {rows(blocks.refunds)}
                  {blocks.tipsBack && (tipsOn || blocks.tipsBack.amount) ? rows([blocks.tipsBack]) : null}
                </dl>
              </section>
              <section className={group}>
                <h3 className={head}>After refunds</h3>
                <dl>
                  {rows(blocks.after)}
                  {rows(blocks.taxDue)}
                </dl>
              </section>
            </>
          ) : (
            <section className={group}>
              <h3 className={head}>Sales</h3>
              <dl>
                <Row label="Gross" cents={r.sales.gross} />
                <Row label="Discounts" cents={-Math.abs(r.sales.discounts)} />
                <Row label="Refunds (before tax)" cents={-Math.abs(r.sales.refunds)} />
                <Row label="Net sales" cents={r.sales.net} strong />
                <Row label="Service and fees (before tax)" cents={r.sales.fees} />
                {tax.before.map((t) => (
                  <Row key={t.key} label={t.label} cents={t.amount} />
                ))}
                <Row label="Collected" cents={r.sales.total} strong />
                {tax.after.map((t) => (
                  <Row key={t.key} label={t.label} cents={t.amount} />
                ))}
              </dl>
              {adjustments}
            </section>
          )}

          <section className={group}>
            <h3 className={head}>Tenders</h3>
            <dl>
              {r.tenders.map((t) => (
                <Row key={t.tender_type_id} label={`${t.tender} · ${t.count}${t.tips ? ` · tips ${money(t.tips)}` : ""}`} cents={t.amount} />
              ))}
              {r.tenders.length === 0 ? <p className="py-2 text-body text-ink-2">No payments yet.</p> : null}
            </dl>
            {nonCash.length ? <p className="pt-2 text-caption text-ink-2">Compare each card and terminal figure with the terminal&rsquo;s end-of-day total.</p> : null}
          </section>

          <section className={group}>
            <h3 className={head}>Cash</h3>
            <dl>
              <Row label="Float" cents={r.cash.float} />
              <Row label="Cash payments" cents={r.cash.cash_payments} />
              <Row label="Cash rounding" cents={r.cash.rounding} />
              {tipsOn || r.cash.tips ? <Row label="Cash tips" cents={r.cash.tips} /> : null}
              <Row label="Cash refunds" cents={-r.cash.refunds} />
              <Row label="Expected" cents={r.cash.expected} strong />
              {r.cash.counted != null ? <Row label="Counted" cents={r.cash.counted} strong /> : null}
              {r.cash.variance != null ? <Row label="Variance" cents={r.cash.variance} strong tone={r.cash.variance === 0 ? "paid" : "alert"} /> : <p className="pt-2 text-caption text-ink-2">Counted and variance appear once the shift is closed.</p>}
            </dl>
            {/* The POS never shows an open drawer's expected cash, whoever is signed in: they may be the one to count it (S-9). */}
            {r.cash.open_shifts?.count ? (
              <p className="pt-2 text-caption text-ink-2">
                Closed shifts only. {r.cash.open_shifts.count === 1 ? "1 shift is" : `${r.cash.open_shifts.count} shifts are`} still open: float {money(r.cash.open_shifts.float)}.
              </p>
            ) : null}
          </section>

          <section className={group}>
            <h3 className={head}>Orders, voids and refunds</h3>
            <dl>
              <div className="flex min-h-8 items-center justify-between gap-3">
                <dt className="text-body text-ink-2">Orders</dt>
                <dd className="text-body text-ink tabular">
                  {r.orders.count} · {r.orders.covers} covers{r.orders.open_count ? ` · ${r.orders.open_count} open` : ""}
                </dd>
              </div>
              {Object.entries(r.orders.by_type).map(([type, n]) => (
                <div key={type} className="flex min-h-7 items-center justify-between gap-3">
                  <dt className="pl-3 text-caption text-ink-2">{ORDER_TYPE_LABEL[type as OrderType] ?? type}</dt>
                  <dd className="text-caption text-ink-2 tabular">{n}</dd>
                </div>
              ))}
              <Row label={`Voids · ${r.voids.count} (${r.voids.quantity} ${r.voids.quantity === 1 ? "item" : "items"})`} cents={r.voids.value} />
              <Row label={`Refunds · ${r.refunds.count}`} cents={-r.refunds.amount} />
            </dl>
          </section>
        </div>
      )}
    </>
  );
  if (!one) return figures;
  return (
    <section aria-label={title} className="overflow-hidden rounded-panel border border-rule bg-surface">
      <h2 className="border-b border-rule px-5 py-3.5 font-heading text-[16px] font-semibold text-ink">{title}</h2>
      {figures}
    </section>
  );
}

