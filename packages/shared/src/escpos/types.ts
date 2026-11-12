import { z } from "zod";
import { CentsSchema, OrderTypeSchema, TaxModeSchema } from "../domain.js";
import { TaxAmountSchema } from "../pricing/schemas.js";

/**
 * Data contracts for the ESC/POS templates (scope doc 4.7).
 *
 * The server builds these from the order, check and payment records and
 * stores them on the print job. They are printer-agnostic: every amount is an
 * integer number of minor units of the document's currency, times are ISO strings, and nothing here knows
 * about columns or control bytes. The renderer never does arithmetic: the
 * figures are printed exactly as the server supplies them.
 *
 * Sign convention for bills: amounts are signed as they appear on the
 * document. Fees are positive, discounts are negative, and a refund receipt
 * carries the reversed (negative) figures of what it refunds.
 */

export const PAPER_WIDTHS = ["80mm", "58mm"] as const;
export type PaperWidth = (typeof PAPER_WIDTHS)[number];
export const PaperWidthSchema = z.enum(PAPER_WIDTHS);

export const PrinterProfileSchema = z.object({
  /** 80 mm paper prints 48 columns at the normal font, 58 mm prints 32. */
  width: PaperWidthSchema,
  /**
   * True when the printer has a CJK code page (Kanji mode). False renders any
   * line containing CJK text as a raster image instead (see encoder.ts).
   */
  code_page_cjk: z.boolean(),
  /** Partial-cut at the end of the job. */
  cut: z.boolean(),
  /** Sound the buzzer at the end of the job (ESC B; not every printer supports it). */
  beep: z.boolean().optional(),
});
export type PrinterProfile = z.infer<typeof PrinterProfileSchema>;

const IsoDateTime = z.iso.datetime({ offset: true });

export const CustomerRefSchema = z.object({
  name: z.string().optional(),
  mobile: z.string().optional(),
});
export type CustomerRef = z.infer<typeof CustomerRefSchema>;

export const TicketHeaderSchema = z.object({
  outlet_name: z.string().min(1),
  brand_name: z.string().min(1),
  /** Display order number, for example "P-0042" or "QR-0007". */
  order_no: z.string().min(1),
  order_type: OrderTypeSchema,
  table_name: z.string().optional(),
  pax: z.number().int().min(0).optional(),
  customer_ref: CustomerRefSchema.optional(),
  server_name: z.string().optional(),
  station_name: z.string().optional(),
  /** When the job was created, ISO 8601 with offset or Z. */
  printed_at: IsoDateTime,
  job_id: z.string().min(1),
  round_no: z.number().int().min(1).optional(),
  ready_by: IsoDateTime.optional(),
  delivery_address: z.string().optional(),
  delivery_notes: z.string().optional(),
  /** IANA time zone used to print clock times (the outlet's, else the merchant's). */
  time_zone: z.string().min(1),
  /** BCP 47 locale for dates, times and money, for example "en-GB" or "de-DE". */
  locale: z.string().min(1),
});
export type TicketHeader = z.infer<typeof TicketHeaderSchema>;

export const KITCHEN_TICKET_KINDS = ["kitchen", "void", "reprint"] as const;
export type KitchenTicketKind = (typeof KITCHEN_TICKET_KINDS)[number];
export const KitchenTicketKindSchema = z.enum(KITCHEN_TICKET_KINDS);

export const KitchenLineSchema = z.object({
  quantity: z.number().int().min(1),
  /** The kitchen name of the product (may differ from the menu name). */
  name: z.string().min(1),
  modifiers: z.array(z.string()),
  notes: z.string().optional(),
  seat_no: z.number().int().min(1).optional(),
});
export type KitchenLine = z.infer<typeof KitchenLineSchema>;

export const KitchenTicketSchema = z.object({
  header: TicketHeaderSchema,
  kind: KitchenTicketKindSchema,
  lines: z.array(KitchenLineSchema).min(1),
  /** Banner text for void and reprint tickets. Defaults to "VOID" / "REPRINT" by kind. */
  banner: z.string().optional(),
  copy_no: z.number().int().min(1).optional(),
  copies: z.number().int().min(1).optional(),
});
export type KitchenTicket = z.infer<typeof KitchenTicketSchema>;

export const BILL_KINDS = ["prebill", "receipt", "refund_receipt"] as const;
export type BillKind = (typeof BILL_KINDS)[number];
export const BillKindSchema = z.enum(BILL_KINDS);

export const BillModifierSchema = z.object({
  name: z.string().min(1),
  /** Price of the modifier for the line (already multiplied by quantity), 0 when free. */
  price: CentsSchema,
});
export type BillModifier = z.infer<typeof BillModifierSchema>;

export const BillLineSchema = z.object({
  quantity: z.number().int(),
  name: z.string().min(1),
  unit_price: CentsSchema,
  /** Line amount as printed (quantity x unit price plus modifiers, or this check's share of it). */
  amount: CentsSchema,
  modifiers: z.array(BillModifierSchema),
  seat_no: z.number().int().min(1).optional(),
  /** Share of a line split across checks, for example "1/3". */
  share: z.string().optional(),
});
export type BillLine = z.infer<typeof BillLineSchema>;

export const BillAdjustmentSchema = z.object({
  /** The pricing rule's display name, for example "Service charge 10%". */
  name: z.string().min(1),
  /** Signed as printed: fees positive, discounts negative. */
  amount: CentsSchema,
  kind: z.enum(["fee", "discount"]),
});
export type BillAdjustment = z.infer<typeof BillAdjustmentSchema>;

export const BillTotalsSchema = z.object({
  subtotal: CentsSchema,
  discount_total: CentsSchema,
  fee_total: CentsSchema,
  tax_total: CentsSchema,
  total: CentsSchema,
  tax_mode: TaxModeSchema,
  /** One printed row per tax component, labelled with its name ("VAT 20%", "Sales tax"); empty when every line is exempt. */
  taxes: z.array(TaxAmountSchema),
});
export type BillTotals = z.infer<typeof BillTotalsSchema>;

export const BillPaymentSchema = z.object({
  /** Tender display name as configured, for example "Cash" or "Card". */
  tender: z.string().min(1),
  /** Amount applied to the check. */
  amount: CentsSchema,
  /** Cash rounding applied with this tender (rounded minus exact); printed when non-zero. */
  rounding_cents: CentsSchema.optional(),
  reference: z.string().optional(),
  /** Change handed back; printed when non-zero. */
  change: CentsSchema.optional(),
});
export type BillPayment = z.infer<typeof BillPaymentSchema>;

/** A registration number as printed: the merchant's label and the outlet's value, for example "VAT no." and "GB123456789". */
export const RegistrationSchema = z.object({ label: z.string().min(1), value: z.string().min(1) });
export type Registration = z.infer<typeof RegistrationSchema>;

export const BillDocumentSchema = z.object({
  header: TicketHeaderSchema,
  kind: BillKindSchema,
  /** ISO 4217 code every amount on the document is in. */
  currency: z.string().length(3),
  /** Decimal places of the currency's minor unit (JPY 0, EUR 2, KWD 3), as the register knows it. */
  currency_exponent: z.number().int().min(0),
  /** For example "Bill 1" or "Bill 2 of 3". */
  check_label: z.string().min(1),
  lines: z.array(BillLineSchema),
  adjustments: z.array(BillAdjustmentSchema),
  totals: BillTotalsSchema,
  payments: z.array(BillPaymentSchema).optional(),
  /** Remaining balance; printed as "Balance due" when present. */
  balance: CentsSchema.optional(),
  invoice_no: z.string().optional(),
  credit_note_no: z.string().optional(),
  /** Refund receipts: the check being refunded and the date it was paid (ISO date or datetime). */
  original_check_no: z.string().optional(),
  original_date: z.string().optional(),
  refund_reason: z.string().optional(),
  footer_lines: z.array(z.string()).optional(),
  outlet_phone: z.string().optional(),
  business_registration: RegistrationSchema.optional(),
  tax_registration: RegistrationSchema.optional(),
  digital_receipt_url: z.string().optional(),
});
export type BillDocument = z.infer<typeof BillDocumentSchema>;

export const ServiceSlipSchema = z.object({
  header: TicketHeaderSchema,
  /** The configured request label, for example "Water" or "Call for bill". */
  request_type: z.string().min(1),
  guest_name: z.string().optional(),
});
export type ServiceSlip = z.infer<typeof ServiceSlipSchema>;

/** One payload shape for the print job table: the template name picks the renderer. */
export const PrintJobPayloadSchema = z.discriminatedUnion("template", [
  z.object({ template: z.literal("kitchen_ticket"), data: KitchenTicketSchema }),
  z.object({ template: z.literal("bill"), data: BillDocumentSchema }),
  z.object({ template: z.literal("service_slip"), data: ServiceSlipSchema }),
]);
export type PrintJobPayload = z.infer<typeof PrintJobPayloadSchema>;
