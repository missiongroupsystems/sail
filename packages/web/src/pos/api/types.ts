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
  is_bcrs: boolean;
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

export type LineAmounts = { base: number; discount: number; net: number; fee: number; gst: number; total: number };
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
  total: number;
  gst_total: number;
  capped: boolean;
  frozen: boolean;
  manual_application_id: string | null;
  entered_value: number | null;
  applied_by: string | null;
  approved_by: string | null;
  reason: string | null;
  lines: { line_id: string; amount: number; gst_amount: number }[];
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
  totals: { tax_mode: "inclusive" | "exclusive"; gst_bps: number; subtotal: number; discount_total: number; fee_total: number; gst_total: number; total: number };
  lines: SnapshotLine[];
  adjustments: SnapshotAdjustment[];
  manual_applications: { id: string; rule_key: string; entered_value: number | null; line_ids: string[] | null; applied_by: string | null; reason: string | null }[];
  checks: unknown[];
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
export type OverrideAction = "lines.void_fired" | "lines.add_open_price" | "adjustments.apply_manual" | "adjustments.remove";
