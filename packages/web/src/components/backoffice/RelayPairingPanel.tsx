"use client";

import { Badge, Button, cx, Icon, InlineError, useLocale } from "@sail/ui";
import { Check, CircleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Relay, RelayPairingCode } from "./register";

export function useCountdown(until: string | null): { text: string | null; expired: boolean } {
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
  if (left === null) return { text: null, expired: false };
  return { text: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`, expired: left === 0 };
}

/** The install command from docs/runbooks/relay.md with the code filled in. Hosts and tags stay as placeholders: Ops fills them per site. */
export function relayDockerCommand(code: string): string {
  return [
    "docker run -d --name sail-relay --restart unless-stopped \\",
    "  -v sail-relay-data:/data \\",
    "  -e SAIL_API_URL=https://<api-host> \\",
    `  -e SAIL_RELAY_PAIRING_CODE=${code} \\`,
    "  -e SAIL_RELAY_VERSION=<image-tag> \\",
    "  <registry>/sail-relay:<image-tag>",
  ].join("\n");
}

export function RelayStatus({ relay }: { relay: Relay }) {
  if (relay.archived) return <Badge>Archived</Badge>;
  if (!relay.paired) return <Badge>Not paired</Badge>;
  if (relay.online)
    return (
      <Badge tone="paid">
        <Icon icon={Check} size={12} strokeWidth={2.25} />
        Online
      </Badge>
    );
  return (
    <Badge tone="alert">
      <Icon icon={CircleAlert} size={12} strokeWidth={2.25} />
      Offline
    </Badge>
  );
}

/** One relay as a card: its name and status pill, then when it was last heard, its printers and its version. Phrasing content only, so it can sit inside a button. */
export function RelayCard({ relay, detail, className }: { relay: Relay; detail?: ReactNode; className?: string }) {
  const { dayClock } = useLocale();
  const reports = Object.values(relay.printer_status);
  const ok = reports.filter((r) => r.ok).length;
  return (
    <span className={cx("flex min-w-0 flex-col gap-2 rounded-[14px] border border-rule bg-surface px-5 py-4 text-left", relay.archived && "opacity-70", className)}>
      <span className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-[14.5px] font-medium text-ink">{relay.name}</span>
        <RelayStatus relay={relay} />
      </span>
      <span className="text-[13px] leading-5 text-ink-2 tabular">
        {relay.last_seen_at ? `Last heard ${dayClock(relay.last_seen_at)}` : "Never heard from"}
        {reports.length ? ` · ${ok} of ${reports.length} printers reachable` : ""}
        {relay.version ? ` · version ${relay.version}` : ""}
      </span>
      {detail}
    </span>
  );
}

/**
 * "Pair a relay": a one-time 6-digit code shown large
 * with its expiry, and the docker command from the runbook with the code in it.
 * Pairing a spare replaces the old token, so the previous device stops working.
 */
export function RelayPairingPanel({ relay, canPair }: { relay: Relay; canPair: boolean }) {
  const { clock, dayClock } = useLocale();
  const code = useMutation<RelayPairingCode, ApiError>({
    mutationFn: () => req(api.POST("/v1/relays/{id}/pairing-code", { params: { path: { id: relay.id } }, body: {} })).then((r) => r.data),
  });
  const { text: left, expired } = useCountdown(code.data?.expires_at ?? null);
  const [copied, setCopied] = useState(false);
  const live = code.data && !expired;

  const copy = async () => {
    if (!code.data) return;
    try {
      await navigator.clipboard.writeText(relayDockerCommand(code.data.code));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <RelayStatus relay={relay} />
        {relay.paired_at ? <span className="text-caption text-ink-2">Paired {dayClock(relay.paired_at)}</span> : null}
        {relay.last_seen_at ? <span className="text-caption text-ink-2">Last seen {dayClock(relay.last_seen_at)}</span> : null}
        {relay.version ? <span className="font-mono text-caption text-ink-2">{relay.version}</span> : null}
      </div>

      {live ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col items-start gap-2 rounded-[14px] bg-surface-2 px-5 py-4">
            <p className="text-caption text-ink-2">On the relay device, start the container with this code</p>
            <p className="font-mono text-display text-ink tabular tracking-[0.18em]" aria-label={`Pairing code ${code.data!.code.split("").join(" ")}`}>
              {code.data!.code}
            </p>
            <p className="text-caption text-ink-2 tabular">
              Expires at {clock(code.data!.expires_at)} · {left} left · one use only
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-caption text-ink-2">Install command (docs/runbooks/relay.md). Replace the host, registry and image tag; remove the code variable after the first start.</p>
              <Button variant="quiet" className="min-h-9 max-sm:min-h-11 shrink-0 text-caption" onPress={copy}>
                {copied ? "Copied" : "Copy command"}
              </Button>
            </div>
            <pre className="overflow-x-auto rounded-[12px] bg-surface-2 px-4 py-3 font-mono text-caption leading-[20px] text-ink whitespace-pre">{relayDockerCommand(code.data!.code)}</pre>
          </div>
        </div>
      ) : null}
      {expired ? <p className="text-caption text-ink-2">That code expired. Issue a new one.</p> : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button onPress={() => code.mutate()} isPending={code.isPending} isDisabled={relay.archived || !canPair}>
          {live ? "Issue a new code" : relay.paired ? "Pair a replacement" : "Pair"}
        </Button>
        {!canPair ? <span className="text-caption text-ink-2">Admin only</span> : relay.paired ? <span className="text-caption text-ink-2">Pairing a replacement replaces the token: the old device can no longer connect.</span> : null}
      </div>
      <InlineError error={code.error} />
    </div>
  );
}
