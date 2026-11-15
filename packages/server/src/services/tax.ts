import { and, eq, isNull, or } from "drizzle-orm";
import type { OrderType, PricingRule, TaxMode, TaxRate, TaxRounding } from "@sail/shared";
import { db } from "../db/client.js";
import { merchantSettings, taxClasses, taxRates } from "../db/schema/index.js";
import { AppError } from "../lib/errors.js";

/**
 * The tax table the pricing engine resolves rates from: every rate of every
 * live tax class, limited to the rows that can apply at one outlet. Orders
 * store this snapshot when they open (with the merchant's tax mode and
 * rounding), so a later rate change never re-prices an open order.
 */
export async function taxRatesFor(merchantId: string, outletId: string): Promise<TaxRate[]> {
  const rows = await db()
    .select({ classId: taxRates.taxClassId, outletId: taxRates.outletId, orderType: taxRates.orderType, components: taxRates.components })
    .from(taxRates)
    .innerJoin(taxClasses, eq(taxClasses.id, taxRates.taxClassId))
    .where(and(eq(taxRates.merchantId, merchantId), isNull(taxClasses.archivedAt), or(isNull(taxRates.outletId), eq(taxRates.outletId, outletId))))
    .orderBy(taxRates.taxClassId, taxRates.createdAt);
  return rows.map((r) => ({ tax_class_id: r.classId, outlet_id: r.outletId, order_type: r.orderType as OrderType | null, components: r.components }));
}

export type OrderTaxSettings = { taxMode: TaxMode; taxRounding: TaxRounding; taxRates: TaxRate[] };

/** The merchant's tax mode and rounding, and the rates that can apply at the outlet, for a new order. */
export async function orderTaxSettings(merchantId: string, outletId: string): Promise<OrderTaxSettings> {
  const [[s], rates] = await Promise.all([
    db().select({ taxMode: merchantSettings.taxMode, taxRounding: merchantSettings.taxRounding }).from(merchantSettings).where(eq(merchantSettings.merchantId, merchantId)).limit(1),
    taxRatesFor(merchantId, outletId),
  ]);
  if (!s) throw AppError.notFound("merchant settings");
  return { taxMode: s.taxMode, taxRounding: s.taxRounding, taxRates: rates };
}

/**
 * An order's tax table extended to every class it now uses. A class the order
 * did not have when it opened (a product moved to a new class, a new fee taxed
 * at one) is added with its current rates; classes already in the table keep
 * the rates the order opened with.
 */
export async function orderTaxRates(order: { merchantId: string; outletId: string; taxRates: TaxRate[] }, classIds: Iterable<string>): Promise<TaxRate[]> {
  const have = new Set(order.taxRates.map((r) => r.tax_class_id));
  const missing = new Set([...classIds].filter((id) => !have.has(id)));
  if (missing.size === 0) return order.taxRates;
  const added = (await taxRatesFor(order.merchantId, order.outletId)).filter((r) => missing.has(r.tax_class_id));
  return [...order.taxRates, ...added];
}

/** Every tax class the lines and fees of an order can be taxed at. */
export function usedTaxClasses(lines: readonly { taxClassId: string }[], rules: readonly PricingRule[]): string[] {
  return [...lines.map((l) => l.taxClassId), ...rules.flatMap((r) => (r.kind === "fee" && r.tax_class_id ? [r.tax_class_id] : []))];
}

/** The merchant's default tax class: what a product with no class of its own is taxed at. */
export async function defaultTaxClassId(merchantId: string): Promise<string> {
  const [row] = await db().select({ id: taxClasses.id }).from(taxClasses).where(and(eq(taxClasses.merchantId, merchantId), eq(taxClasses.isDefault, true))).limit(1);
  if (!row) throw AppError.invariant("no_default_tax_class", "This merchant has no default tax class", "Create a tax class and make it the default.");
  return row.id;
}

/** A tax class id the caller may use (a live class of this merchant), or a validation error naming the field. */
export async function assertTaxClass(merchantId: string, id: string, field: string): Promise<void> {
  const [row] = await db().select({ id: taxClasses.id }).from(taxClasses).where(and(eq(taxClasses.id, id), eq(taxClasses.merchantId, merchantId), isNull(taxClasses.archivedAt))).limit(1);
  if (!row) throw AppError.validation(`${field} is not a tax class of this merchant`, { remedy: "Pick a class from tax_classes.list.", details: { [field]: id } });
}
