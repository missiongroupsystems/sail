"use client";

import { Banner, Button, Sheet, useLocale } from "@sail/ui";
import { useState, type ReactNode } from "react";
import type { PrintJob } from "../api/types";
import { usePrintAlerts, type LateGroup } from "../hooks/usePrintAlerts";
import { useNow } from "../lib/device";
import { formatElapsed } from "../lib/format";
import { useNavStore } from "../state/nav";
import { usePos } from "./PosContext";

const KIND_LABEL: Record<string, string> = { kitchen: "ticket", kitchen_ticket: "ticket", void: "void ticket", prebill: "pre-bill", receipt: "receipt", refund_receipt: "refund receipt", service_slip: "table request", test: "test page" };

/**
 * The print failure banner: one L4 line for the printer with the
 * oldest waiting ticket, [Send to <backup>] [Retry] [Details], the relay-offline
 * wording when the print box itself is gone, and the green "back" line for 5 s.
 */
export function PrintBanner({ wrap = (b) => b }: { wrap?: (banner: ReactNode) => ReactNode } = {}) {
  const { station, tablesById, offline } = usePos();
  const now = useNow(1000);
  const alerts = usePrintAlerts(station.outlet_id, now);
  const [details, setDetails] = useState(false);

  const group: LateGroup | null = alerts.groups.length ? alerts.groups.reduce((a, b) => (b.oldestSeconds > a.oldestSeconds ? b : a)) : null;
  const waiting = alerts.late.length;
  const others = alerts.groups.length - 1;

  if (!group) {
    if (alerts.recoveredAt && now - alerts.recoveredAt < 5000) return wrap(<Banner tone="success">Kitchen printer is back · all tickets printed</Banner>);
    return null;
  }

  const name = group.printer?.name ?? "Kitchen printer";
  const tickets = `${waiting} ${waiting === 1 ? "ticket" : "tickets"} waiting`;
  const text = alerts.relayOffline ? `Printing is offline at this outlet · check the print box is powered · ${tickets}` : `${name} not printing · ${tickets} · ${formatElapsed(group.oldestSeconds)}`;

  return (
    <>
      {wrap(<Banner
        tone="alert"
        queued={others > 0 ? others : undefined}
        actions={
          <>
            {group.backup && !alerts.relayOffline ? (
              <Button size="md" variant="primary" isDisabled={offline || alerts.busy} onPress={() => void alerts.reroute(group.jobs)}>
                Send to {group.backup.name}
              </Button>
            ) : null}
            <Button size="md" variant="secondary" isDisabled={offline || alerts.busy} onPress={() => void alerts.retry(group.jobs)}>
              Retry
            </Button>
            <Button size="md" variant="quiet" onPress={() => setDetails(true)}>
              Details
            </Button>
          </>
        }
      >
        {text}
      </Banner>)}
      <Sheet labelledClose isOpen={details} onOpenChange={(o) => (!o ? setDetails(false) : undefined)} title="Tickets waiting" description={alerts.relayOffline ? "The print box has not reported. Tickets stay queued and print when it is back." : "By printer, oldest first. The last error is the printer's own report."} width="lg">
        <div className="flex flex-col gap-6">
          {alerts.groups.map((g) => (
            <section key={g.printerId}>
              <header className="mb-2 flex items-center justify-between gap-3">
                <h3 className="text-line text-ink">
                  {g.printer?.name ?? "Printer"} <span className="text-caption text-ink-2">· {g.jobs.length} waiting{g.lastError ? ` · ${g.lastError}` : ""}</span>
                </h3>
                <div className="flex gap-2">
                  {g.backup ? (
                    <Button size="md" variant="primary" isDisabled={offline || alerts.busy} onPress={() => void alerts.reroute(g.jobs)}>
                      Send to {g.backup.name}
                    </Button>
                  ) : null}
                  <Button size="md" variant="secondary" isDisabled={offline || alerts.busy} onPress={() => void alerts.retry(g.jobs)}>
                    Retry
                  </Button>
                </div>
              </header>
              <ul className="flex flex-col gap-1">
                {[...g.jobs]
                  .sort((a, b) => b.age_seconds - a.age_seconds)
                  .map((j) => (
                    <JobRow key={j.id} job={j} tableName={tableNameFor(j, tablesById)} onOpen={j.order_id ? () => useNavStore.getState().openOrder(j.order_id!) : undefined} />
                  ))}
              </ul>
            </section>
          ))}
        </div>
      </Sheet>
    </>
  );
}

function tableNameFor(job: PrintJob, tablesById: Map<string, { name: string; order: { id: string } | null }>): string | null {
  if (!job.order_id) return null;
  for (const t of tablesById.values()) if (t.order?.id === job.order_id) return t.name;
  return null;
}

function JobRow({ job, tableName, onOpen }: { job: PrintJob; tableName: string | null; onOpen?: () => void }) {
  const { clock } = useLocale();
  const who = tableName ? `Table ${tableName}` : job.order_id ? "Order" : "Outlet";
  return (
    <li className="flex min-h-12 items-center justify-between gap-3 rounded-tile bg-surface-2 px-3 py-2">
      <span className="min-w-0">
        <span className="block truncate text-body text-ink">
          {who} · {KIND_LABEL[job.kind] ?? job.kind}
          {job.copies > 1 ? ` · copy ${job.copy_no}/${job.copies}` : ""}
        </span>
        <span className="block text-caption text-ink-2 tabular">
          {clock(job.created_at)} · {job.status}
          {job.attempts > 1 ? ` · ${job.attempts} tries` : ""}
          {job.last_error ? ` · ${job.last_error}` : ""}
        </span>
      </span>
      {onOpen ? (
        <Button size="md" variant="quiet" onPress={onOpen}>
          Open order
        </Button>
      ) : null}
    </li>
  );
}
