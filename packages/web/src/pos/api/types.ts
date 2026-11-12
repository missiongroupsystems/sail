/**
 * Register payloads the POS reads. The OpenAPI document types the order,
 * floor and menu snapshots as open records (`{[k]: unknown}`), so these mirror
 * the server's own TypeScript types (services/orders.ts, services/menu.ts,
 * routes/orders.ts). Amounts are integer cents and are only ever displayed.
 */

export type Role = "server" | "cashier" | "manager" | "finance" | "admin";
export type OrderType = "dine_in" | "takeaway" | "pickup" | "delivery";
export type OrderStatus = "open" | "fired" | "ready" | "out_for_delivery" | "completed" | "cancelled";
export type LineStatus = "pending" | "held" | "fired" | "voided";
export type AccessLevel = "everyone" | "cashier" | "manager" | "admin";

export type Station = {
  id: string;
  outlet_id: string;
  name: string;
  brand_id: string | null;
  layout_id: string | null;
  pay_before_firing: boolean;
  seats_enabled: boolean;
  home: "floor" | "takeaway";
  receipt_printer_id: string | null;
  text_size: string;
  paired: boolean;
  device_label: string | null;
  archived: boolean;
};

export type Staff = { id: string; name: string; initials: string | null; role: Role };

export type SessionStart = { session_token: string; staff: Staff; station: Station; expires_in_seconds: number };

export type Outlet = {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  hours: Record<string, unknown[][]>;
  service_theme_from: string | null;
};

/** The merchant settings the station reads: currency, zone and locale for every figure, and the cash it counts. */
export type MerchantSettings = {
  tax_mode: "inclusive" | "exclusive";
  currency: string;
  /** Decimal places of the currency's minor unit (JPY 0, EUR 2, KWD 3). */
  currency_exponent: number;
  timezone: string;
  /** BCP 47. */
  locale: string;
  cash_rounding_increment: number | null;
  /** Notes and coins in minor units, largest first; may be empty. */
  cash_denominations: number[];
  /** Closing a shift more than this many minor units out needs a reason. */
  cash_variance_threshold: number;
};
export type Merchant = { id: string; name: string; settings: MerchantSettings };

export type ChannelLink = { id: string; channel: "pos" | "scan_to_order"; outlet_id: string; brand_id: string; menu_id: string; enabled: boolean };

export type CompiledProduct = {
  id: string;
  name: string;
  kitchen_name: string | null;
  sku: string | null;
  description: string | null;
  price: number;
  prices_by_order_type: Partial<Record<OrderType, number>>;
  category_id: string | null;
  parent_category_id: string | null;
  tags: string[];
  has_deposit: boolean;
  tax_class_id: string;
  open_price: boolean;
  modifier_groups: string[];
  available_now: boolean;
  unavailable_reason: string | null;
  sold_out: boolean;
  sold_out_until: string | null;
  cap_remaining: number | null;
};

export type CompiledOption = { product_id: string; name: string; price: number; child_group_id: string | null; is_default: boolean; sort: number };
export type CompiledGroup = { id: string; name: string; min_select: number; max_select: number | null; max_per_modifier: number; options: CompiledOption[] };

export type CompiledMenu = {
  channel_link: { id: string; channel: string; outlet_id: string; brand_id: string; menu_id: string };
  brand: { id: string; name: string; accent_color: string | null };
  outlet: { id: string; name: string; phone: string | null };
  menu: { id: string; name: string; sections: { id: string; name: string; parent_id: string | null; sort: number; available_now: boolean; items: { product_id: string; sort: number }[] }[] };
  products: Record<string, CompiledProduct>;
  modifier_groups: Record<string, CompiledGroup>;
  compiled_at: string;
  version: string;
};

export type ProductTile = { id: string; label: string; color: string; access_level: AccessLevel; kind: "product"; product_id: string };
export type FolderTile = { id: string; label: string; color: string; access_level: AccessLevel; kind: "folder"; tiles: ProductTile[] };
export type LayoutTile = ProductTile | FolderTile;
export type LayoutPage = { id: string; name: string; tiles: LayoutTile[] };
export type Layout = { id: string; brand_id: string; name: string; pages: LayoutPage[]; version: number };

export type TableStatus = "free" | "seated" | "sent" | "bill_requested" | "paid";
export type FloorTable = {
  id: string;
  area_id: string;
  name: string;
  seats: number;
  shape: string;
  x: number;
  y: number;
  w: number;
  h: number;
  status: TableStatus;
  order: { id: string; order_no: string; status: OrderStatus; pax: number | null; opened_at: string; elapsed_seconds: number; total: number; version: number; pending_rounds: number } | null;
  requests_waiting: number;
};
export type FloorSnapshot = {
  outlet_id: string;
  as_of: string;
  areas: { id: string; name: string; sort: number }[];
  tables: FloorTable[];
  open_orders: number;
  other_orders: { id: string; order_no: string; order_type: OrderType; status: OrderStatus; ready_by: string | null; customer_ref: { name?: string; mobile?: string } | null; total: number }[];
};

/** One tax component: `name` is the whole printed label ("VAT 20%"). `taxable` excludes tax in both modes. */
export type TaxBreakdown = { name: string; bps: number; taxable: number; amount: number };
export type TaxAmount = { name: string; bps: number; amount: number };

export type LineAmounts = { base: number; discount: number; net: number; fee: number; tax: number; total: number };
export type SnapshotModifier = { modifier_id: string; product_id: string; name: string; quantity: number; price: number; group_id: string };
export type SnapshotLine = {
  id: string;
  product_id: string;
  name: string;
  kitchen_name: string | null;
  sku: string | null;
  quantity: number;
  unit_price: number;
  open_price: number | null;
  modifiers: SnapshotModifier[];
  notes: string | null;
  seat_no: number | null;
  source: string;
  round_id: string | null;
  status: LineStatus;
  fire_round: number | null;
  fired_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  amounts: LineAmounts;
  /** amounts.tax by component. */
  taxes: TaxBreakdown[];
  tax_class_id: string;
  tags: string[];
  category_id: string | null;
  sort: number;
  added_by: string | null;
  created_at: string;
  /** Client only: the line is on its way to the register and has no amounts yet (design principle 8). */
  optimistic?: boolean;
};
export type SnapshotAdjustment = {
  id: string;
  rule_key: string;
  rule_version: number;
  name: string;
  kind: "fee" | "discount" | string;
  level: string;
  report_class: string;
  /** Fees only: the class the fee is taxed at, null when untaxed. */
  tax_class_id: string | null;
  total: number;
  tax_total: number;
  capped: boolean;
  frozen: boolean;
  manual_application_id: string | null;
  entered_value: number | null;
  applied_by: string | null;
  approved_by: string | null;
  reason: string | null;
  lines: { line_id: string; amount: number; tax_amount: number }[];
};
export type OrderSnapshot = {
  id: string;
  order_no: string;
  outlet_id: string;
  brand_id: string;
  channel_link_id: string;
  channel: string;
  order_type: OrderType;
  status: OrderStatus;
  version: number;
  table_id: string | null;
  pax: number | null;
  customer_id: string | null;
  customer_ref: { name?: string; mobile?: string } | null;
  delivery_address: string | null;
  delivery_notes: string | null;
  ready_by: string | null;
  notes: string | null;
  station_id: string | null;
  opened_by: { id: string | null; name: string | null };
  business_date: string;
  opened_at: string;
  first_fired_at: string | null;
  ready_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  bill_requested_at: string | null;
  round_count: number;
  pricing_status: "live" | "frozen";
  totals: { tax_mode: "inclusive" | "exclusive"; tax_rounding: "per_line" | "per_rate"; subtotal: number; discount_total: number; fee_total: number; tax_total: number; taxes: TaxBreakdown[]; total: number };
  lines: SnapshotLine[];
  adjustments: SnapshotAdjustment[];
  manual_applications: { id: string; rule_key: string; entered_value: number | null; line_ids: string[] | null; applied_by: string | null; reason: string | null }[];
  checks: CheckSnapshot[];
  paid_total: number;
  balance: number;
};

export type MutationEvent = { id: string; seq: number; type: string; occurredAt: string; businessDate: string };
export type MutationResult = { data: OrderSnapshot; events: MutationEvent[]; warnings: string[] };

export type OutletEvent = {
  id: string;
  seq: number;
  outlet_id: string | null;
  business_date: string;
  occurred_at: string;
  type: string;
  aggregate: { kind: string; id: string; version: number };
  operation_id: string;
  actor: { principal_type?: string; principal_id?: string; role?: string | null; name?: string; station_id?: string };
  approval: Record<string, unknown> | null;
  reason: Record<string, unknown> | null;
  causation_id: string | null;
  correlation_id: string;
  payload?: unknown;
};
export type EventsPage = { data: OutletEvent[]; latest_seq: number; has_more: boolean };

/** A pricing rule body (shared PricingRuleSchema) as the register lists it; only the fields the POS shows. */
export type ManualRule = {
  rule_key: string;
  name: string;
  kind: "fee" | "discount";
  calc: "percent" | "fixed_per_order" | "fixed_per_unit";
  value: { type: "fixed"; amount: number } | { type: "open"; min: number; max: number };
  level: "line" | "order";
  min_role: Role;
  override_allowed: boolean;
  reason_required: boolean;
  report_class: string;
};

export type VoidReason = { id: string; name: string; for_refunds: boolean; sort: number; archived: boolean };
export type Customer = { id: string; name: string; mobile: string | null; email: string | null; group_ids: string[]; archived: boolean };
export type OverrideGrant = { override_id: string; action: string; target_id: string; approver: { id: string; name: string | null; role: string }; expires_at: string };

/** Permission keys the POS asks managers to approve (shared PERMISSIONS). */
export type OverrideAction = "lines.void_fired" | "lines.add_open_price" | "adjustments.apply_manual" | "adjustments.remove" | "payments.record" | "refunds.create" | "orders.reopen";
export type OverrideTargetKind = "order" | "order_line" | "check";

/* ---- v0.7 bills, payments, refunds (design 4.4 to 4.6) --------------------- */

export type CheckStatus = "open" | "paid" | "partially_refunded" | "refunded";
export type CheckPayment = {
  id: string;
  tender_type_id: string;
  tender: string;
  is_cash: boolean;
  amount: number;
  rounding_cents: number;
  tendered: number | null;
  change_cents: number;
  tip_cents: number;
  reference: string | null;
  status: string;
  recorded_by: string | null;
  created_at: string;
};
/** One line's part of a bill: `share` is "1" or a fraction such as "1/3". */
export type CheckAllocation = { line_id: string; share: string; base: number; discount: number; fee: number; tax: number; taxes: TaxAmount[]; total: number };
export type CheckSnapshot = {
  id: string;
  index: number;
  label: string;
  status: CheckStatus;
  seat_no: number | null;
  totals: { subtotal: number; discount_total: number; fee_total: number; tax_total: number; taxes: TaxAmount[]; total: number };
  paid_total: number;
  rounding_total: number;
  refunded_total: number;
  balance: number;
  locked: boolean;
  invoice_no: string | null;
  allocations: CheckAllocation[];
  payments: CheckPayment[];
};

export type TenderType = { id: string; name: string; is_cash: boolean; opens_drawer: boolean; is_terminal: boolean; sort: number; archived: boolean };

/** The register's figures for one payment (or a dry run): rounding and change are never computed on the iPad. */
export type PaymentFigures = Partial<CheckPayment> & { change_due: number };
export type PaymentResult = MutationResult & { payment: PaymentFigures };

export type RefundRequest = { kind: "full" } | { kind: "lines"; lines: { line_id: string; quantity: number }[] } | { kind: "amount"; amount: number };
export type RefundLineResult = { line_id: string; quantity: number; base: number; discount: number; fee: number; tax: number; taxes: TaxAmount[]; total: number; adjustments: Record<string, { amount: number; tax: number }> };
export type RefundTenderResult = { payment_id: string; tender: string; is_cash: boolean; amount: number; rounding_cents: number };
export type RefundablePayment = { payment_id: string; tender: string; is_cash: boolean; amount: number; refunded: number };
export type RefundQuote = {
  lines: RefundLineResult[];
  totals: { base: number; discount: number; fee: number; tax: number; taxes: TaxAmount[]; total: number };
  tenders: RefundTenderResult[];
  cash_out: number;
  check_id: string;
  remaining_after: { total: number };
  payments: RefundablePayment[];
};
export type Refund = {
  id: string;
  order_id: string;
  check_id: string;
  kind: string;
  reason: string;
  refunded_by: string | null;
  approved_by: string | null;
  business_date: string;
  totals: { base: number; discount: number; fee: number; tax: number; taxes: TaxAmount[]; total: number };
  refund_receipt_no: string | null;
  credit_note_no: string | null;
  created_at: string;
};
export type RefundResult = MutationResult & { refund: Refund & { quote: RefundQuote } };

export type ReceiptChannel = "qr" | "link" | "email" | "sms";
export type ReceiptSend = { token: string; url: string; delivery_status: string };
export type Invoice = { invoice_no: string; issued_at: string; reused: boolean; pdf_url: string };
export type CreatedJob = { id: string; printer_id: string; printer_name: string; kind: string; copy_no: number; copies: number };

/* ---- v0.6 shifts and reports (design 4.9) --------------------------------- */

export type Shift = {
  id: string;
  outlet_id: string;
  station_id: string | null;
  name: string | null;
  status: "open" | "closed";
  business_date: string;
  opened_by: string | null;
  opened_at: string;
  float_cents: number;
  float_counts: Record<string, number> | null;
  closed_by: string | null;
  closed_at: string | null;
  counted_cash_cents: number | null;
  expected_cash_cents: number | null;
  variance_cents: number | null;
  variance_reason: string | null;
  summary: unknown;
};
export type ZReport = {
  scope: { outlet_id: string; station_id: string | null; business_date: string; shift_id: string | null };
  orders: { count: number; by_type: Record<string, number>; covers: number; open_count: number };
  /** `net` is net sales: items after discounts, without tax and fees, less `refunds` (the refunds' net). `fees` excludes tax; `total` is what was collected before refunds. */
  sales: { gross: number; discounts: number; fees: number; tax: number; taxes: TaxBreakdown[]; refunds: number; net: number; total: number };
  adjustments: { rule_key: string; name: string; kind: string; report_class: string; total: number; count: number }[];
  tenders: { tender_type_id: string; tender: string; is_cash: boolean; count: number; amount: number; rounding: number; tips: number }[];
  cash: { float: number; cash_payments: number; rounding: number; refunds: number; expected: number; counted: number | null; variance: number | null };
  voids: { count: number; quantity: number; value: number };
  refunds: { count: number; amount: number };
  generated_at: string;
};
export type ShiftCloseResult = { data: Shift & { report: ZReport }; events: MutationEvent[]; warnings: string[] };

/* ---- Printing (design 4.8) ------------------------------------------------- */

export type PrintJobStatus = "queued" | "claimed" | "printed" | "failed" | "rerouted" | string;
export type PrintJob = {
  id: string;
  outlet_id: string;
  printer_id: string;
  kind: string;
  order_id: string | null;
  check_id: string | null;
  status: PrintJobStatus;
  attempts: number;
  copy_no: number;
  copies: number;
  claimed_by: string | null;
  claimed_at: string | null;
  printed_at: string | null;
  last_error: string | null;
  reprint_of: string | null;
  rerouted_to: string | null;
  rerouted_from: string | null;
  created_at: string;
  age_seconds: number;
  text: string;
};
export type Printer = { id: string; outlet_id: string; name: string; role: "kitchen" | "receipt"; station_id: string | null; backup_printer_id: string | null; is_default_kitchen: boolean; supports_status: boolean; archived: boolean };
export type Relay = { id: string; outlet_id: string; name: string; paired: boolean; last_seen_at: string | null; online: boolean; version: string | null; printer_status: Record<string, { ok: boolean; checked_at: string; error?: string }>; archived: boolean };

/* ---- Scan to Order on the POS (design 4.2 Now rail, 4.11) ------------------ */

export type GuestRound = {
  id: string;
  order_id: string;
  table_id: string;
  status: "pending" | "accepted" | "rejected" | "fired";
  line_ids: string[];
  guest_name: string | null;
  notes: string | null;
  submitted_at: string;
  decided_at: string | null;
  decided_by: string | null;
  reject_reason: string | null;
  table_name: string | null;
  lines: { id: string; name: string; quantity: number; modifiers: string[]; notes: string | null; status: string }[];
};
export type ServiceRequest = {
  id: string;
  table_id: string;
  order_id: string | null;
  type: string;
  status: "open" | "acknowledged";
  guest_name: string | null;
  created_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  table_name: string | null;
};

export type StockEntry = { outlet_id: string; product_id: string; sold_out: boolean; sold_out_until: string | null; daily_cap: number | null; cap_remaining: number | null; cap_date: string | null };
