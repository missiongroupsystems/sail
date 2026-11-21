"use client";

import { Button, InlineError, LocaleProvider } from "@sail/ui";
import { useEffect, useMemo, useRef } from "react";
import { idempotencyKey, toApiError } from "@/lib/api";
import { merchantLocale } from "@/lib/locale";
import { openOrder } from "../api/register";
import { useApplySnapshot, useChannelLink, useFloor, useLayout, useMenu, useMerchant, useOutlet, useStations } from "../hooks/queries";
import { useApi } from "../hooks/useApi";
import { useOutletStream } from "../hooks/useOutletStream";
import { useIdleLock, useWakeLock } from "../lib/device";
import { lockStation } from "../lib/lock";
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
    <LocaleProvider settings={merchantLocale(merchant.data.settings)}>
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

  // A station saved without a brand cannot open an order. Once the back office gives it one, the stations list
  // (refreshed by the outlet's stream, or by Check again) brings it here without a new sign-in.
  const noBrand = station.kind === "pos" && !station.brand_id;
  const fresh = stations.data?.find((s) => s.id === station.id);
  useEffect(() => {
    if (noBrand && fresh?.brand_id) useStationStore.getState().updateStation({ ...station, brand_id: fresh.brand_id });
  }, [noBrand, fresh?.brand_id, station]);

  useOutletStream(station.outlet_id, true, stationNames);
  useThemeScheduler(outlet.data?.service_theme_from);
  useWakeLock(true);
  // The timer follows the person's own input; locking ends the session on the register too, so background reads stop using it.
  const idle = useIdleLock(true, expiresInSeconds, () => void lockStation(api, "Locked after inactivity. Sign in to continue."));

  // A counter station opens on a new takeaway order, once per sign-in.
  const homed = useRef(false);
  useEffect(() => {
    if (homed.current || station.home !== "takeaway" || screen.kind !== "floor" || noBrand) return;
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
        useUiStore.getState().notify({ text: `Could not open a takeaway order: ${err.message}`, remedy: err.remedy ?? "Tap New order to try again.", tone: "alert" }, 8000);
        useNavStore.getState().go({ kind: "orders" });
      }
    })();
  }, [api, applySnapshot, screen.kind, station.home, noBrand]);

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
        {noBrand ? <NoBrandScreen checking={stations.isFetching} onCheck={() => void stations.refetch()} onLock={() => void lockStation(api, null)} /> : screen.kind === "floor" ? <FloorScreen /> : screen.kind === "orders" ? <OrdersScreen /> : screen.kind === "shift" ? <ShiftScreen /> : screen.kind === "bill" ? <BillScreen orderId={screen.orderId} /> : screen.kind === "pay" ? <PayScreen key={screen.checkId} orderId={screen.orderId} checkId={screen.checkId} /> : <OrderScreen orderId={screen.orderId} />}
      </div>
      <NoticeHost />
      <OverrideSheet />
      {idle.warning ? <IdleOverlay secondsLeft={idle.secondsLeft} onTouch={idle.touch} /> : null}
    </PosProvider>
  );
}

/** A POS station with no brand has no menu and cannot open an order: one message that says where to fix it, in place of the screens. */
function NoBrandScreen({ checking, onCheck, onLock }: { checking: boolean; onCheck: () => void; onLock: () => void }) {
  return (
    <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 px-8 text-center">
      <div className="flex max-w-[520px] flex-col gap-2">
        <h1 className="font-heading text-[26px] leading-tight font-semibold tracking-[-0.02em] text-ink">This station has no brand</h1>
        <p role="alert" className="text-[14.5px] text-ink-2">
          In the back office, open Settings › Stations and choose one.
        </p>
      </div>
      <div className="flex gap-3">
        <Button variant="secondary" size="lg" onPress={onLock}>
          Lock
        </Button>
        <Button variant="primary" size="lg" isPending={checking} onPress={onCheck}>
          Check again
        </Button>
      </div>
    </main>
  );
}
