"use client";

import { deviceLocale, deviceTimeZone, LocaleProvider, type LocaleSettings } from "@sail/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ApiError } from "@/lib/api";
import { merchantLocale } from "@/lib/locale";
import { PosShell } from "./components/PosShell";
import { useMerchant } from "./hooks/queries";
import { LockScreen } from "./screens/LockScreen";
import { PairingScreen } from "./screens/PairingScreen";
import { useSessionStore } from "./state/session";
import { useStationStore } from "./state/station";

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        // The event store refreshes on visibility; focus refetches would only add load during service.
        refetchOnWindowFocus: false,
        retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
      },
      mutations: { retry: false },
    },
  });
}

/**
 * The station app: one long-lived, client-rendered page.
 * Pairing → lock screen → the signed-in shell with Floor, Orders, Shift and
 * the order screen, all routed in memory.
 */
export default function PosApp() {
  const [client] = useState(makeClient);
  const stationToken = useStationStore((s) => s.token);
  const sessionToken = useSessionStore((s) => s.token);
  return (
    <QueryClientProvider client={client}>
      {/* An unpaired iPad cannot read the merchant's settings, so pairing uses the iPad's own locale and zone. */}
      <LocaleProvider settings={DEVICE_LOCALE}>
        {!stationToken ? (
          <PairingScreen kind="pos" />
        ) : !sessionToken ? (
          <StationLocale>
            <LockScreen />
          </StationLocale>
        ) : (
          <PosShell key={sessionToken} />
        )}
      </LocaleProvider>
    </QueryClientProvider>
  );
}

const DEVICE_LOCALE: LocaleSettings = { currency: null, currencyExponent: null, locale: deviceLocale(), timeZone: deviceTimeZone() };

/** A paired station reads the merchant's settings before sign-in, so the lock screen's clock shows the outlet's time; the iPad's own until they arrive. */
function StationLocale({ children }: { children: ReactNode }) {
  const merchant = useMerchant();
  return <LocaleProvider settings={merchant.data ? merchantLocale(merchant.data.settings) : DEVICE_LOCALE}>{children}</LocaleProvider>;
}
