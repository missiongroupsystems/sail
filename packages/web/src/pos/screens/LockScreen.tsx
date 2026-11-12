"use client";

import { Button, PinPad, useLocale } from "@sail/ui";
import { useCallback, useState } from "react";
import { toApiError } from "@/lib/api";
import { startSession } from "../api/register";
import { useChannelLink, useLayout, useMenu } from "../hooks/queries";
import { useApi } from "../hooks/useApi";
import { useNow } from "../lib/device";
import { useSessionStore } from "../state/session";
import { useStationStore } from "../state/station";

/**
 * The lock screen (design 4.1): outlet and station, a clock, a big PIN pad that
 * unlocks on the 6th digit. Wrong PIN shakes; a lockout shows the register's
 * countdown. The menu and layout load here so the floor is instant after sign-in.
 */
export function LockScreen() {
  const { clock } = useLocale();
  const api = useApi();
  const station = useStationStore((s) => s.station)!;
  const unpair = useStationStore((s) => s.unpair);
  const updateStation = useStationStore((s) => s.updateStation);
  const signIn = useSessionStore((s) => s.signIn);
  const lockNote = useSessionStore((s) => s.lockNote);
  const now = useNow(1000);

  // Warm the caches while locked (design 5.2: cold start to the floor ≤ 3 s).
  const link = useChannelLink(station.outlet_id, station.brand_id);
  const menu = useMenu(link.data?.id);
  useLayout(station.layout_id);

  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const lockedFor = lockedUntil ? Math.max(0, Math.ceil((lockedUntil - now) / 1000)) : 0;

  const complete = useCallback(
    async (value: string) => {
      setPending(true);
      setError(null);
      try {
        const s = await startSession(api, value);
        updateStation(s.station);
        signIn(s.session_token, s.staff, s.expires_in_seconds);
      } catch (e) {
        const err = toApiError(e);
        if (err.code === "rate_limited") {
          const secs = Number(err.details?.retry_after_seconds ?? 30);
          setLockedUntil(Date.now() + secs * 1000);
          setError("Too many wrong PINs");
        } else if (err.code === "unauthenticated") setError("PIN not recognised");
        else setError(err.remedy ? `${err.message}. ${err.remedy}` : err.message);
        setPin("");
      } finally {
        setPending(false);
      }
    },
    [api, signIn, updateStation],
  );

  const outletName = menu.data?.outlet.name ?? "";

  return (
    <main className="flex h-dvh w-full items-center justify-center bg-bg px-8">
      <div className="grid w-full max-w-[960px] grid-cols-[1fr_auto] items-center gap-16">
        <section className="flex flex-col gap-2">
          <p className="text-caption text-ink-2 uppercase tracking-[0.04em]">Sail</p>
          <h1 className="text-title text-ink">{outletName || "Station locked"}</h1>
          <p className="text-heading text-ink-2">{station.name}</p>
          <p className="mt-8 text-display tabular text-ink">{clock(new Date(now))}</p>
          {lockNote ? <p className="mt-4 text-body text-ink-2">{lockNote}</p> : null}
          <div className="mt-10">
            <Button variant="quiet" size="md" onPress={unpair} className="-ml-4 text-ink-2">
              Pair this iPad again
            </Button>
          </div>
        </section>
        <PinPad value={pin} onChange={setPin} onComplete={complete} error={error} lockedForSeconds={lockedFor || null} isPending={pending} />
      </div>
    </main>
  );
}
