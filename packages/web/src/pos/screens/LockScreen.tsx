"use client";

import { Button, PinPad, SailLogo, useLocale } from "@sail/ui";
import { useCallback, useEffect, useState } from "react";
import { toApiError } from "@/lib/api";
import { startSession, unpairStation } from "../api/register";
import { useChannelLink, useLayout, useMenu } from "../hooks/queries";
import { useApi } from "../hooks/useApi";
import { useNow } from "../lib/device";
import { useSessionStore } from "../state/session";
import { useStationStore } from "../state/station";
import { GREY_PILL } from "../components/styles";

/**
 * The lock screen: outlet and station, a clock, a big PIN pad that
 * unlocks on the 6th digit. Wrong PIN shakes; a lockout shows the register's
 * countdown. The menu and layout load here so the floor is instant after sign-in.
 */
export function LockScreen() {
  const { clock, businessDay, isoDate } = useLocale();
  const api = useApi();
  const station = useStationStore((s) => s.station)!;
  const unpair = useStationStore((s) => s.unpair);
  const updateStation = useStationStore((s) => s.updateStation);
  const signIn = useSessionStore((s) => s.signIn);
  const lockNote = useSessionStore((s) => s.lockNote);
  const now = useNow(1000);

  // Warm the caches while locked (cold start to the floor ≤ 3 s).
  const link = useChannelLink(station.outlet_id, station.brand_id);
  const menu = useMenu(link.data?.id);
  useLayout(station.layout_id);

  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmUnpair, setConfirmUnpair] = useState(false);
  const [unpairing, setUnpairing] = useState(false);
  const [unpairError, setUnpairError] = useState<string | null>(null);
  // The register ends the pairing first; only then does this iPad forget it. Offline, nothing changes and it says so.
  const doUnpair = async () => {
    setUnpairing(true);
    setUnpairError(null);
    try {
      await unpairStation(api);
      unpair();
    } catch (e) {
      const err = toApiError(e);
      if (err.code === "unauthenticated") unpair();
      else setUnpairError(err.status === 0 ? "This iPad is offline, so it is still paired. Unpair it once it is back online." : err.remedy ? `${err.message}. ${err.remedy}` : err.message);
    } finally {
      setUnpairing(false);
    }
  };
  const lockedFor = lockedUntil ? Math.max(0, Math.ceil((lockedUntil - now) / 1000)) : 0;
  // The lockout's message goes with the lock: once the countdown ends, the pad is clear to try again (live-test A-11).
  useEffect(() => {
    if (lockedUntil && lockedFor === 0) {
      setLockedUntil(null);
      setError(null);
    }
  }, [lockedUntil, lockedFor]);

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
          setError("Too many wrong PINs.");
        } else if (err.code === "unauthenticated") setError(err.message || "PIN not recognised");
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
      <div className="grid w-full max-w-[880px] grid-cols-[1fr_auto] items-center gap-16">
        <section className="flex flex-col">
          <SailLogo size="card" />
          <h1 className="mt-5 font-heading text-[30px] leading-tight font-semibold tracking-[-0.02em] text-ink">{outletName || "Station locked"}</h1>
          <p className="mt-1 text-[16px] text-ink-2">{station.name}</p>
          <p className="mt-7 font-heading text-[56px] leading-none font-semibold tracking-[-0.02em] tabular text-ink">{clock(new Date(now))}</p>
          <p className="mt-2 text-[14.5px] text-ink-2">{/* Today in the outlet's zone, written as every other date on the till ("Fri, 13 Nov 2026"). */}
            {businessDay(isoDate(new Date(now)))}</p>
          {lockNote ? <p className="mt-6 text-body text-ink-2">{lockNote}</p> : null}
          {/* Unpairing stops this iPad working as the station until a new code is entered, so one tap only asks. */}
          {confirmUnpair ? (
            <div className="mt-8 flex max-w-[400px] flex-col gap-3 rounded-tile border border-rule bg-surface p-4" role="group" aria-label="Pair this iPad again">
              <p className="text-body text-ink">This iPad stops working as {station.name} until it is paired again with a new code from the back office.</p>
              {unpairError ? <p role="alert" className="text-body text-status-alert">{unpairError}</p> : null}
              <div className="flex flex-wrap gap-2">
                <Button variant="destructive" size="lg" isPending={unpairing} onPress={() => void doUnpair()}>
                  Unpair this iPad
                </Button>
                <Button variant="quiet" size="lg" isDisabled={unpairing} onPress={() => { setConfirmUnpair(false); setUnpairError(null); }} className={GREY_PILL}>
                  Keep this iPad paired
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-8">
              <Button variant="secondary" size="lg" onPress={() => setConfirmUnpair(true)}>
                Pair this iPad again
              </Button>
            </div>
          )}
        </section>
        <div className="flex flex-col items-center gap-2 rounded-[20px] bg-surface px-10 pt-9 pb-10 shadow-e2">
          <p className="text-[14.5px] text-ink-2">Enter your PIN</p>
          <PinPad value={pin} onChange={setPin} onComplete={complete} error={error} lockedForSeconds={lockedFor || null} isPending={pending} />
        </div>
      </div>
    </main>
  );
}
