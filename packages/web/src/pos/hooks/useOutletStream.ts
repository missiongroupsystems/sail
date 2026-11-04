"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { POS_API_URL } from "../api/client";
import { listEvents } from "../api/register";
import type { OrderSnapshot, OutletEvent } from "../api/types";
import { OutletStream } from "../events/stream";
import { useNavStore } from "../state/nav";
import { useSessionStore } from "../state/session";
import { useStationStore } from "../state/station";
import { useConnectionStore, useUiStore } from "../state/ui";
import { posKeys } from "./queries";
import { currentToken, posApi } from "./useApi";

const ORDER_TYPES = new Set(["order", "order_line"]);
const FLOOR_KINDS = new Set(["table", "area"]);
const MENU_KINDS = new Set(["product", "menu", "modifier_group", "stock", "availability_rule", "channel_link"]);

/**
 * The outlet event store (design 11.1): one SSE stream per station that patches
 * TanStack Query caches. Orders you have open are refetched; the floor and the
 * orders list refresh; a one-line note says when another station changed the
 * order on screen.
 */
export function useOutletStream(outletId: string | null, enabled: boolean, stationNames: Map<string, string>) {
  const qc = useQueryClient();
  const names = useRef(stationNames);
  names.current = stationNames;

  useEffect(() => {
    if (!outletId || !enabled) return;
    const api = posApi();
    const myStation = useStationStore.getState().station?.id ?? null;

    const apply = (events: OutletEvent[]) => {
      const touchedOrders = new Map<string, OutletEvent>();
      let floor = false;
      let menu = false;
      let layout = false;
      for (const e of events) {
        const kind = e.aggregate.kind;
        if (ORDER_TYPES.has(kind) || e.type.startsWith("order.") || e.type.startsWith("line.") || e.type.startsWith("adjustment.")) {
          touchedOrders.set(e.aggregate.id, e);
          floor = true;
        } else if (FLOOR_KINDS.has(kind)) floor = true;
        else if (MENU_KINDS.has(kind) || e.type.startsWith("stock.") || e.type.startsWith("product.") || e.type.startsWith("menu.")) menu = true;
        else if (kind === "layout") layout = true;
        else if (kind === "station") void qc.invalidateQueries({ queryKey: posKeys.stations(outletId) });
      }
      const openId = (() => {
        const s = useNavStore.getState().screen;
        return s.kind === "order" ? s.orderId : null;
      })();
      const me = useSessionStore.getState().staff?.id ?? null;
      for (const [orderId, e] of touchedOrders) {
        const cached = qc.getQueryData<OrderSnapshot>(posKeys.order(orderId));
        const fromUs = e.actor.station_id === myStation || (me !== null && e.actor.principal_id === me);
        if (cached && (!fromUs || e.aggregate.version > cached.version)) {
          void qc.invalidateQueries({ queryKey: posKeys.order(orderId) });
          if (orderId === openId && !fromUs && e.aggregate.version > cached.version) {
            const from = e.actor.station_id ? (names.current.get(e.actor.station_id) ?? "another station") : e.actor.principal_type === "guest" ? "a QR order" : (e.actor.name ?? "another station");
            useUiStore.getState().notify({ text: `Updated from ${from}`, tone: "info", orderId }, 5000);
          }
        }
      }
      if (floor) {
        void qc.invalidateQueries({ queryKey: posKeys.floor(outletId) });
        void qc.invalidateQueries({ queryKey: posKeys.orders(outletId) });
      }
      if (menu) void qc.invalidateQueries({ queryKey: ["pos", "menu"] });
      if (layout) void qc.invalidateQueries({ queryKey: ["pos", "layout"] });
    };

    const stream = new OutletStream({
      baseUrl: POS_API_URL,
      outletId,
      getToken: currentToken,
      fetchEvents: (after) => listEvents(api, outletId, after),
      onEvents: apply,
      onStatus: (status, asOf) => useConnectionStore.getState().set(status, asOf),
      onConnected: (first) => {
        // Anything that happened while we were away: the views refresh from the register.
        if (!first) {
          void qc.invalidateQueries({ queryKey: posKeys.floor(outletId) });
          void qc.invalidateQueries({ queryKey: posKeys.orders(outletId) });
          void qc.invalidateQueries({ queryKey: ["pos", "order"] });
        }
      },
    });
    stream.start();
    return () => stream.stop();
  }, [outletId, enabled, qc]);
}
