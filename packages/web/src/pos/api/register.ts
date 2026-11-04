import { idempotencyKey, req } from "@/lib/api";
import type { PosApi } from "./client";
import type {
  ChannelLink,
  CompiledMenu,
  Customer,
  EventsPage,
  FloorSnapshot,
  Layout,
  ManualRule,
  MutationResult,
  OrderSnapshot,
  OrderType,
  Outlet,
  OverrideAction,
  OverrideGrant,
  SessionStart,
  Station,
  VoidReason,
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

export async function pairStation(api: PosApi, code: string, deviceLabel: string): Promise<{ station_token: string; station: Station }> {
  const res = await req(api.POST("/v1/stations/pair", { body: { code, device_label: deviceLabel }, headers: headers() }));
  return { station_token: res.data.station_token, station: res.data.station as unknown as Station };
}

export async function startSession(api: PosApi, pin: string): Promise<SessionStart> {
  const res = await req(api.POST("/v1/stations/sessions", { body: { pin }, headers: headers() }));
  return res.data as unknown as SessionStart;
}

export async function endSession(api: PosApi): Promise<void> {
  await req(api.POST("/v1/stations/sessions/end", { body: {}, headers: headers() }));
}

export async function getMe(api: PosApi) {
  return (await req(api.GET("/v1/me"))).data;
}

/* ---- Reference data ------------------------------------------------------ */

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
 * badge (design 4.3). Reads every version and keeps the active one per rule
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

export type LinePatch = { quantity?: number; notes?: string | null; seat_no?: number | null; hold?: boolean; modifiers?: { group_id: string; product_id: string; quantity?: number }[] };

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

export async function grantOverride(api: PosApi, input: { action: OverrideAction; target_kind: "order" | "order_line"; target_id: string; approver_pin: string }): Promise<OverrideGrant> {
  const res = await req(api.POST("/v1/overrides", { body: input, headers: headers() }));
  return res.data as unknown as OverrideGrant;
}
