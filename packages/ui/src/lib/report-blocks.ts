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
  /** With tax included in prices, the tax inside the items, so gross − discounts − tax in prices = net. */
  tax_in_prices?: number;
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
    // VAT inside the prices comes out before net, so the rows add up as written (as the Items report's column does).
    ...(sales.tax_in_prices ? [{ key: "tax_in_prices", label: "Tax in prices", amount: -sales.tax_in_prices, signed: true }] : []),
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

/** A Z-report tender row as the register returns it; `refunds`, `reversed` and `net` arrive with the per-tender figures. */
export type ReportTender = { tender_type_id: string; tender: string; is_cash: boolean; count: number; amount: number; rounding: number; tips: number; refunds?: number; reversed?: number; net?: number };

/**
 * One tender's rows: what was applied, then tips, rounding and refunds on it, and the net the terminal should show (a
 * payment taken and reversed is named apart, counted nowhere). Every amount is the register's.
 */
export function tenderRows(t: ReportTender): ReportRow[] {
  const k = t.tender_type_id;
  const extras: ReportRow[] = [
    ...(t.tips ? [{ key: `${k}:tips`, label: "Tips", amount: t.tips, indent: true }] : []),
    ...(t.rounding ? [{ key: `${k}:rounding`, label: "Cash rounding", amount: t.rounding, indent: true, signed: true }] : []),
    ...(t.refunds ? [{ key: `${k}:refunds`, label: "Refunded", amount: -t.refunds, indent: true, signed: true }] : []),
  ];
  const net = t.net !== undefined && extras.length ? [{ key: `${k}:net`, label: t.is_cash ? `${t.tender} net` : `${t.tender} net, as the terminal shows`, amount: t.net, strong: true }] : [];
  const reversed = t.reversed ? [{ key: `${k}:reversed`, label: "Reversed, not counted", amount: t.reversed, indent: true }] : [];
  return [{ key: k, label: t.count ? `${t.tender} (${t.count})` : t.tender, amount: t.amount, strong: !extras.length }, ...extras, ...net, ...reversed];
}

/** Whether a card tender shows its own net row, so a hint to compare "each card net" has a line to point at. */
export function showsCardNet(tenders: readonly ReportTender[]): boolean {
  return tenders.some((t) => !t.is_cash && tenderRows(t).some((r) => r.key === `${t.tender_type_id}:net`));
}

/** The Z-report's `reconciliation` block, once the register splits what is held on open orders. */
export type ReportReconciliation = { tenders: number; sales_total: number; paid_on_other_orders: number; paid_elsewhere: number; held_on_open_orders?: number; paid_for_other_orders?: number; beyond_order_totals?: number };

/**
 * How the payments taken come to the completed sales, one plain row each, so "Collected" and the payments read together:
 * payments = collected on completed orders + held on open orders + paid for other orders − paid on another day + taken
 * beyond the orders' totals (owed to guests).
 * Null for a report from before the split, or when there is nothing to explain.
 */
export function reconciliationRows(r: ReportReconciliation | undefined): ReportRow[] | null {
  if (!r || r.held_on_open_orders === undefined || r.paid_for_other_orders === undefined) return null;
  const beyond = r.beyond_order_totals ?? 0;
  if (r.held_on_open_orders === 0 && r.paid_for_other_orders === 0 && r.paid_elsewhere === 0 && beyond === 0) return null;
  return [
    { key: "rec:sales", label: "Collected on completed orders", amount: r.sales_total },
    ...(r.held_on_open_orders ? [{ key: "rec:open", label: "Held on open orders", amount: r.held_on_open_orders, signed: true }] : []),
    ...(r.paid_for_other_orders ? [{ key: "rec:other", label: "For orders of another day or station", amount: r.paid_for_other_orders, signed: true }] : []),
    ...(r.paid_elsewhere ? [{ key: "rec:elsewhere", label: "Paid on another day or station", amount: -r.paid_elsewhere, signed: true }] : []),
    ...(beyond ? [{ key: "rec:beyond", label: "Taken beyond the orders' totals, owed to guests", amount: beyond, signed: true }] : []),
    { key: "rec:tenders", label: "Payments taken", amount: r.tenders, strong: true },
  ];
}
