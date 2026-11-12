"use client";

import { deviceLocale, deviceTimeZone, LocaleProvider } from "@sail/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError } from "@/lib/api";
import { PosShell } from "./components/PosShell";
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
 * The station app (design 3.1, 11.1): one long-lived, client-rendered page.
 * Pairing → lock screen → the signed-in shell with Floor, Orders, Shift and
 * the order screen, all routed in memory.
 */
export default function PosApp() {
  const [client] = useState(makeClient);
  const stationToken = useStationStore((s) => s.token);
  const sessionToken = useSessionStore((s) => s.token);
  return (
    <QueryClientProvider client={client}>
      {/* Before sign-in the station may not read the merchant's settings: the lock screen's clock uses the iPad's own. */}
      <LocaleProvider settings={{ currency: null, locale: deviceLocale(), timeZone: deviceTimeZone() }}>
        {!stationToken ? <PairingScreen /> : !sessionToken ? <LockScreen /> : <PosShell key={sessionToken} />}
      </LocaleProvider>
    </QueryClientProvider>
  );
}
