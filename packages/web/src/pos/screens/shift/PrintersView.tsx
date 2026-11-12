"use client";

import { Badge, Button, Skeleton, StatusDot, useLocale } from "@sail/ui";
import { useState } from "react";
import { toApiError } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { reprintJob } from "../../api/register";
import type { PrintJob } from "../../api/types";
import { usePos } from "../../components/PosContext";
import { JOB_KIND_LABEL, JOB_STATUS_LABEL } from "../../components/ReprintSheet";
import { usePrinters, useRecentPrintJobs, useRelays } from "../../hooks/queries";
import { useApi } from "../../hooks/useApi";
import { usePrintAlerts } from "../../hooks/usePrintAlerts";
import { useNow } from "../../lib/device";
import { formatElapsed } from "../../lib/format";
import { useNavStore } from "../../state/nav";
import { useUiStore } from "../../state/ui";

/** Printers: status from the relay, waiting tickets with Send to backup and Retry, and Reprint from recent jobs. */
export function PrintersView() {
  const { clock, dayClock } = useLocale();
  const api = useApi();
  const qc = useQueryClient();
  const { station, offline } = usePos();
  const notify = useUiStore((s) => s.notify);
  const openOrder = useNavStore((s) => s.openOrder);
  const now = useNow(1000);
  const printers = usePrinters(station.outlet_id);
  const relays = useRelays(station.outlet_id);
  const recent = useRecentPrintJobs(station.outlet_id);
  const alerts = usePrintAlerts(station.outlet_id, now);
  const [busy, setBusy] = useState<string | null>(null);

  const anyRelayOnline = (relays.data ?? []).some((r) => r.online);

  const reprint = async (job: PrintJob) => {
    setBusy(job.id);
    try {
      const jobs = await reprintJob(api, job.id);
      notify({ text: jobs.length ? `Reprinting on ${jobs[0]!.printer_name}` : "Reprint queued", tone: "success" }, 4000);
      void qc.invalidateQueries({ queryKey: ["pos", "print-jobs", station.outlet_id] });
    } catch (e) {
      const err = toApiError(e);
      notify({ text: err.message, remedy: err.remedy ?? null, tone: "alert" }, 8000);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-[880px] flex-col gap-6 px-8 py-8">
      <div>
        <h1 className="text-title text-ink">Printers</h1>
        <p className="text-body text-ink-2">Status comes from the print box at this outlet. Tickets that have not printed within 10 seconds are listed first.</p>
      </div>

      <section className="rounded-tile bg-surface px-5 py-3 hairline">
        <h2 className="text-caption text-ink-2 uppercase tracking-[0.04em]">Print box</h2>
        {relays.isLoading && !relays.data ? <Skeleton lines={2} /> : null}
        {relays.data && relays.data.length === 0 ? <p className="py-2 text-body text-ink-2">No print box is paired at this outlet. Tickets queue until one is paired in the back office.</p> : null}
        <ul>
          {(relays.data ?? []).map((r) => (
            <li key={r.id} className="flex min-h-10 items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-line text-ink">
                <StatusDot status={r.online ? "paid" : "alert"} label={r.name} />
              </span>
              <span className="text-caption text-ink-2 tabular">{r.online ? "online" : r.last_seen_at ? `offline · last seen ${dayClock(r.last_seen_at)}` : "never connected"}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-tile bg-surface px-5 py-3 hairline">
        <h2 className="text-caption text-ink-2 uppercase tracking-[0.04em]">Printers</h2>
        {printers.isLoading && !printers.data ? <Skeleton lines={3} /> : null}
        {printers.data && printers.data.length === 0 ? <p className="py-2 text-body text-ink-2">No printers are set up for this outlet.</p> : null}
        <ul>
          {(printers.data ?? []).map((p) => {
            const status = (relays.data ?? []).map((r) => r.printer_status?.[p.id]).find((s) => s);
            const waiting = alerts.groups.find((g) => g.printerId === p.id);
            const backup = p.backup_printer_id ? printers.data?.find((x) => x.id === p.backup_printer_id) : null;
            return (
              <li key={p.id} className="flex min-h-12 items-center justify-between gap-3">
                <span className="min-w-0">
                  <span className="flex items-center gap-2 text-line text-ink">
                    <StatusDot status={waiting ? "alert" : !anyRelayOnline ? "sent" : status ? (status.ok ? "paid" : "alert") : "neutral"} label={p.name} />
                    <Badge tone="neutral">{p.role === "kitchen" ? (p.is_default_kitchen ? "kitchen · default" : "kitchen") : "receipts"}</Badge>
                  </span>
                  <span className="block pl-5 text-caption text-ink-2">
                    {waiting ? `${waiting.jobs.length} waiting · ${formatElapsed(waiting.oldestSeconds)}` : status ? (status.ok ? `ok · checked ${clock(status.checked_at)}` : status.error ?? "error") : anyRelayOnline ? "no status yet" : "print box offline"}
                    {backup ? ` · backup ${backup.name}` : ""}
                  </span>
                </span>
                {waiting ? (
                  <span className="flex gap-2">
                    {backup ? (
                      <Button size="md" variant="primary" isDisabled={offline || alerts.busy} onPress={() => void alerts.reroute(waiting.jobs)}>
                        Send to {backup.name}
                      </Button>
                    ) : null}
                    <Button size="md" variant="secondary" isDisabled={offline || alerts.busy} onPress={() => void alerts.retry(waiting.jobs)}>
                      Retry
                    </Button>
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="rounded-tile bg-surface px-5 py-3 hairline">
        <h2 className="text-caption text-ink-2 uppercase tracking-[0.04em]">Recent tickets</h2>
        {recent.isLoading && !recent.data ? <Skeleton lines={4} /> : null}
        {recent.data && recent.data.length === 0 ? <p className="py-2 text-body text-ink-2">Nothing has printed yet today.</p> : null}
        <ul className="flex flex-col gap-1 py-1">
          {[...(recent.data ?? [])]
            .sort((a, b) => b.created_at.localeCompare(a.created_at))
            .slice(0, 30)
            .map((j) => (
              <li key={j.id} className="flex min-h-12 items-center justify-between gap-3 rounded-tile px-2 py-1 data-[late]:bg-surface-2">
                <span className="min-w-0">
                  <span className="block truncate text-body text-ink">
                    {JOB_KIND_LABEL[j.kind] ?? j.kind} · {printers.data?.find((p) => p.id === j.printer_id)?.name ?? "printer"}
                    {j.copies > 1 ? ` · copy ${j.copy_no}/${j.copies}` : ""}
                  </span>
                  <span className="block truncate text-caption text-ink-2 tabular">
                    {clock(j.created_at)} · {alerts.late.some((l) => l.id === j.id) ? "⚠ not printed" : (JOB_STATUS_LABEL[j.status] ?? j.status)}
                    {j.last_error ? ` · ${j.last_error}` : ""}
                  </span>
                </span>
                <span className="flex gap-1">
                  {j.order_id ? (
                    <Button size="md" variant="quiet" onPress={() => openOrder(j.order_id!)}>
                      Order
                    </Button>
                  ) : null}
                  <Button size="md" variant="secondary" isDisabled={offline || busy !== null} isPending={busy === j.id} onPress={() => void reprint(j)}>
                    Reprint
                  </Button>
                </span>
              </li>
            ))}
        </ul>
      </section>
    </div>
  );
}
