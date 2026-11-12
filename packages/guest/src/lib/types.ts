/**
 * Register payloads the guest app reads. The OpenAPI document types the guest
 * order view, the compiled menu and the receipt as open records, so these
 * mirror the server's own TypeScript types (services/menu.ts, services/guest.ts,
 * shared/escpos BillDocument). Amounts are integer cents and are only displayed.
 */
import type { BillDocumentLike, LocaleSettingsSource } from "@sail/ui";

export type OrderType = "dine_in" | "takeaway" | "pickup" | "delivery";
export type OrderStatus = "open" | "fired" | "ready" | "out_for_delivery" | "completed" | "cancelled";
export type LineStatus = "pending" | "held" | "fired" | "voided";

export type CompiledOption = { product_id: string; name: string; price: number; child_group_id: string | null; is_default: boolean; sort: number };
export type CompiledGroup = { id: string; name: string; min_select: number; max_select: number | null; max_per_modifier: number; options: CompiledOption[] };
export type CompiledProduct = {
  id: string;
  name: string;
  kitchen_name: string | null;
  sku: string | null;
  description: string | null;
  price: number;
  prices_by_order_type: Partial<Record<OrderType, number>>;
  tags: string[];
  open_price: boolean;
  modifier_groups: string[];
  available_now: boolean;
  unavailable_reason: string | null;
  sold_out: boolean;
  sold_out_until: string | null;
  cap_remaining: number | null;
};
export type CompiledSection = { id: string; name: string; parent_id: string | null; sort: number; available_now: boolean; items: { product_id: string; sort: number }[] };
export type Brand = { id: string; name: string; accent_color: string | null; display_font: string | null; logo_url: string | null };
export type CompiledMenu = {
  channel_link: { id: string; channel: string; outlet_id: string; brand_id: string; menu_id: string; hold_orders: boolean; open_on_first_scan: boolean; service_requests: string[] };
  brand: Brand;
  outlet: { id: string; name: string; phone: string | null };
  menu: { id: string; name: string; sections: CompiledSection[] };
  products: Record<string, CompiledProduct>;
  modifier_groups: Record<string, CompiledGroup>;
  compiled_at: string;
  version: string;
};

export type GuestSession = {
  guest_token: string;
  session_id: string;
  table: { id: string; name: string };
  outlet: { id: string; name: string };
  brand_id: string;
  channel_link_id: string;
  order_open: boolean;
  can_order: boolean;
  hold_orders: boolean;
  service_requests: string[];
  expires_at: string;
  /** The merchant's currency, locale and zone, once the register sends them with the session. */
  settings?: LocaleSettingsSource;
};

export type RoundStatus = "pending" | "accepted" | "fired" | "rejected";
export type GuestRound = {
  id: string;
  order_id: string;
  table_id: string;
  status: RoundStatus;
  line_ids: string[];
  guest_name: string | null;
  notes: string | null;
  submitted_at: string;
  decided_at: string | null;
  decided_by: string | null;
  reject_reason: string | null;
  mine: boolean;
};
export type GuestLine = {
  id: string;
  name: string;
  quantity: number;
  modifiers: string[];
  notes: string | null;
  seat_no: number | null;
  status: LineStatus;
  source: string;
  round_id: string | null;
  mine: boolean;
};
export type GuestRequest = {
  id: string;
  table_id: string;
  order_id: string | null;
  type: string;
  status: string;
  guest_name: string | null;
  created_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
};
export type GuestOrder = { id: string; order_no: string; status: OrderStatus; opened_at: string; bill_requested: boolean };
export type OrderView = { table_id: string; order: GuestOrder | null; lines: GuestLine[]; rounds: GuestRound[]; requests: GuestRequest[] };
export type RoundResult = OrderView & { round_id: string; status: "pending" | "accepted"; order_opened: boolean };

export type RoundModifierInput = { group_id: string; product_id: string; quantity?: number };
export type RoundLineInput = { line_id: string; product_id: string; quantity: number; modifiers?: RoundModifierInput[]; notes?: string | null };
export type RoundInput = { round_id: string; lines: RoundLineInput[]; guest_name?: string; notes?: string };

export type ReceiptRead = { document: BillDocumentLike; channel: string; created_at: string; settings?: LocaleSettingsSource };
