"use client";

import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  findPosChannelLink,
  getFloor,
  getLayout,
  getMenu,
  getOrder,
  getZReport,
  listManualRules,
  listOpenOrders,
  listOpenServiceRequests,
  listOutlets,
  listPendingRounds,
  listPrinters,
  listPrintJobs,
  listRefunds,
  listRelays,
  listShifts,
  listStations,
  listStock,
  listTenderTypes,
  listTodaysOrders,
  listVoidReasons,
} from "../api/register";
import type { FloorSnapshot, OrderSnapshot } from "../api/types";
import { useApi } from "./useApi";

/** Query keys, by resource. The event store invalidates by these. */
export const posKeys = {
  all: ["pos"] as const,
  outlets: ["pos", "outlets"] as const,
  stations: (outletId: string) => ["pos", "stations", outletId] as const,
  channelLink: (outletId: string, brandId: string | null) => ["pos", "channel-link", outletId, brandId] as const,
  menu: (linkId: string) => ["pos", "menu", linkId] as const,
  layout: (layoutId: string) => ["pos", "layout", layoutId] as const,
  floor: (outletId: string) => ["pos", "floor", outletId] as const,
  orders: (outletId: string) => ["pos", "orders", outletId] as const,
  order: (orderId: string) => ["pos", "order", orderId] as const,
  rules: ["pos", "pricing-rules"] as const,
  voidReasons: ["pos", "void-reasons"] as const,
  tenderTypes: (outletId: string) => ["pos", "tender-types", outletId] as const,
  todaysOrders: (outletId: string, businessDate: string) => ["pos", "orders-today", outletId, businessDate] as const,
  refunds: (orderId: string) => ["pos", "refunds", orderId] as const,
  shifts: (outletId: string, status: "open" | "closed") => ["pos", "shifts", outletId, status] as const,
  zReport: (outletId: string, stationId: string | null, businessDate: string | null) => ["pos", "z-report", outletId, stationId, businessDate] as const,
  lateJobs: (outletId: string) => ["pos", "print-jobs", outletId, "late"] as const,
  orderJobs: (outletId: string, orderId: string) => ["pos", "print-jobs", outletId, "order", orderId] as const,
  recentJobs: (outletId: string) => ["pos", "print-jobs", outletId, "recent"] as const,
  printers: (outletId: string) => ["pos", "printers", outletId] as const,
  relays: (outletId: string) => ["pos", "relays", outletId] as const,
  rounds: (outletId: string) => ["pos", "rounds", outletId] as const,
  requests: (outletId: string) => ["pos", "service-requests", outletId] as const,
  stock: (outletId: string) => ["pos", "stock", outletId] as const,
};

export function useOutlet(outletId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: posKeys.outlets,
    queryFn: () => listOutlets(api),
    enabled: Boolean(outletId),
    staleTime: 10 * 60_000,
    select: (outlets) => outlets.find((o) => o.id === outletId) ?? null,
  });
}

export function useStations(outletId: string | null) {
  const api = useApi();
  return useQuery({ queryKey: posKeys.stations(outletId ?? ""), queryFn: () => listStations(api, outletId!), enabled: Boolean(outletId), staleTime: 10 * 60_000 });
}

export function useChannelLink(outletId: string | null, brandId: string | null) {
  const api = useApi();
  return useQuery({ queryKey: posKeys.channelLink(outletId ?? "", brandId), queryFn: () => findPosChannelLink(api, outletId!, brandId), enabled: Boolean(outletId), staleTime: 10 * 60_000 });
}

/** The compiled menu for the station's channel link: cached by `version`, refreshed when the register says the menu changed. */
export function useMenu(linkId: string | null | undefined) {
  const api = useApi();
  return useQuery({ queryKey: posKeys.menu(linkId ?? ""), queryFn: () => getMenu(api, linkId!), enabled: Boolean(linkId), staleTime: 60_000 });
}

export function useLayout(layoutId: string | null | undefined) {
  const api = useApi();
  return useQuery({ queryKey: posKeys.layout(layoutId ?? ""), queryFn: () => getLayout(api, layoutId!), enabled: Boolean(layoutId), staleTime: 10 * 60_000 });
}

export type FloorData = { snapshot: FloorSnapshot; receivedAt: number };

export function useFloor(outletId: string | null) {
  const api = useApi();
  return useQuery<FloorData>({
    queryKey: posKeys.floor(outletId ?? ""),
    queryFn: async () => ({ snapshot: await getFloor(api, outletId!), receivedAt: Date.now() }),
    enabled: Boolean(outletId),
    staleTime: 5_000,
    refetchInterval: 60_000,
  });
}

export function useOpenOrders(outletId: string | null) {
  const api = useApi();
  return useQuery({ queryKey: posKeys.orders(outletId ?? ""), queryFn: () => listOpenOrders(api, outletId!), enabled: Boolean(outletId), staleTime: 5_000, refetchInterval: 60_000 });
}

export function useOrder(orderId: string | null) {
  const api = useApi();
  return useQuery<OrderSnapshot>({ queryKey: posKeys.order(orderId ?? ""), queryFn: () => getOrder(api, orderId!), enabled: Boolean(orderId), staleTime: 5_000 });
}

export function useManualRules() {
  const api = useApi();
  return useQuery({ queryKey: posKeys.rules, queryFn: () => listManualRules(api), staleTime: 5 * 60_000 });
}

export function useVoidReasons() {
  const api = useApi();
  return useQuery({ queryKey: posKeys.voidReasons, queryFn: () => listVoidReasons(api), staleTime: 10 * 60_000, select: (rs) => rs.filter((r) => !r.archived) });
}

/** Put a register snapshot into the cache (after a mutation) and refresh the views that summarise it. */
export function applySnapshot(qc: QueryClient, snapshot: OrderSnapshot) {
  qc.setQueryData<OrderSnapshot>(posKeys.order(snapshot.id), snapshot);
  void qc.invalidateQueries({ queryKey: posKeys.floor(snapshot.outlet_id) });
  void qc.invalidateQueries({ queryKey: posKeys.orders(snapshot.outlet_id) });
}

export function useApplySnapshot() {
  const qc = useQueryClient();
  return (snapshot: OrderSnapshot) => applySnapshot(qc, snapshot);
}

/* ---- v0.6/v0.7/v0.8 reads: bills, shifts, printing, Scan to Order ------------------ */

export function useTenderTypes(outletId: string | null) {
  const api = useApi();
  return useQuery({ queryKey: posKeys.tenderTypes(outletId ?? ""), queryFn: () => listTenderTypes(api, outletId), enabled: Boolean(outletId), staleTime: 10 * 60_000 });
}

/** Today's business date for the Orders screen's closed list, in the outlet's zone. The register decides the real cutoff; this only names the day. */
export function todayBusinessDate(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export function useTodaysOrders(outletId: string | null, enabled = true) {
  const api = useApi();
  const date = todayBusinessDate();
  return useQuery({ queryKey: posKeys.todaysOrders(outletId ?? "", date), queryFn: () => listTodaysOrders(api, outletId!, date), enabled: Boolean(outletId) && enabled, staleTime: 10_000 });
}

export function useOrderRefunds(orderId: string | null, enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: posKeys.refunds(orderId ?? ""), queryFn: () => listRefunds(api, orderId!), enabled: Boolean(orderId) && enabled, staleTime: 10_000 });
}

export function useShifts(outletId: string | null, status: "open" | "closed") {
  const api = useApi();
  return useQuery({ queryKey: posKeys.shifts(outletId ?? "", status), queryFn: () => listShifts(api, outletId!, { status }), enabled: Boolean(outletId), staleTime: 10_000 });
}

export function useZReport(outletId: string | null, stationId: string | null, businessDate: string | null, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: posKeys.zReport(outletId ?? "", stationId, businessDate),
    queryFn: () => getZReport(api, outletId!, { ...(stationId ? { station_id: stationId } : {}), ...(businessDate ? { business_date: businessDate } : {}) }),
    enabled: Boolean(outletId) && enabled,
    staleTime: 5_000,
  });
}

/** Jobs not printed within 10 s. Polls every 10 s while any are late; otherwise waits for `job` stream events. */
export function useLateJobs(outletId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: posKeys.lateJobs(outletId ?? ""),
    queryFn: () => listPrintJobs(api, outletId!, { late: true }),
    enabled: Boolean(outletId),
    staleTime: 3_000,
    refetchInterval: (q) => ((q.state.data?.length ?? 0) > 0 ? 10_000 : 30_000),
  });
}

export function useOrderPrintJobs(outletId: string | null, orderId: string | null, enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: posKeys.orderJobs(outletId ?? "", orderId ?? ""), queryFn: () => listPrintJobs(api, outletId!, { order_id: orderId! }), enabled: Boolean(outletId && orderId) && enabled, staleTime: 5_000 });
}

export function useRecentPrintJobs(outletId: string | null, enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: posKeys.recentJobs(outletId ?? ""), queryFn: () => listPrintJobs(api, outletId!, { limit: 40 }), enabled: Boolean(outletId) && enabled, staleTime: 5_000 });
}

export function usePrinters(outletId: string | null) {
  const api = useApi();
  return useQuery({ queryKey: posKeys.printers(outletId ?? ""), queryFn: () => listPrinters(api, outletId!), enabled: Boolean(outletId), staleTime: 5 * 60_000 });
}

export function useRelays(outletId: string | null, enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: posKeys.relays(outletId ?? ""), queryFn: () => listRelays(api, outletId!), enabled: Boolean(outletId) && enabled, staleTime: 15_000, refetchInterval: 60_000 });
}

export function usePendingRounds(outletId: string | null) {
  const api = useApi();
  return useQuery({ queryKey: posKeys.rounds(outletId ?? ""), queryFn: () => listPendingRounds(api, outletId!), enabled: Boolean(outletId), staleTime: 5_000, refetchInterval: 60_000 });
}

export function useOpenServiceRequests(outletId: string | null) {
  const api = useApi();
  return useQuery({ queryKey: posKeys.requests(outletId ?? ""), queryFn: () => listOpenServiceRequests(api, outletId!), enabled: Boolean(outletId), staleTime: 5_000, refetchInterval: 60_000 });
}

export function useStock(outletId: string | null, enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: posKeys.stock(outletId ?? ""), queryFn: () => listStock(api, outletId!), enabled: Boolean(outletId) && enabled, staleTime: 10_000 });
}
