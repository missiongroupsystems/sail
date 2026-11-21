"use client";

import { Button, InlineError, StatusDot, useLocale } from "@sail/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { keys } from "@/lib/query";
import { useEffect, useState } from "react";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { PairingCode, Station } from "@/lib/api/types";
import { useCan } from "@/lib/can";

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

/**
 * The codes this browser was shown and that can still pair, by station. Closing the station's sheet and opening it
 * again shows the same code: asking the register for another would end the one somebody is typing on the iPad.
 * `pairedAtBefore` is the station's last pairing when the code was issued, so a new pairing is known as new.
 */
type Shown = PairingCode & { issuedAt: string; pairedAtBefore: string | null };
const shown = new Map<string, Shown>();
const stillLive = (c: { expires_at: string } | null | undefined): boolean => Boolean(c && new Date(c.expires_at).getTime() > Date.now());

/** A live code issued elsewhere (another tab, before a reload): the register stores it hashed, so only its times are known. */
type Unseen = { issued_at: string; expires_at: string };

/** "Pair an iPad" ("Pair a screen" for a kitchen display): a one-time 6-digit code, shown large with its expiry, and the address to open. */
export function PairingPanel({ station: opened }: { station: Station }) {
  const { clock } = useLocale();
  // Pairing is an Admin's; the station sheet around it already says so (R new 1).
  const canPair = useCan("stations.pairing_code");
  const display = opened.kind === "display";
  const device = display ? "screen" : "iPad";
  const address = typeof window === "undefined" ? (display ? "/kds" : "/pos") : `${window.location.origin}${display ? "/kds" : "/pos"}`;
  const [code, setCode] = useState<Shown | null>(() => (stillLive(shown.get(opened.id)) ? shown.get(opened.id)! : null));
  const [unseen, setUnseen] = useState<Unseen | null>(null);
  const [pairedAs, setPairedAs] = useState<string | null>(null);
  const issue = useMutation<PairingCode, ApiError, { replace: boolean }>({
    mutationFn: ({ replace }) => req(api.POST("/v1/stations/{id}/pairing-code", { params: { path: { id: opened.id } }, body: { replace } })).then((r) => r.data),
    onSuccess: (data) => {
      const next: Shown = { ...data, issuedAt: new Date().toISOString(), pairedAtBefore: station.paired_at };
      shown.set(opened.id, next);
      setCode(next);
      setUnseen(null);
      setPairedAs(null);
    },
    onError: (e) => {
      // Not a failure: the station has a live code this browser was not shown. Say so, and offer to replace it.
      const d = e.details as { reason?: string; issued_at?: string; expires_at?: string } | undefined;
      if (e.code === "state_conflict" && d?.reason === "pairing_code_live" && d.issued_at && d.expires_at) setUnseen({ issued_at: d.issued_at, expires_at: d.expires_at });
    },
  });
  const left = useCountdown(code?.expires_at ?? unseen?.expires_at ?? null);
  const expired = left === "0:00";
  // While a code is live the register is asked every 3 s, so the sheet says "Paired" as soon as the device pairs (E-N10).
  const live = useQuery({
    queryKey: keys.stations(opened.outlet_id),
    queryFn: () => req(api.GET("/v1/outlets/{id}/stations", { params: { path: { id: opened.outlet_id }, query: { include_archived: "true" } } })).then((r) => r.data),
    enabled: Boolean(code) && !expired,
    refetchInterval: 3000,
  });
  const station = live.data?.find((s) => s.id === opened.id) ?? opened;
  // The code is spent once a device has paired since it was issued: the panel says which device, and forgets the code.
  const pairedNow = Boolean(code) && station.paired && station.paired_at !== code!.pairedAtBefore;
  useEffect(() => {
    if (!pairedNow) return;
    shown.delete(opened.id);
    setPairedAs(station.device_label ?? device);
    setCode(null);
  }, [pairedNow, opened.id, station.device_label, device]);
  useEffect(() => {
    if (expired) shown.delete(opened.id);
  }, [expired, opened.id]);
  const waiting = code && !expired && !pairedNow;
  const conflict = issue.error?.code === "state_conflict" && unseen !== null;

  return (
    <div className="flex flex-col gap-4">
      {station.paired ? <StatusDot status="paid" label={station.device_label ? `Paired · ${station.device_label}` : "Paired"} /> : <StatusDot status="neutral" label="Not paired" muted />}
      {pairedAs ? (
        <p role="status" className="rounded-tile bg-status-paid-tint px-4 py-3 text-body text-ink">
          Paired: {pairedAs}
        </p>
      ) : null}
      {waiting ? (
        <div className="flex flex-col items-start gap-2 rounded-tile bg-surface-2 px-5 py-4">
          <p className="text-caption text-ink-2">
            On the {device}, open <span className="font-mono text-ink">{address}</span> and enter this code
          </p>
          <p className="font-mono text-display text-ink tabular tracking-[0.18em]" aria-label={`Pairing code ${code.code.split("").join(" ")}`}>
            {code.code}
          </p>
          <p className="text-caption text-ink-2 tabular">
            Expires at {clock(code.expires_at)} · {left} left · one use only
          </p>
          <p role="status" className="text-caption text-ink">
            Waiting for the {device}…
          </p>
        </div>
      ) : null}
      {unseen && !expired && !code ? (
        <p className="rounded-tile bg-surface-2 px-4 py-3 text-body text-ink">
          A code was issued at {clock(unseen.issued_at)} and expires at {clock(unseen.expires_at)}
          {left ? ` (${left} left)` : ""}. A code is shown once, so it cannot be shown again here.
        </p>
      ) : null}
      {expired ? <p className="text-caption text-ink-2">That code expired. Issue a new one.</p> : null}
      <div className="flex flex-col items-start gap-1.5">
        {(waiting || (unseen && !code)) && !expired ? (
          <>
            <Button onPress={() => issue.mutate({ replace: true })} isPending={issue.isPending} isDisabled={station.archived || !canPair.ok}>
              Replace code
            </Button>
            <p className="text-caption text-ink-2">{waiting ? "The code above stops working." : "The old code stops working."}</p>
          </>
        ) : (
          <Button onPress={() => issue.mutate({ replace: false })} isPending={issue.isPending} isDisabled={station.archived || !canPair.ok}>
            {station.paired ? `Pair another ${device}` : `Pair ${display ? "a screen" : "an iPad"}`}
          </Button>
        )}
      </div>
      <InlineError error={conflict ? null : issue.error} />
    </div>
  );
}
