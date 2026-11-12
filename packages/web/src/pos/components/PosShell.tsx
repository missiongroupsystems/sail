"use client";

import { Button, deviceLocale, InlineError, LocaleProvider, localeSettings } from "@sail/ui";
import { useEffect, useMemo, useRef } from "react";
import { idempotencyKey, toApiError } from "@/lib/api";
import { openOrder } from "../api/register";
import { useApplySnapshot, useChannelLink, useFloor, useLayout, useMenu, useMerchant, useOutlet, useStations } from "../hooks/queries";
import { useApi } from "../hooks/useApi";
import { useOutletStream } from "../hooks/useOutletStream";
import { useIdleLock, useWakeLock } from "../lib/device";
import { layoutFromMenu } from "../lib/menu";
import { useThemeScheduler } from "../lib/theme";
import { useNavStore } from "../state/nav";
import { useSessionStore } from "../state/session";
import { useStationStore } from "../state/station";
import { useConnectionStore, useUiStore } from "../state/ui";
import { BillScreen } from "../screens/BillScreen";
import { FloorScreen } from "../screens/FloorScreen";
import { OrderScreen } from "../screens/OrderScreen";
import { OrdersScreen } from "../screens/OrdersScreen";
import { PayScreen } from "../screens/PayScreen";
import { ShiftScreen } from "../screens/ShiftScreen";
import { IdleOverlay } from "./IdleOverlay";
import { NoticeHost } from "./NoticeHost";
import { OverrideSheet } from "./OverrideSheet";
import { PosProvider, type PosContextValue } from "./PosContext";

/** Signed in: every figure on the station follows the merchant's currency, locale and zone, so the shell waits for them. */
export function PosShell() {
  const merchant = useMerchant();
  if (!merchant.data) {
    return (
      <main className="flex h-dvh w-full flex-col items-center justify-center gap-4 bg-bg px-8">
        {merchant.error ? (
          <>
            <InlineError error={merchant.error} />
            <Button variant="primary" size="lg" onPress={() => void merchant.refetch()}>
              Try again
            </Button>
          </>
        ) : null}
      </main>
    );
  }
  return (
    <LocaleProvider settings={localeSettings(merchant.data.settings, deviceLocale())}>
      <SignedInShell />
    </LocaleProvider>
  );
}

/** The signed-in frame: reference data, the event store, theme schedule, wake lock and auto-lock around the current screen. */
function SignedInShell() {
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
        const orderId = idempotencyKey();
        const res = await openOrder(api, { order_id: orderId, order_type: "takeaway" }, { key: orderId });
        applySnapshot(res.data);
        useNavStore.getState().openOrder(res.data.id, "orders");
      } catch (e) {
        // The station still opens, on Orders, with the register's reason in one line.
        const err = toApiError(e);
        useUiStore.getState().notify({ text: `Could not open a takeaway order: ${err.message}`, remedy: err.remedy ?? "Tap + New order to try again.", tone: "alert" }, 8000);
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
        {screen.kind === "floor" ? <FloorScreen /> : screen.kind === "orders" ? <OrdersScreen /> : screen.kind === "shift" ? <ShiftScreen /> : screen.kind === "bill" ? <BillScreen orderId={screen.orderId} /> : screen.kind === "pay" ? <PayScreen key={screen.checkId} orderId={screen.orderId} checkId={screen.checkId} /> : <OrderScreen orderId={screen.orderId} />}
      </div>
      <NoticeHost />
      <OverrideSheet />
      {idle.warning ? <IdleOverlay secondsLeft={idle.secondsLeft} onTouch={idle.touch} /> : null}
    </PosProvider>
  );
}
