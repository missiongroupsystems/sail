import { PERMISSIONS, roleAtLeast, type PermissionKey, type Role } from "@sail/shared";
import type { ClientPathsWithMethod, MethodResponse } from "openapi-fetch";
import { ApiError, type ApiClient } from "@/lib/api";
import type { paths } from "@/lib/api/schema";
import type { Me, TaxAmount, TaxBreakdown } from "@/lib/api/types";

/**
 * Register payloads the back office reads beyond lib/api/types.ts. The OpenAPI
 * document types several of these as open objects (`{[k]: unknown}`), so they are
 * written out here from the server's own serialisers (routes/printing.ts,
 * services/checks.ts, routes/splits-refunds.ts, routes/guest.ts, services/shifts.ts).
 * Every amount is integer cents from the register and is only ever displayed.
 */

type Res<M extends "get" | "post", P extends ClientPathsWithMethod<ApiClient, M>> = MethodResponse<ApiClient, M, P>;

export type Printer = Res<"get", "/v1/printers">["data"][number];
export type PrinterCreate = paths["/v1/printers"]["post"]["requestBody"]["content"]["application/json"];
export type PrinterPatch = paths["/v1/printers/{id}"]["patch"]["requestBody"]["content"]["application/json"];
export type Relay = Res<"get", "/v1/relays">["data"][number];
export type PrintJob = Res<"get", "/v1/outlets/{id}/print-jobs">["data"][number];
export type CreatedJob = Res<"post", "/v1/print-jobs/{id}/reprint">["data"][number];
export type RelayPairingCode = Res<"post", "/v1/relays/{id}/pairing-code">["data"];

export const PRINT_JOB_STATUSES = ["queued", "claimed", "printed", "failed", "rerouted"] as const;
export type PrintJobStatus = (typeof PRINT_JOB_STATUSES)[number];
export const PRINT_JOB_STATUS_LABEL: Record<string, string> = { queued: "Queued", claimed: "Printing", printed: "Printed", failed: "Failed", rerouted: "Rerouted" };
export const PRINT_JOB_KIND_LABEL: Record<string, string> = { kitchen: "Kitchen ticket", void: "Void ticket", reprint: "Reprint", test: "Test print", receipt: "Receipt", prebill: "Pre-bill", refund_receipt: "Refund receipt", invoice: "Invoice" };
export const PRINTER_ROLE_LABEL: Record<string, string> = { kitchen: "Kitchen", receipt: "Receipt" };
export const SOURCE_LABEL: Record<string, string> = { pos: "POS", guest: "Scan to order" };

/** A bill inside the order snapshot (services/checks.ts CheckSnapshot). */
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
  status: "recorded" | "reversed" | string;
  recorded_by: string | null;
  created_at: string;
};
export type CheckSnapshot = {
  id: string;
  index: number;
  label: string;
  status: "open" | "paid" | "partially_refunded" | "refunded" | string;
  seat_no: number | null;
  totals: { subtotal: number; discount_total: number; fee_total: number; tax_total: number; taxes: TaxAmount[]; total: number };
  paid_total: number;
  rounding_total: number;
  refunded_total: number;
  balance: number;
  locked: boolean;
  invoice_no: string | null;
  allocations: { line_id: string; share: string; base: number; discount: number; fee: number; tax: number; taxes: TaxAmount[]; total: number }[];
  payments: CheckPayment[];
};
export const CHECK_STATUS_LABEL: Record<string, string> = { open: "Unpaid", paid: "Paid", partially_refunded: "Partly refunded", refunded: "Refunded" };

/** POST /v1/checks/{id}/refunds/quote (shared quoteRefund plus the route's extras). */
export type RefundRequest = { kind: "full" } | { kind: "lines"; lines: { line_id: string; quantity: number }[] } | { kind: "amount"; amount: number };
export type RefundQuote = {
  check_id: string;
  lines: { line_id: string; quantity: number; base: number; discount: number; fee: number; tax: number; taxes: TaxAmount[]; total: number; adjustments: Record<string, { amount: number; tax: number }> }[];
  totals: { base: number; discount: number; fee: number; tax: number; taxes: TaxAmount[]; total: number };
  tenders: { payment_id: string; tender: string; is_cash: boolean; amount: number; rounding_cents: number }[];
  cash_out: number;
  remaining_after: { total: number };
  payments: { payment_id: string; tender: string; is_cash: boolean; amount: number; refunded: number }[];
};
/** GET /v1/orders/{id}/refunds (routes/splits-refunds.ts toRefund). */
export type Refund = {
  id: string;
  order_id: string;
  check_id: string;
  kind: "full" | "lines" | "amount" | string;
  reason: string;
  refunded_by: string | null;
  approved_by: string | null;
  business_date: string;
  totals: { base: number; discount: number; fee: number; tax: number; taxes: TaxAmount[]; total: number };
  refund_receipt_no: string;
  credit_note_no: string | null;
  created_at: string;
};
export type RefundCreated = { refund: Refund & { quote: RefundQuote }; warnings: string[] };
export type InvoiceIssued = Res<"post", "/v1/checks/{id}/invoice">["data"];

/** GET /v1/outlets/{id}/floor (routes/orders.ts floor.snapshot). */
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
  status: "free" | "seated" | "sent" | "bill_requested" | "paid" | string;
  order: { id: string; order_no: string; status: string; pax: number | null; opened_at: string; elapsed_seconds: number; total: number; version: number; pending_rounds: number } | null;
  requests_waiting: number;
};
export type FloorSnapshot = {
  outlet_id: string;
  as_of: string;
  areas: { id: string; name: string; sort: number }[];
  tables: FloorTable[];
  open_orders: number;
  other_orders: { id: string; order_no: string; order_type: string; status: string; ready_by: string | null; customer_ref: { name?: string; mobile?: string } | null; total: number }[];
};

/** GET /v1/outlets/{id}/rounds (services/guest.ts toRound plus table_name and lines). */
export type GuestRound = {
  id: string;
  order_id: string;
  table_id: string;
  table_name: string | null;
  status: "pending" | "accepted" | "rejected" | "fired" | string;
  line_ids: string[];
  guest_name: string | null;
  notes: string | null;
  submitted_at: string;
  decided_at: string | null;
  decided_by: string | null;
  reject_reason: string | null;
  lines: { id: string; name: string; quantity: number; modifiers: string[]; notes: string | null; status: string }[];
};
/** GET /v1/outlets/{id}/service-requests (services/guest.ts toRequest plus table_name). */
export type ServiceRequest = {
  id: string;
  table_id: string;
  table_name: string | null;
  order_id: string | null;
  type: string;
  status: "open" | "acknowledged" | string;
  guest_name: string | null;
  created_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
};
export const REQUEST_TYPE_LABEL: Record<string, string> = { call_staff: "Call staff", call_for_bill: "Bill, please", bill: "Bill, please", water: "Water", cutlery: "Cutlery", napkins: "Napkins", help: "Help", other: "Request" };

/** GET /v1/outlets/{id}/z-report (services/shifts.ts ZReport). */
export type ZReport = {
  scope: { outlet_id: string; station_id: string | null; business_date: string; shift_id: string | null };
  orders: { count: number; by_type: Record<string, number>; covers: number; open_count: number };
  /** `net` is net sales: items after discounts, without tax and fees, less `refunds` (the refunds' net). `fees` excludes tax; `total` is what was collected before refunds. */
  sales: { gross: number; discounts: number; fees: number; tax: number; taxes: TaxBreakdown[]; refunds: number; net: number; total: number };
  adjustments: { rule_key: string; name: string; kind: string; report_class: string; total: number; count: number }[];
  tenders: { tender_type_id: string; tender: string; is_cash: boolean; count: number; amount: number; rounding: number; tips: number }[];
  cash: { float: number; cash_payments: number; rounding: number; tips: number; refunds: number; expected: number; counted: number | null; variance: number | null };
  voids: { count: number; quantity: number; value: number };
  refunds: { count: number; amount: number };
  generated_at: string;
};
/** GET /v1/outlets/{id}/shifts (routes/payments.ts toShift). */
export type Shift = {
  id: string;
  outlet_id: string;
  station_id: string | null;
  name: string | null;
  status: "open" | "closed" | string;
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
  summary: ZReport | null;
};
export type BusinessDayClose = { id: string; business_date: string; closed_at: string; report: ZReport };

/** Query keys for the resources this phase adds. Invalidate by prefix after a mutation. */
export const boKeys = {
  printers: (outletId: string) => ["printers", outletId] as const,
  relays: (outletId: string) => ["relays", outletId] as const,
  printJobs: (outletId: string, filters: Record<string, string | undefined>) => ["print-jobs", outletId, filters] as const,
  orderJobs: (orderId: string) => ["print-jobs", "order", orderId] as const,
  orderRefunds: (orderId: string) => ["refunds", orderId] as const,
  floor: (outletId: string) => ["floor", outletId] as const,
  rounds: (outletId: string) => ["rounds", outletId] as const,
  serviceRequests: (outletId: string) => ["service-requests", outletId] as const,
  shifts: (outletId: string, filters: Record<string, string | undefined>) => ["shifts", outletId, filters] as const,
  zReport: (outletId: string, date: string, stationId: string | null) => ["z-report", outletId, date, stationId] as const,
};

/** Can the signed-in person run this operation? The server enforces it; this only decides what to show. */
export function can(me: Me, key: PermissionKey): boolean {
  if (!me.role) return false;
  return roleAtLeast(me.role as Role, PERMISSIONS[key].minRole);
}
export function roleIs(me: Me, min: Role): boolean {
  return !!me.role && roleAtLeast(me.role as Role, min);
}

/** "Manager, Finance or Admin": the roles that may run an operation, for a disabled button's hint. */
export function rolesFor(key: PermissionKey): string {
  const min = PERMISSIONS[key].minRole;
  const names: Record<Role, string> = { server: "Server", cashier: "Cashier", manager: "Manager", finance: "Finance", admin: "Admin" };
  const order: Role[] = ["server", "cashier", "manager", "finance", "admin"];
  const allowed = order.filter((r) => roleAtLeast(r, min)).map((r) => names[r]);
  if (allowed.length === 1) return allowed[0]!;
  return `${allowed.slice(0, -1).join(", ")} or ${allowed[allowed.length - 1]}`;
}

/** Fetches a PDF through the Next proxy and opens it in a new tab; errors come back as ApiError with the register's remedy. */
export async function openPdf(path: string, filename: string): Promise<void> {
  const res = await fetch(`/api${path}`, { headers: { accept: "application/pdf" } });
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    throw ApiError.from(res.status, body);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** "0:14" elapsed from seconds, or "2 h 05" past an hour. */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")}`;
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** "3 tickets", "1 ticket". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
