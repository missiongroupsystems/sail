import { z } from "zod";

/** Shared domain enums used across the API, the pricing engine and the UI. */

export const ORDER_TYPES = ["dine_in", "takeaway", "pickup", "delivery"] as const;
export type OrderType = (typeof ORDER_TYPES)[number];
export const OrderTypeSchema = z.enum(ORDER_TYPES);

export const CHANNEL_TYPES = ["pos", "scan_to_order"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];
export const ChannelTypeSchema = z.enum(CHANNEL_TYPES);

export const ORDER_STATUSES = ["open", "fired", "ready", "out_for_delivery", "completed", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const OrderStatusSchema = z.enum(ORDER_STATUSES);

export const LINE_STATUSES = ["pending", "held", "fired", "voided"] as const;
export type LineStatus = (typeof LINE_STATUSES)[number];
export const LineStatusSchema = z.enum(LINE_STATUSES);

export const LINE_SOURCES = ["pos", "guest"] as const;
export type LineSource = (typeof LINE_SOURCES)[number];
export const LineSourceSchema = z.enum(LINE_SOURCES);

export const CHECK_STATUSES = ["open", "paid", "partially_refunded", "refunded"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];
export const CheckStatusSchema = z.enum(CHECK_STATUSES);

export const TAX_MODES = ["inclusive", "exclusive"] as const;
export type TaxMode = (typeof TAX_MODES)[number];
export const TaxModeSchema = z.enum(TAX_MODES);

/**
 * Where tax is rounded. `per_line`: on each line's amount (and each fee amount
 * on a line), the order's tax is the sum of the rounded parts. `per_rate`: once
 * per tax rate across the whole order, then spread back across the lines by
 * largest remainder (EU, US and Japanese invoices).
 */
export const TAX_ROUNDINGS = ["per_line", "per_rate"] as const;
export type TaxRounding = (typeof TAX_ROUNDINGS)[number];
export const TaxRoundingSchema = z.enum(TAX_ROUNDINGS);

export const ORDER_NUMBER_PREFIX: Record<ChannelType, string> = { pos: "P", scan_to_order: "QR" };

export const UuidSchema = z.uuid();
export const CentsSchema = z.number().int().safe();
export const NonNegativeCentsSchema = z.number().int().min(0);

/**
 * The largest amount the register accepts, in minor units: 10^12 (Rp 10,000,000,000.00, or 1,000,000,000,000 VND). It
 * bounds every price, payment and cash amount a request carries and every line and order subtotal. Money columns are
 * bigint and JS numbers are exact to 2^53, so a sum of 9,000 orders at this size is still exact; the engine takes the
 * products it needs (amount × rate) in BigInt.
 */
export const MAX_AMOUNT = 1_000_000_000_000;
/** The most pieces of one note or coin a cash count takes. */
export const MAX_PIECES = 999;
/**
 * The most a drawer can hold in a cash count, a float or a counted close: `MAX_PIECES` of every note and coin the
 * merchant uses. Without denominations the general amount limit applies.
 */
export function drawerCap(denominations: readonly number[]): number {
  return denominations.length ? MAX_PIECES * denominations.reduce((s, d) => s + d, 0) : MAX_AMOUNT;
}
/** A non-negative amount a request may carry: at most `MAX_AMOUNT`, refused with a validation error above it. */
export const AmountSchema = z.number().int().min(0).max(MAX_AMOUNT, `amount is above the largest the register accepts (${MAX_AMOUNT} minor units)`);

/** Business date as YYYY-MM-DD. */
export const BusinessDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
