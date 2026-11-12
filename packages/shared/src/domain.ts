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

/** Business date as YYYY-MM-DD. */
export const BusinessDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
