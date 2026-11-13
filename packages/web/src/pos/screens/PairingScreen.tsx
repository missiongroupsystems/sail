"use client";

import { Button, cx, PinPad, SailLogo, TextField } from "@sail/ui";
import { useState } from "react";
import { toApiError, type ApiError } from "@/lib/api";
import { pairStation } from "../api/register";
import { useApi } from "../hooks/useApi";
import type { Station } from "../api/types";
import { useStationStore } from "../state/station";

export type PairingScreenProps = {
  /** What is being paired, in the copy: "iPad", or "screen" for a kitchen display. */
  device?: string;
  hint?: string;
  /** The station kind this device must pair with; the register refuses another kind before using the code. */
  kind?: Station["kind"];
  /** Where the token goes; the POS keeps it in its station store. The kitchen display passes its own. */
  onPaired?: (token: string, station: Station, label: string) => void;
};

/** First run: the 6-digit pairing code from the back office and a label for this iPad. */
export function PairingScreen({ device = "iPad", hint = "In the back office, open Settings › Stations, choose the station and tap “Pair an iPad”. Enter the 6 digits here.", kind, onPaired }: PairingScreenProps = {}) {
  const api = useApi();
  const setPaired = useStationStore((s) => s.setPaired);
  const [code, setCode] = useState("");
  const [label, setLabel] = useState(kind === "display" ? "Kitchen display" : device);
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);

  const pair = async () => {
    if (code.length !== 6 || !label.trim()) return;
    setPending(true);
    setError(null);
    try {
      const res = await pairStation(api, code, label.trim(), kind);
      (onPaired ?? setPaired)(res.station_token, res.station, label.trim());
    } catch (e) {
      // The code stays on the pad, so a slip can be corrected rather than typed again.
      setError(toApiError(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="flex h-dvh w-full items-center justify-center bg-bg px-8">
      <div className="grid w-full max-w-[880px] grid-cols-[1fr_auto] items-center gap-16">
        <section className="flex max-w-[420px] flex-col gap-6">
          <div>
            <SailLogo size="card" />
            <h1 className="mt-5 font-heading text-[26px] leading-tight font-semibold tracking-[-0.02em] text-ink">Pair this {device} to a station</h1>
            <p className="mt-2 text-[14.5px] text-ink-2">{hint}</p>
          </div>
          <TextField label={`Name for this ${device}`} value={label} onChange={setLabel} placeholder="Bar iPad" inputClassName="min-h-14 text-line" maxLength={80} />
          {/* The error once, in one line; the code card turns red. How to get a code is the line above. */}
          {error ? (
            <p role="alert" className="text-body text-status-alert">
              {error.message.replace(/([^.!?])$/, "$1.")}
            </p>
          ) : null}
          <Button variant="primary" size="lg" isDisabled={code.length !== 6 || !label.trim()} isPending={pending} onPress={pair} className="w-full data-[disabled]:bg-transparent!">
            Pair this {device}
          </Button>
        </section>
        <div className={cx("flex flex-col items-center gap-2 rounded-[20px] border bg-surface px-10 pt-9 pb-10 shadow-e2", error ? "border-status-alert" : "border-transparent")}>
          <p className="text-[14.5px] text-ink-2">Pairing code</p>
          <PinPad
            value={code}
            onChange={(v) => {
              setCode(v);
              setError(null);
            }}
            onComplete={() => void 0}
            unlockHint={false}
            error={error ? error.message : null}
            showErrorText={false}
          />
        </div>
      </div>
    </main>
  );
}
