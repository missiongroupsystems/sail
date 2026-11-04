"use client";

import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { findPosChannelLink, getFloor, getLayout, getMenu, getOrder, listManualRules, listOpenOrders, listOutlets, listStations, listVoidReasons } from "../api/register";
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
