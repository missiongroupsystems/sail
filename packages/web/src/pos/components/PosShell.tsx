"use client";

import { useEffect, useMemo, useRef } from "react";
import { idempotencyKey } from "@/lib/api";
import { openOrder } from "../api/register";
import { useApplySnapshot, useChannelLink, useFloor, useLayout, useMenu, useOutlet, useStations } from "../hooks/queries";
import { useApi } from "../hooks/useApi";
import { useOutletStream } from "../hooks/useOutletStream";
import { useIdleLock, useWakeLock } from "../lib/device";
import { layoutFromMenu } from "../lib/menu";
import { useThemeScheduler } from "../lib/theme";
import { useNavStore } from "../state/nav";
import { useSessionStore } from "../state/session";
import { useStationStore } from "../state/station";
import { useConnectionStore } from "../state/ui";
import { FloorScreen } from "../screens/FloorScreen";
import { OrderScreen } from "../screens/OrderScreen";
import { OrdersScreen } from "../screens/OrdersScreen";
import { ShiftScreen } from "../screens/ShiftScreen";
import { IdleOverlay } from "./IdleOverlay";
import { NoticeHost } from "./NoticeHost";
import { OverrideSheet } from "./OverrideSheet";
import { PosProvider, type PosContextValue } from "./PosContext";

/** The signed-in frame: reference data, the event store, theme schedule, wake lock and auto-lock around the current screen. */
export function PosShell() {
  const api = useApi();
  const station = useStationStore((s) => s.station)!;
  const staff = useSessionStore((s) => s.staff)!;
  const expiresInSeconds = useSessionStore((s) => s.expiresInSeconds);
  const lock = useSessionStore((s) => s.lock);
  const screen = useNavStore((s) => s.screen);
  const status = useConnectionStore((s) => s.status);
  const applySnapshot = useApplySnapshot();

  const outlet = useOutlet(station.outlet_id);
  const link = useChannelLink(station.outlet_id, station.brand_id);
  const menu = useMenu(link.data?.id);
  const layout = useLayout(station.layout_id);
  const floor = useFloor(station.outlet_id);
  const stations = useStations(station.outlet_id);

  const stationNames = useMemo(() => new Map((stations.data ?? []).map((s) => [s.id, s.name])), [stations.data]);
  const tablesById = useMemo(() => new Map((floor.data?.snapshot.tables ?? []).map((t) => [t.id, t])), [floor.data]);

  useOutletStream(station.outlet_id, true, stationNames);
  useThemeScheduler(outlet.data?.service_theme_from);
  useWakeLock(true);
  const idle = useIdleLock(true, expiresInSeconds, () => lock("Locked after inactivity. Sign in to continue."));

  // A counter station opens on a new takeaway order (design 3.1), once per sign-in.
  const homed = useRef(false);
  useEffect(() => {
    if (homed.current || station.home !== "takeaway" || screen.kind !== "floor") return;
    homed.current = true;
    void (async () => {
      try {
        const res = await openOrder(api, { order_id: idempotencyKey(), order_type: "takeaway" });
        applySnapshot(res.data);
        useNavStore.getState().openOrder(res.data.id, "orders");
      } catch {
        useNavStore.getState().go({ kind: "orders" });
      }
    })();
  }, [api, applySnapshot, screen.kind, station.home]);

  const value: PosContextValue = useMemo(
    () => ({
      station,
      staff,
      outlet: outlet.data ?? null,
      menu: menu.data,
      layout: layout.data ?? (menu.data && !station.layout_id ? layoutFromMenu(menu.data) : undefined),
      floor: floor.data?.snapshot,
      tablesById,
      stationNames,
      offline: status !== "online",
    }),
    [station, staff, outlet.data, menu.data, layout.data, floor.data, tablesById, stationNames, status],
  );

  return (
    <PosProvider value={value}>
      <div className="flex h-dvh w-full flex-col overflow-hidden bg-bg text-ink">
        {screen.kind === "floor" ? <FloorScreen /> : screen.kind === "orders" ? <OrdersScreen /> : screen.kind === "shift" ? <ShiftScreen /> : <OrderScreen orderId={screen.orderId} />}
      </div>
      <NoticeHost />
      <OverrideSheet />
      {idle.warning ? <IdleOverlay secondsLeft={idle.secondsLeft} onTouch={idle.touch} /> : null}
    </PosProvider>
  );
}
