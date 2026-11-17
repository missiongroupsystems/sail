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
  /** The fees as charged (their tax included with tax in prices), so gross + discounts + fees as charged = total. */
  fees_charged?: number;
};

/** The refunds block of the same report; `net`, `fees`, `tax` and `tips` arrive with the before/after figures. */
export type ReportRefunds = { count: number; amount: number; net?: number; fees?: number; tax?: number; tips?: number; taxes?: readonly TaxAmountLike[] };

export type ReportBlocks = {
  /**
   * Everything as charged, in rows that add up as written. Tax added on top: gross, discounts, net before refunds, fees,
   * each tax, collected. Tax in prices: gross, discounts, fees as charged, collected, then what collected is made of
   * (net before refunds, fees before tax, each tax), indented.
   */
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
  // With tax in prices the tax is inside what was charged: Collected follows from gross, discounts and fees, and the tax
  // and net are shown as what Collected is made of. Without the fees as charged (an older stored report), as before.
  const inclusive = taxMode === "inclusive" && sales.fees_charged !== undefined;
  const before: ReportRow[] = inclusive
    ? [
        { key: "gross", label: "Gross (items)", amount: sales.gross },
        { key: "discounts", label: "Discounts", amount: sales.discounts, signed: true },
        { key: "fees_charged", label: "Fees", amount: sales.fees_charged! },
        { key: "total", label: "Collected", amount: sales.total, strong: true },
        { key: "net_before_refunds", label: "Of which net before refunds", amount: netBefore, indent: true },
        ...(sales.fees ? [{ key: "fees", label: "Of which fees before tax", amount: sales.fees, indent: true }] : []),
        ...sortTaxes(sales.taxes).map((t, i) => ({ key: `tax:${i}:${t.name}`, label: `Of which ${t.name}`, amount: t.amount, indent: true })),
      ]
    : [
        { key: "gross", label: "Gross (items)", amount: sales.gross },
        { key: "discounts", label: "Discounts", amount: sales.discounts, signed: true },
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

/**
 * A Z-report tender row as the register returns it; `refunds`, `reversed` and `net` arrive with the per-tender figures,
 * `terminal` (the tender sends payments to a card terminal) after review 4.
 */
export type ReportTender = { tender_type_id: string; tender: string; is_cash: boolean; terminal?: boolean; count: number; amount: number; rounding: number; tips: number; refunds?: number; reversed?: number; net?: number };

/**
 * One tender's rows: what was applied, then tips, rounding and refunds on it, and its net; only a card terminal's net is
 * "as the terminal shows". A payment taken and reversed is counted in none of these: `reversedRows` names it apart.
 * Every amount is the register's.
 */
export function tenderRows(t: ReportTender): ReportRow[] {
  const k = t.tender_type_id;
  const extras: ReportRow[] = [
    ...(t.tips ? [{ key: `${k}:tips`, label: "Tips", amount: t.tips, indent: true }] : []),
    ...(t.rounding ? [{ key: `${k}:rounding`, label: "Cash rounding", amount: t.rounding, indent: true, signed: true }] : []),
    ...(t.refunds ? [{ key: `${k}:refunds`, label: "Refunded", amount: -t.refunds, indent: true, signed: true }] : []),
  ];
  const net = t.net !== undefined && extras.length ? [{ key: `${k}:net`, label: (t.terminal ?? !t.is_cash) ? `${t.tender} net, as the terminal shows` : `${t.tender} net`, amount: t.net, strong: true }] : [];
  return [{ key: k, label: t.count ? `${t.tender} (${t.count})` : t.tender, amount: t.amount, strong: !extras.length }, ...extras, ...net];
}

/**
 * Payments taken and then given back (a void, or a reopen), one row per tender, for a block of their own below the
 * tenders: they are in no figure above, so they are not set under a tender's net as if part of it (review 4, T3).
 */
export function reversedRows(tenders: readonly ReportTender[]): ReportRow[] {
  return tenders.filter((t) => t.reversed).map((t) => ({ key: `${t.tender_type_id}:reversed`, label: `${t.tender} taken and reversed`, amount: t.reversed! }));
}

/** Whether a card terminal's tender shows its own net row, so the hint to compare it with the terminal has a line to point at. */
export function showsCardNet(tenders: readonly ReportTender[]): boolean {
  // A report stored before `terminal` existed keeps its old wording: every card net was compared with a terminal.
  return tenders.some((t) => (t.terminal ?? !t.is_cash) && tenderRows(t).some((r) => r.key === `${t.tender_type_id}:net`));
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
