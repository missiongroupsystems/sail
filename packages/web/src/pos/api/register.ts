import { idempotencyKey, req } from "@/lib/api";
import type { PosApi } from "./client";
import type {
  ChannelLink,
  CheckSnapshot,
  CompiledMenu,
  CreatedJob,
  Customer,
  EventsPage,
  FloorSnapshot,
  AllDayItem,
  KitchenTicket,
  KitchenTicketsPage,
  GuestRound,
  Invoice,
  Layout,
  ManualRule,
  Merchant,
  MutationResult,
  OrderSnapshot,
  OrderType,
  Outlet,
  OverrideGrant,
  OverrideSubject,
  PaymentIntent,
  PaymentResult,
  Printer,
  PrintJob,
  ReceiptChannel,
  ReceiptSend,
  Refund,
  RefundQuote,
  RefundRequest,
  RefundResult,
  Relay,
  ServiceRequest,
  SessionStart,
  Shift,
  ShiftCloseResult,
  Station,
  StockEntry,
  TenderType,
  VoidReason,
  ZReport,
  ZReportWithheld,
} from "./types";

/**
 * Every register call the POS makes, as plain functions over the client. The
 * screens never build URLs or bodies themselves, and a node script can drive
 * the same functions against a live API (scripts/pos-smoke.ts).
 *
 * Mutations take an `Idempotency-Key`; pass the same `key` when retrying one
 * logical action. `override_id` goes in the body and in `X-Override-Id`, which
 * the register's role gate reads before the handler runs.
 */

export type MutationOpts = { key?: string; overrideId?: string | null; expectedVersion?: number | null };

function headers(opts: MutationOpts = {}): Record<string, string> {
  const h: Record<string, string> = { "Idempotency-Key": opts.key ?? idempotencyKey() };
  if (opts.overrideId) h["X-Override-Id"] = opts.overrideId;
  return h;
}
function mutation(opts: MutationOpts = {}): { expected_version?: number; override_id?: string } {
  const b: { expected_version?: number; override_id?: string } = {};
  if (opts.expectedVersion != null) b.expected_version = opts.expectedVersion;
  if (opts.overrideId) b.override_id = opts.overrideId;
  return b;
}
const asResult = (r: unknown) => r as MutationResult;

/* ---- Station and session ------------------------------------------------ */

export async function pairStation(api: PosApi, code: string, deviceLabel: string, kind?: Station["kind"]): Promise<{ station_token: string; station: Station }> {
  const res = await req(api.POST("/v1/stations/pair", { body: { code, device_label: deviceLabel, ...(kind ? { kind } : {}) }, headers: headers() }));
  return { station_token: res.data.station_token, station: res.data.station as unknown as Station };
}

export async function startSession(api: PosApi, pin: string): Promise<SessionStart> {
  const res = await req(api.POST("/v1/stations/sessions", { body: { pin }, headers: headers() }));
  return res.data as unknown as SessionStart;
}

/** Ends this iPad's pairing on the register: its station token stops working and the back office shows it as not paired. */
export async function unpairStation(api: PosApi): Promise<void> {
  await req(api.POST("/v1/stations/unpair", { body: {}, headers: headers() }));
}

/** Ends a PIN session on the register: the one signed in, or `token`'s when the station has already locked. */
export async function endSession(api: PosApi, token?: string | null): Promise<void> {
  await req(api.POST("/v1/stations/sessions/end", { body: {}, headers: { ...headers(), ...(token ? { authorization: `Bearer ${token}` } : {}) } }));
}

export async function getMe(api: PosApi) {
  return (await req(api.GET("/v1/me"))).data;
}

/* ---- Reference data ------------------------------------------------------ */

export async function getMerchant(api: PosApi): Promise<Merchant> {
  return (await req(api.GET("/v1/merchant"))).data as unknown as Merchant;
}

export async function listOutlets(api: PosApi): Promise<Outlet[]> {
  return (await req(api.GET("/v1/outlets"))).data as unknown as Outlet[];
}

export async function listStations(api: PosApi, outletId: string): Promise<Station[]> {
  return (await req(api.GET("/v1/outlets/{id}/stations", { params: { path: { id: outletId } } }))).data as unknown as Station[];
}

export async function findPosChannelLink(api: PosApi, outletId: string, brandId: string | null): Promise<ChannelLink | null> {
  const res = await req(api.GET("/v1/channel-links", { params: { query: { channel: "pos", outlet_id: outletId, ...(brandId ? { brand_id: brandId } : {}) } } }));
  const links = res.data as unknown as ChannelLink[];
  return links.find((l) => l.enabled && l.outlet_id === outletId) ?? links[0] ?? null;
}

export async function getMenu(api: PosApi, channelLinkId: string): Promise<CompiledMenu> {
  return (await req(api.GET("/v1/channel-links/{id}/menu", { params: { path: { id: channelLinkId } } }))).data as unknown as CompiledMenu;
}

export async function getLayout(api: PosApi, layoutId: string): Promise<Layout> {
  return (await req(api.GET("/v1/layouts/{id}", { params: { path: { id: layoutId } } }))).data as unknown as Layout;
}

export async function getFloor(api: PosApi, outletId: string): Promise<FloorSnapshot> {
  return (await req(api.GET("/v1/outlets/{id}/floor", { params: { path: { id: outletId } } }))).data as unknown as FloorSnapshot;
}

export async function listOpenOrders(api: PosApi, outletId: string): Promise<OrderSnapshot[]> {
  return (await req(api.GET("/v1/outlets/{id}/orders", { params: { path: { id: outletId }, query: { open_only: "true", limit: 200 } } }))).data as unknown as OrderSnapshot[];
}

export async function listTodaysOrders(api: PosApi, outletId: string, businessDate: string): Promise<OrderSnapshot[]> {
  return (await req(api.GET("/v1/outlets/{id}/orders", { params: { path: { id: outletId }, query: { business_date: businessDate, limit: 200 } } }))).data as unknown as OrderSnapshot[];
}

export async function getOrder(api: PosApi, orderId: string): Promise<OrderSnapshot> {
  return (await req(api.GET("/v1/orders/{id}", { params: { path: { id: orderId } } }))).data as unknown as OrderSnapshot;
}

/**
 * Manual rules the signed-in role may apply, or see with a Manager approval
 * badge. Reads every version and keeps the active one per rule
 * key: the register's `active_at` filter currently fails its own body parse
 * (see the smoke test), so the POS filters the plain list instead.
 */
export async function listManualRules(api: PosApi): Promise<ManualRule[]> {
  const res = await req(api.GET("/v1/pricing-rules"));
  const byKey = new Map<string, (typeof res.data)[number]>();
  for (const row of res.data) {
    if (row.archived || row.status !== "active") continue;
    const cur = byKey.get(row.rule_key);
    if (!cur || row.version > cur.version) byKey.set(row.rule_key, row);
  }
  const out: ManualRule[] = [];
  for (const row of byKey.values()) {
    const b = row.body as Record<string, unknown>;
    if (b.application !== "manual") continue;
    out.push({
      rule_key: row.rule_key,
      name: String(b.name ?? row.rule_key),
      kind: b.kind as ManualRule["kind"],
      calc: b.calc as ManualRule["calc"],
      value: b.value as ManualRule["value"],
      level: (b.level as ManualRule["level"]) ?? (b.calc === "fixed_per_order" ? "order" : "line"),
      min_role: (b.min_role as ManualRule["min_role"]) ?? "server",
      override_allowed: Boolean(b.override_allowed),
      reason_required: Boolean(b.reason_required),
      report_class: String(b.report_class ?? "other"),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listVoidReasons(api: PosApi): Promise<VoidReason[]> {
  return (await req(api.GET("/v1/void-reasons"))).data as unknown as VoidReason[];
}

export async function findCustomers(api: PosApi, mobile: string): Promise<Customer[]> {
  return (await req(api.GET("/v1/customers", { params: { query: { mobile, limit: 10 } } }))).data as unknown as Customer[];
}

export async function listEvents(api: PosApi, outletId: string, after: number, limit = 500): Promise<EventsPage> {
  return (await req(api.GET("/v1/outlets/{id}/events", { params: { path: { id: outletId }, query: { after, limit } } }))) as unknown as EventsPage;
}

/* ---- Kitchen display ------------------------------------------------------ */

/** Open tickets for the caller's destinations (a display station sees only its own), or every ticket of one order. */
export async function listKitchenTickets(api: PosApi, outletId: string, query: { order_id?: string } = {}): Promise<KitchenTicketsPage> {
  return req(api.GET("/v1/outlets/{id}/kitchen-tickets", { params: { path: { id: outletId }, query } }));
}

export async function kitchenAllDay(api: PosApi, outletId: string): Promise<AllDayItem[]> {
  return (await req(api.GET("/v1/outlets/{id}/kitchen-tickets/all-day", { params: { path: { id: outletId } } }))).data;
}

/** Bump (ready) or recall a ticket. A repeat, or the other display getting there first, returns it unchanged. */
export async function actOnKitchenTicket(api: PosApi, ticketId: string, action: "bump" | "recall", opts: MutationOpts = {}): Promise<KitchenTicket> {
  const res = action === "bump" ? await req(api.POST("/v1/kitchen-tickets/{id}/bump", { params: { path: { id: ticketId } }, body: {}, headers: headers(opts) })) : await req(api.POST("/v1/kitchen-tickets/{id}/recall", { params: { path: { id: ticketId } }, body: {}, headers: headers(opts) }));
  return res.data;
}

/* ---- Orders --------------------------------------------------------------- */

export type OpenOrderInput = {
  order_id: string;
  order_type: OrderType;
  table_id?: string;
  pax?: number;
  takeaway_ref?: string;
  customer_ref?: { name?: string; mobile?: string };
  ready_by?: string;
  delivery_address?: string;
  delivery_notes?: string;
  notes?: string;
};

export async function openOrder(api: PosApi, input: OpenOrderInput, opts?: MutationOpts): Promise<MutationResult> {
  return asResult(await req(api.POST("/v1/orders", { body: { ...mutation(opts), ...input }, headers: headers(opts) })));
}

export type LineInput = {
  line_id: string;
  product_id: string;
  quantity: number;
  modifiers?: { group_id: string; product_id: string; quantity?: number }[];
  notes?: string | null;
  seat_no?: number | null;
  hold?: boolean;
  open_price?: number | null;
};

export async function addLines(api: PosApi, orderId: string, lines: LineInput[], opts?: MutationOpts): Promise<MutationResult> {
  return asResult(await req(api.POST("/v1/orders/{id}/lines", { params: { path: { id: orderId } }, body: { ...mutation(opts), lines }, headers: headers(opts) })));
}

export type LinePatch = { dry_run?: boolean; quantity?: number; notes?: string | null; seat_no?: number | null; hold?: boolean; modifiers?: { group_id: string; product_id: string; quantity?: number }[] };

export async function updateLine(api: PosApi, orderId: string, lineId: string, patch: LinePatch, opts?: MutationOpts): Promise<MutationResult> {
  return asResult(await req(api.PATCH("/v1/orders/{id}/lines/{line_id}", { params: { path: { id: orderId, line_id: lineId } }, body: { ...mutation(opts), ...patch }, headers: headers(opts) })));
}

export async function voidLine(api: PosApi, orderId: string, lineId: string, reason: { reason_id?: string; reason_text?: string; quantity?: number }, opts?: MutationOpts): Promise<MutationResult> {
  return asResult(await req(api.POST("/v1/orders/{id}/lines/{line_id}/void", { params: { path: { id: orderId, line_id: lineId } }, body: { ...mutation(opts), ...reason }, headers: headers(opts) })));
}

export async function fireOrder(api: PosApi, orderId: string, body: { line_ids?: string[]; include_held?: boolean } = {}, opts?: MutationOpts): Promise<MutationResult> {
  return asResult(await req(api.POST("/v1/orders/{id}/fire", { params: { path: { id: orderId } }, body: { ...mutation(opts), ...body }, headers: headers(opts) })));
}

export type ChangeTypeInput = { order_type: OrderType; table_id?: string | null; pax?: number | null; customer_ref?: { name?: string; mobile?: string } | null; delivery_address?: string | null; ready_by?: string | null };

export async function changeOrderType(api: PosApi, orderId: string, input: ChangeTypeInput, opts?: MutationOpts): Promise<MutationResult> {
  return asResult(await req(api.POST("/v1/orders/{id}/change-type", { params: { path: { id: orderId } }, body: { ...mutation(opts), ...input }, headers: headers(opts) })));
}

export async function moveTable(api: PosApi, orderId: string, tableId: string, opts?: MutationOpts): Promise<MutationResult> {
  return asResult(await req(api.POST("/v1/orders/{id}/move-table", { params: { path: { id: orderId } }, body: { ...mutation(opts), table_id: tableId }, headers: headers(opts) })));
}

export async function attachCustomer(api: PosApi, orderId: string, customerId: string, opts?: MutationOpts): Promise<MutationResult> {
  return asResult(await req(api.POST("/v1/orders/{id}/customer", { params: { path: { id: orderId } }, body: { ...mutation(opts), customer_id: customerId }, headers: headers(opts) })));
}

export async function detachCustomer(api: PosApi, orderId: string, opts?: MutationOpts): Promise<MutationResult> {
  return asResult(await req(api.DELETE("/v1/orders/{id}/customer", { params: { path: { id: orderId } }, body: mutation(opts), headers: headers(opts) })));
}

export type DetailsPatch = { pax?: number | null; customer_ref?: { name?: string; mobile?: string }; delivery_address?: string | null; delivery_notes?: string | null; ready_by?: string | null; notes?: string | null };

export async function updateOrderDetails(api: PosApi, orderId: string, patch: DetailsPatch, opts?: MutationOpts): Promise<MutationResult> {
  return asResult(await req(api.PATCH("/v1/orders/{id}", { params: { path: { id: orderId } }, body: { ...mutation(opts), ...patch }, headers: headers(opts) })));
}

export async function cancelOrder(api: PosApi, orderId: string, reason: string, opts?: MutationOpts): Promise<MutationResult> {
  return asResult(await req(api.POST("/v1/orders/{id}/cancel", { params: { path: { id: orderId } }, body: { ...mutation(opts), reason }, headers: headers(opts) })));
}

export async function markReady(api: PosApi, orderId: string, opts?: MutationOpts): Promise<MutationResult> {
  return asResult(await req(api.POST("/v1/orders/{id}/ready", { params: { path: { id: orderId } }, body: mutation(opts), headers: headers(opts) })));
}

export type AdjustmentInput = { application_id: string; rule_key: string; entered_value?: number | null; line_ids?: string[] | null; reason?: string | null };

export async function applyAdjustment(api: PosApi, orderId: string, input: AdjustmentInput, opts?: MutationOpts): Promise<MutationResult> {
  return asResult(await req(api.POST("/v1/orders/{id}/adjustments", { params: { path: { id: orderId } }, body: { ...mutation(opts), ...input }, headers: headers(opts) })));
}

export async function removeAdjustment(api: PosApi, orderId: string, applicationId: string, opts?: MutationOpts): Promise<MutationResult> {
  return asResult(await req(api.DELETE("/v1/orders/{id}/adjustments/{application_id}", { params: { path: { id: orderId, application_id: applicationId } }, body: mutation(opts), headers: headers(opts) })));
}

/* ---- Manager approval ------------------------------------------------------ */

export async function grantOverride(api: PosApi, input: OverrideSubject & { approver_pin: string }): Promise<OverrideGrant> {
  const res = await req(api.POST("/v1/overrides", { body: input, headers: headers() }));
  return res.data as unknown as OverrideGrant;
}

/* ---- Bills ----------------------------------------------------- */

export async function listChecks(api: PosApi, orderId: string): Promise<CheckSnapshot[]> {
  return (await req(api.GET("/v1/orders/{id}/checks", { params: { path: { id: orderId } } }))).data as unknown as CheckSnapshot[];
}

export async function splitEven(api: PosApi, orderId: string, n: number, opts?: MutationOpts): Promise<MutationResult> {
  return asResult(await req(api.POST("/v1/orders/{id}/checks/split-even", { params: { path: { id: orderId } }, body: { ...mutation(opts), n }, headers: headers(opts) })));
}

export async function splitBySeat(api: PosApi, orderId: string, shared: "even" | "manual", opts?: MutationOpts): Promise<MutationResult> {
  return asResult(await req(api.POST("/v1/orders/{id}/checks/split-by-seat", { params: { path: { id: orderId } }, body: { ...mutation(opts), shared }, headers: headers(opts) })));
}

export type AllocationMove = { line_id: string; check_ids: string[] };

/** Move a line to one bill, or share it equally between several; `add_checks` opens new empty bills first. */
export async function allocateLines(api: PosApi, orderId: string, moves: AllocationMove[], addChecks?: number, opts?: MutationOpts): Promise<MutationResult> {
  return asResult(await req(api.POST("/v1/orders/{id}/checks/allocate", { params: { path: { id: orderId } }, body: { ...mutation(opts), moves, ...(addChecks ? { add_checks: addChecks } : {}) }, headers: headers(opts) })));
}

export async function unsplit(api: PosApi, orderId: string, opts?: MutationOpts): Promise<MutationResult> {
  return asResult(await req(api.POST("/v1/orders/{id}/checks/unsplit", { params: { path: { id: orderId } }, body: mutation(opts) as never, headers: headers(opts) })));
}

export async function printPrebill(api: PosApi, orderId: string, checkId?: string | null, opts?: MutationOpts): Promise<MutationResult & { jobs: CreatedJob[] }> {
  const res = await req(api.POST("/v1/orders/{id}/prebill", { params: { path: { id: orderId } }, body: { ...mutation(opts), ...(checkId ? { check_id: checkId } : {}) }, headers: headers(opts) }));
  return res as unknown as MutationResult & { jobs: CreatedJob[] };
}

/* ---- Payments -------------------------------------------------- */

export async function listTenderTypes(api: PosApi, outletId?: string | null): Promise<TenderType[]> {
  const res = await req(api.GET("/v1/tender-types", { params: { query: outletId ? { outlet_id: outletId } : {} } }));
  return (res.data as unknown as TenderType[]).filter((t) => !t.archived).sort((a, b) => a.sort - b.sort);
}

export type PaymentInput = {
  /** Generated once per attempt on the iPad; the register ignores a replay with the same id. */
  payment_id: string;
  tender_type_id: string;
  /** Cents applied to the bill. */
  amount: number;
  /** Cash handed over; the register returns rounding and change. */
  tendered?: number | null;
  tip_cents?: number;
  reference?: string | null;
  /** Preview only: the register computes rounding and change and records nothing. */
  dry_run?: boolean;
};

export async function recordPayment(api: PosApi, checkId: string, input: PaymentInput, opts?: MutationOpts): Promise<PaymentResult> {
  const res = await req(api.POST("/v1/checks/{id}/payments", { params: { path: { id: checkId } }, body: { ...mutation(opts), ...input }, headers: headers(opts) }));
  return res as unknown as PaymentResult;
}

/** Send a payment to the card terminal. Returns at once with a pending intent; the outcome arrives on the event stream. */
export async function startTerminalPayment(api: PosApi, checkId: string, input: { intent_id: string; tender_type_id: string; amount: number; tip_cents?: number }, opts?: MutationOpts): Promise<PaymentIntent> {
  const res = await req(api.POST("/v1/checks/{id}/payment-intents", { params: { path: { id: checkId } }, body: { ...(opts?.expectedVersion != null ? { expected_version: opts.expectedVersion } : {}), ...input }, headers: headers(opts) }));
  return res.data as unknown as PaymentIntent;
}

export async function cancelTerminalPayment(api: PosApi, intentId: string): Promise<PaymentIntent> {
  const res = await req(api.POST("/v1/payment-intents/{id}/cancel", { params: { path: { id: intentId } }, body: {}, headers: headers() }));
  return res.data as unknown as PaymentIntent;
}

export async function listPaymentIntents(api: PosApi, orderId: string): Promise<PaymentIntent[]> {
  return (await req(api.GET("/v1/orders/{id}/payment-intents", { params: { path: { id: orderId } } }))).data as unknown as PaymentIntent[];
}

/** Void a payment taken in error. A terminal payment comes back `pending_provider`: it is reversed once the provider confirms. */
export async function voidPayment(api: PosApi, paymentId: string, reason: string, opts?: MutationOpts): Promise<MutationResult & { void: { payment_id: string; status: "voided" | "pending_provider" } }> {
  const res = await req(api.POST("/v1/payments/{id}/void", { params: { path: { id: paymentId } }, body: { ...mutation(opts), reason }, headers: headers(opts) }));
  return res as unknown as MutationResult & { void: { payment_id: string; status: "voided" | "pending_provider" } };
}

export async function completeOrder(api: PosApi, orderId: string, opts?: MutationOpts): Promise<MutationResult> {
  return asResult(await req(api.POST("/v1/orders/{id}/complete", { params: { path: { id: orderId } }, body: mutation(opts), headers: headers(opts) })));
}

export async function reopenOrder(api: PosApi, orderId: string, reason: string, opts?: MutationOpts): Promise<MutationResult> {
  return asResult(await req(api.POST("/v1/orders/{id}/reopen", { params: { path: { id: orderId } }, body: { ...mutation(opts), reason }, headers: headers(opts) })));
}

/* ---- Receipts and documents ---------------------------------------------------- */

export async function printReceipt(api: PosApi, checkId: string, opts?: MutationOpts): Promise<CreatedJob[]> {
  return (await req(api.POST("/v1/checks/{id}/receipt/print", { params: { path: { id: checkId } }, body: mutation(opts), headers: headers(opts) }))).data as unknown as CreatedJob[];
}

export async function sendReceipt(api: PosApi, checkId: string, channel: ReceiptChannel, destination?: string, opts?: MutationOpts): Promise<{ data: ReceiptSend; warnings: string[] }> {
  const res = await req(api.POST("/v1/checks/{id}/receipt/send", { params: { path: { id: checkId } }, body: { ...mutation(opts), channel, ...(destination ? { destination } : {}) }, headers: headers(opts) }));
  return res as unknown as { data: ReceiptSend; warnings: string[] };
}

export async function issueInvoice(api: PosApi, checkId: string, opts?: MutationOpts): Promise<Invoice> {
  return (await req(api.POST("/v1/checks/{id}/invoice", { params: { path: { id: checkId } }, body: mutation(opts), headers: headers(opts) }))).data as unknown as Invoice;
}

/** The PDF of a bill's issued invoice, as the register rendered it. */
export async function invoicePdf(api: PosApi, checkId: string): Promise<Blob> {
  return (await req(api.GET("/v1/checks/{id}/invoice.pdf", { params: { path: { id: checkId } }, parseAs: "blob", headers: { accept: "application/pdf" } }))) as unknown as Blob;
}

/* ---- Refunds -------------------------------------------------------- */

export type TenderSplit = { payment_id: string; amount: number }[];

export async function quoteRefund(api: PosApi, checkId: string, request: RefundRequest, tenderSplit?: TenderSplit): Promise<RefundQuote> {
  const res = await req(api.POST("/v1/checks/{id}/refunds/quote", { params: { path: { id: checkId } }, body: { request, ...(tenderSplit ? { tender_split: tenderSplit } : {}) }, headers: headers() }));
  return res.data as unknown as RefundQuote;
}

export type RefundInput = { refund_id: string; request: RefundRequest; tender_split?: TenderSplit; reason: string; reference?: string | null; print?: boolean };

export async function createRefund(api: PosApi, checkId: string, input: RefundInput, opts?: MutationOpts): Promise<RefundResult> {
  const res = await req(api.POST("/v1/checks/{id}/refunds", { params: { path: { id: checkId } }, body: { ...mutation(opts), ...input }, headers: headers(opts) }));
  return res as unknown as RefundResult;
}

export async function listRefunds(api: PosApi, orderId: string): Promise<Refund[]> {
  return (await req(api.GET("/v1/orders/{id}/refunds", { params: { path: { id: orderId } } }))).data as unknown as Refund[];
}

export async function printRefundReceipt(api: PosApi, refundId: string, opts?: MutationOpts): Promise<CreatedJob[]> {
  return (await req(api.POST("/v1/refunds/{id}/receipt/print", { params: { path: { id: refundId } }, body: mutation(opts), headers: headers(opts) }))).data as unknown as CreatedJob[];
}

export async function sendRefundReceipt(api: PosApi, refundId: string, channel: ReceiptChannel, destination?: string, opts?: MutationOpts): Promise<{ data: ReceiptSend; warnings: string[] }> {
  const res = await req(api.POST("/v1/refunds/{id}/receipt/send", { params: { path: { id: refundId } }, body: { ...mutation(opts), channel, ...(destination ? { destination } : {}) }, headers: headers(opts) }));
  return res as unknown as { data: ReceiptSend; warnings: string[] };
}

/* ---- Shifts and reports ------------------------------------------- */

export async function listShifts(api: PosApi, outletId: string, query: { status?: "open" | "closed"; station_id?: string; business_date?: string } = {}): Promise<Shift[]> {
  return (await req(api.GET("/v1/outlets/{id}/shifts", { params: { path: { id: outletId }, query } }))).data as unknown as Shift[];
}

/** The station comes from the PIN session; `float_counts` keeps the denomination count for the next open. */
export async function openShift(api: PosApi, input: { float_cents: number; float_counts?: Record<string, number> | null; name?: string | null }, opts?: MutationOpts): Promise<Shift> {
  return (await req(api.POST("/v1/shifts", { body: { ...mutation(opts), ...input }, headers: headers(opts) }))).data as unknown as Shift;
}

export async function closeShift(api: PosApi, shiftId: string, input: { counted_cash_cents: number; counted_counts?: Record<string, number> | null; variance_reason?: string | null; dry_run?: boolean }, opts?: MutationOpts): Promise<ShiftCloseResult> {
  const res = await req(api.POST("/v1/shifts/{id}/close", { params: { path: { id: shiftId } }, body: { ...mutation(opts), ...input }, headers: headers(opts) }));
  return res as unknown as ShiftCloseResult;
}

export async function getZReport(api: PosApi, outletId: string, query: { business_date?: string; station_id?: string } = {}): Promise<ZReport | ZReportWithheld> {
  return (await req(api.GET("/v1/outlets/{id}/z-report", { params: { path: { id: outletId }, query } }))).data as unknown as ZReport | ZReportWithheld;
}

export async function closeBusinessDay(api: PosApi, outletId: string, businessDate?: string, opts?: MutationOpts): Promise<{ id: string; business_date: string; closed_at: string; report: ZReport }> {
  return (await req(api.POST("/v1/outlets/{id}/business-days/close", { params: { path: { id: outletId } }, body: { ...mutation(opts), ...(businessDate ? { business_date: businessDate } : {}) }, headers: headers(opts) }))).data as unknown as { id: string; business_date: string; closed_at: string; report: ZReport };
}

/* ---- Printing ------------------------------------------------------- */

export async function listPrintJobs(api: PosApi, outletId: string, query: { late?: boolean; order_id?: string; status?: string; printer_id?: string; limit?: number } = {}): Promise<PrintJob[]> {
  const q: { late?: "true" | "false"; order_id?: string; status?: string; printer_id?: string; limit?: number } = {};
  if (query.late !== undefined) q.late = query.late ? "true" : "false";
  if (query.order_id) q.order_id = query.order_id;
  if (query.status) q.status = query.status;
  if (query.printer_id) q.printer_id = query.printer_id;
  if (query.limit) q.limit = query.limit;
  return (await req(api.GET("/v1/outlets/{id}/print-jobs", { params: { path: { id: outletId }, query: q } }))).data as unknown as PrintJob[];
}

/** Reroute waiting tickets; without `printer_id` each goes to its printer's configured backup. */
export async function rerouteJobs(api: PosApi, jobIds: string[], printerId?: string | null, opts?: MutationOpts): Promise<CreatedJob[]> {
  return (await req(api.POST("/v1/print-jobs/reroute", { body: { job_ids: jobIds, ...(printerId ? { printer_id: printerId } : {}) }, headers: headers(opts) }))).data as unknown as CreatedJob[];
}

export async function reprintJob(api: PosApi, jobId: string, opts?: MutationOpts): Promise<CreatedJob[]> {
  return (await req(api.POST("/v1/print-jobs/{id}/reprint", { params: { path: { id: jobId } }, body: {}, headers: headers(opts) }))).data as unknown as CreatedJob[];
}

export async function listPrinters(api: PosApi, outletId: string): Promise<Printer[]> {
  return ((await req(api.GET("/v1/printers", { params: { query: { outlet_id: outletId } } }))).data as unknown as Printer[]).filter((p) => !p.archived);
}

export async function listRelays(api: PosApi, outletId: string): Promise<Relay[]> {
  return ((await req(api.GET("/v1/relays", { params: { query: { outlet_id: outletId } } }))).data as unknown as Relay[]).filter((r) => !r.archived);
}

/* ---- Scan to Order on the POS --------------------------------- */

export async function listPendingRounds(api: PosApi, outletId: string): Promise<GuestRound[]> {
  return (await req(api.GET("/v1/outlets/{id}/rounds", { params: { path: { id: outletId }, query: { status: "pending" } } }))).data as unknown as GuestRound[];
}

export async function acceptRound(api: PosApi, roundId: string, opts?: MutationOpts): Promise<MutationResult> {
  return asResult(await req(api.POST("/v1/rounds/{id}/accept", { params: { path: { id: roundId } }, body: {}, headers: headers(opts) })));
}

export async function rejectRound(api: PosApi, roundId: string, reason: string, opts?: MutationOpts): Promise<MutationResult> {
  return asResult(await req(api.POST("/v1/rounds/{id}/reject", { params: { path: { id: roundId } }, body: { reason }, headers: headers(opts) })));
}

export async function listOpenServiceRequests(api: PosApi, outletId: string): Promise<ServiceRequest[]> {
  return (await req(api.GET("/v1/outlets/{id}/service-requests", { params: { path: { id: outletId }, query: { status: "open" } } }))).data as unknown as ServiceRequest[];
}

export async function acknowledgeServiceRequest(api: PosApi, requestId: string, opts?: MutationOpts): Promise<ServiceRequest> {
  return (await req(api.POST("/v1/service-requests/{id}/acknowledge", { params: { path: { id: requestId } }, body: {}, headers: headers(opts) }))).data as unknown as ServiceRequest;
}

/* ---- Sold out -------------------------------------------------------- */

export async function listStock(api: PosApi, outletId: string): Promise<StockEntry[]> {
  return (await req(api.GET("/v1/outlets/{id}/stock", { params: { path: { id: outletId } } }))).data as unknown as StockEntry[];
}

/** `until`: "today", "indefinite", or an ISO time. */
export async function markSoldOut(api: PosApi, outletId: string, productId: string, until: "today" | "indefinite" | string, opts?: MutationOpts): Promise<StockEntry> {
  return (await req(api.POST("/v1/stock/sold-out", { body: { outlet_id: outletId, product_id: productId, until }, headers: headers(opts) }))).data as unknown as StockEntry;
}

export async function restoreStock(api: PosApi, outletId: string, productId: string, opts?: MutationOpts): Promise<StockEntry> {
  return (await req(api.POST("/v1/stock/restore", { body: { outlet_id: outletId, product_id: productId }, headers: headers(opts) }))).data as unknown as StockEntry;
}

export async function setDailyCap(api: PosApi, outletId: string, productId: string, quantity: number | null, opts?: MutationOpts): Promise<StockEntry> {
  return (await req(api.POST("/v1/stock/daily-cap", { body: { outlet_id: outletId, product_id: productId, quantity }, headers: headers(opts) }))).data as unknown as StockEntry;
}
