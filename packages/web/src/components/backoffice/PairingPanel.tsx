"use client";

import { Button, InlineError, StatusDot, useLocale } from "@sail/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { keys } from "@/lib/query";
import { useEffect, useState } from "react";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { PairingCode, Station } from "@/lib/api/types";

function useCountdown(until: string | null): string | null {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!until) {
      setLeft(null);
      return;
    }
    const tick = () => setLeft(Math.max(0, Math.round((new Date(until).getTime() - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [until]);
  if (left === null) return null;
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

/** "Pair an iPad" ("Pair a screen" for a kitchen display): a one-time 6-digit code, shown large with its expiry, and the address to open. */
export function PairingPanel({ station: opened }: { station: Station }) {
  const { clock } = useLocale();
  const display = opened.kind === "display";
  const device = display ? "screen" : "iPad";
  const address = typeof window === "undefined" ? (display ? "/kds" : "/pos") : `${window.location.origin}${display ? "/kds" : "/pos"}`;
  const code = useMutation<PairingCode, ApiError>({
    mutationFn: () => req(api.POST("/v1/stations/{id}/pairing-code", { params: { path: { id: opened.id } }, body: {} })).then((r) => r.data),
  });
  const left = useCountdown(code.data?.expires_at ?? null);
  const expired = left === "0:00";
  // While a code is live the register is asked every 3 s, so the sheet says "Paired" as soon as the device pairs (E-N10).
  const live = useQuery({
    queryKey: keys.stations(opened.outlet_id),
    queryFn: () => req(api.GET("/v1/outlets/{id}/stations", { params: { path: { id: opened.outlet_id }, query: { include_archived: "true" } } })).then((r) => r.data),
    enabled: Boolean(code.data) && !expired,
    refetchInterval: 3000,
  });
  const station = live.data?.find((s) => s.id === opened.id) ?? opened;
  const pairedNow = Boolean(code.data) && station.paired && (!opened.paired || station.device_label !== opened.device_label);

  return (
    <div className="flex flex-col gap-4">
      {station.paired ? <StatusDot status="paid" label={station.device_label ? `Paired · ${station.device_label}` : "Paired"} /> : <StatusDot status="neutral" label="Not paired" muted />}
      {code.data && !expired && !pairedNow ? (
        <div className="flex flex-col items-start gap-2 rounded-tile bg-surface-2 px-5 py-4">
          <p className="text-caption text-ink-2">
            On the {device}, open <span className="font-mono text-ink">{address}</span> and enter this code
          </p>
          <p className="font-mono text-display text-ink tabular tracking-[0.18em]" aria-label={`Pairing code ${code.data.code.split("").join(" ")}`}>
            {code.data.code}
          </p>
          <p className="text-caption text-ink-2 tabular">
            Expires at {clock(code.data.expires_at)} · {left} left · one use only
          </p>
        </div>
      ) : null}
      {expired ? <p className="text-caption text-ink-2">That code expired. Issue a new one.</p> : null}
      <div>
        <Button onPress={() => code.mutate()} isPending={code.isPending} isDisabled={station.archived}>
          {code.data && !expired ? "Issue a new code" : station.paired ? `Pair another ${device}` : `Pair ${display ? "a screen" : "an iPad"}`}
        </Button>
      </div>
      <InlineError error={code.error} />
    </div>
  );
}
