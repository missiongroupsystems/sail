"use client";

import { Button, InlineError, PinPad, TextField } from "@sail/ui";
import { useState } from "react";
import { toApiError, type ApiError } from "@/lib/api";
import { pairStation } from "../api/register";
import { useApi } from "../hooks/useApi";
import { useStationStore } from "../state/station";

/** First run: the 6-digit pairing code from the back office and a label for this iPad. */
export function PairingScreen() {
  const api = useApi();
  const setPaired = useStationStore((s) => s.setPaired);
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("iPad");
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);

  const pair = async () => {
    if (code.length !== 6 || !label.trim()) return;
    setPending(true);
    setError(null);
    try {
      const res = await pairStation(api, code, label.trim());
      setPaired(res.station_token, res.station, label.trim());
    } catch (e) {
      setError(toApiError(e));
      setCode("");
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="flex h-dvh w-full items-center justify-center bg-bg px-8">
      <div className="grid w-full max-w-[880px] grid-cols-[1fr_auto] items-center gap-16">
        <section className="flex flex-col gap-6">
          <div>
            <p className="text-caption text-ink-2 uppercase tracking-[0.04em]">Sail</p>
            <h1 className="text-title text-ink">Pair this iPad to a station</h1>
            <p className="mt-2 text-body text-ink-2">In the back office, open Settings › Stations, choose the station and tap “Pair an iPad”. Enter the 6 digits here.</p>
          </div>
          <TextField label="Name for this iPad" value={label} onChange={setLabel} placeholder="Bar iPad" inputClassName="min-h-14 text-line" maxLength={80} />
          <InlineError error={error} />
          <Button variant="primary" size="lg" isDisabled={code.length !== 6 || !label.trim()} isPending={pending} onPress={pair} className="self-start min-w-[220px]">
            Pair this iPad
          </Button>
        </section>
        <PinPad value={code} onChange={setCode} onComplete={() => void 0} unlockHint={false} error={null} />
      </div>
    </main>
  );
}
