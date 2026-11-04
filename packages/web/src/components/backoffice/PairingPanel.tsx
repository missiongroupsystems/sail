"use client";

import { Button, InlineError, StatusDot } from "@sail/ui";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { PairingCode, Station } from "@/lib/api/types";
import { formatClock } from "@/lib/format";

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

/** "Pair an iPad": a one-time 6-digit code, shown large (design 7.4 display style) with its expiry. */
export function PairingPanel({ station }: { station: Station }) {
  const code = useMutation<PairingCode, ApiError>({
    mutationFn: () => req(api.POST("/v1/stations/{id}/pairing-code", { params: { path: { id: station.id } }, body: {} })).then((r) => r.data),
  });
  const left = useCountdown(code.data?.expires_at ?? null);
  const expired = left === "0:00";

  return (
    <div className="flex flex-col gap-4">
      {station.paired ? <StatusDot status="paid" label={station.device_label ? `Paired · ${station.device_label}` : "Paired"} /> : <StatusDot status="neutral" label="Not paired" muted />}
      {code.data && !expired ? (
        <div className="flex flex-col items-start gap-2 rounded-tile bg-surface-2 px-5 py-4">
          <p className="text-caption text-ink-2">On the iPad, open Sail and enter this code</p>
          <p className="font-mono text-display text-ink tabular tracking-[0.18em]" aria-label={`Pairing code ${code.data.code.split("").join(" ")}`}>
            {code.data.code}
          </p>
          <p className="text-caption text-ink-2 tabular">
            Expires at {formatClock(code.data.expires_at)} · {left} left · one use only
          </p>
        </div>
      ) : null}
      {expired ? <p className="text-caption text-ink-2">That code expired. Issue a new one.</p> : null}
      <div>
        <Button onPress={() => code.mutate()} isPending={code.isPending} isDisabled={station.archived}>
          {code.data && !expired ? "Issue a new code" : station.paired ? "Pair another iPad" : "Pair an iPad"}
        </Button>
      </div>
      <InlineError error={code.error} />
    </div>
  );
}
