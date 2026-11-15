import { sortTaxes, taxRows, type TaxAmountLike } from "./tax";

/** One label/amount row of a report block. Amounts are the register's, never worked out here. */
export type ReportRow = { key: string; label: string; amount: number; strong?: boolean; indent?: boolean; signed?: boolean };

/** The sales figures a Z-report (`sales`) or a sales summary (`totals` plus `taxes`) returns. */
export type ReportSales = {
  gross: number;
  discounts: number;
  fees: number;
  taxes: readonly TaxAmountLike[];
  net: number;
  total: number;
  /** Present once the register reports figures before and after refunds. */
  net_before_refunds?: number;
  total_after_refunds?: number;
};

/** The refunds block of the same report; `net`, `fees`, `tax` and `tips` arrive with the before/after figures. */
export type ReportRefunds = { count: number; amount: number; net?: number; fees?: number; tax?: number; tips?: number; taxes?: readonly TaxAmountLike[] };

export type ReportBlocks = {
  /** Gross, discounts, net before refunds, fees, tax, collected: everything as charged. */
  before: ReportRow[];
  /** What was given back: net, fees, tax, then the refunded amount; tips given back are `tipsBack`, outside the amount. */
  refunds: ReportRow[];
  tipsBack: ReportRow | null;
  /** Net sales and what was collected once the refunds are out. */
  after: ReportRow[];
  /** The tax due by component (`tax_due`), when the register reports it; empty otherwise. */
  taxDue: ReportRow[];
};

/**
 * Splits a report's figures into one block per state (before refunds, refunds, after refunds), so a before figure never
 * sits beside an after one. Returns null when the register does not report the split yet (no `net_before_refunds`,
 * `total_after_refunds` or refund breakdown): the caller keeps its single block. Every amount is a field the register
 * returned; nothing is added up or subtracted here.
 */
export function refundBlocks(sales: ReportSales, refunds: ReportRefunds, taxMode: string, taxDue?: readonly TaxAmountLike[]): ReportBlocks | null {
  const { net_before_refunds: netBefore, total_after_refunds: totalAfter } = sales;
  if (netBefore === undefined || totalAfter === undefined || refunds.net === undefined || refunds.fees === undefined || refunds.tax === undefined || refunds.tips === undefined) return null;
  const tax = taxRows(sales.taxes, taxMode);
  const before: ReportRow[] = [
    { key: "gross", label: "Gross (items)", amount: sales.gross },
    { key: "discounts", label: "Discounts", amount: sales.discounts, signed: true },
    { key: "net_before_refunds", label: "Net before refunds", amount: netBefore, strong: true },
    { key: "fees", label: "Fees (before tax)", amount: sales.fees },
    ...tax.before.map((t) => ({ key: t.key, label: t.label, amount: t.amount })),
    { key: "total", label: "Collected", amount: sales.total, strong: true },
    ...tax.after.map((t) => ({ key: t.key, label: t.label, amount: t.amount })),
  ];
  const back: ReportRow[] = [
    { key: "refunds.net", label: "Net refunded", amount: refunds.net },
    { key: "refunds.fees", label: "Fees refunded", amount: refunds.fees },
    { key: "refunds.tax", label: "Tax refunded", amount: refunds.tax },
    // Every block lists rates in the one order (lowest first): the refund and tax-due blocks came in the register's (F notes).
    ...sortTaxes(refunds.taxes ?? []).map((t, i) => ({ key: `refunds.tax:${i}:${t.name}`, label: t.name, amount: t.amount, indent: true })),
    { key: "refunds.amount", label: refunds.count === 1 ? "Refunded (1 refund)" : `Refunded (${refunds.count} refunds)`, amount: refunds.amount, strong: true },
  ];
  return {
    before,
    refunds: back,
    tipsBack: { key: "refunds.tips", label: "Tips given back", amount: refunds.tips },
    after: [
      { key: "net", label: "Net sales", amount: sales.net, strong: true },
      { key: "total_after_refunds", label: "Collected after refunds", amount: totalAfter, strong: true },
    ],
    // A name the register reports at more than one rate (a refund at an old rate) carries its rate, so the rows differ.
    taxDue: sortTaxes(taxDue ?? []).map((t, i, all) => ({ key: `tax_due:${i}:${t.name}`, label: all.some((o) => o !== t && o.name === t.name) ? `${t.name} (${t.bps / 100}%) due` : `${t.name} due`, amount: t.amount })),
  };
}

/** How many more units of a line can be refunded from a bill: its quantity less the units already refunded. */
export function refundableQuantity(quantity: number, refunded: number | undefined): number {
  return Math.max(0, quantity - (refunded ?? 0));
}
