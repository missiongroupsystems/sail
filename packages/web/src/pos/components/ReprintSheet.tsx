"use client";

import { Button, Sheet, Skeleton, useLocale } from "@sail/ui";
import { useState } from "react";
import type { OrderSnapshot, PrintJob } from "../api/types";
import { useOrderPrintJobs } from "../hooks/queries";
import type { OrderActions } from "../hooks/useOrderActions";
import { usePos } from "./PosContext";

export const JOB_KIND_LABEL: Record<string, string> = { kitchen: "Kitchen ticket", kitchen_ticket: "Kitchen ticket", void: "Void ticket", prebill: "Pre-bill", receipt: "Receipt", refund_receipt: "Refund receipt", service_slip: "Table request", test: "Test page" };
export const JOB_STATUS_LABEL: Record<string, string> = { queued: "waiting", claimed: "printing", printed: "printed", failed: "failed", rerouted: "sent to another printer" };

/** Jobs that belong to a sent round: created within a few seconds of its firing time. */
export function jobsForRound(jobs: PrintJob[], firedAt: string | null): PrintJob[] {
  if (!firedAt) return [];
  const t = new Date(firedAt).getTime();
  return jobs.filter((j) => j.kind !== "receipt" && j.kind !== "prebill" && j.kind !== "refund_receipt" && Math.abs(new Date(j.created_at).getTime() - t) < 15_000);
}

export type ReprintSheetProps = {
  isOpen: boolean;
  onClose: () => void;
  order: OrderSnapshot;
  actions: OrderActions;
  /** The round whose header was tapped; its tickets are listed first. */
  round?: { number: number; firedAt: string | null } | null;
};

/** Reprint a ticket (Order → round header → Reprint). Every job the register printed for this order, with its status and printer. */
export function ReprintSheet({ isOpen, onClose, order, actions, round }: ReprintSheetProps) {
  const { clock } = useLocale();
  const { station, offline } = usePos();
  const jobs = useOrderPrintJobs(station.outlet_id, order.id, isOpen);
  const [busy, setBusy] = useState<string | null>(null);
  const all = jobs.data ?? [];
  const forRound = round ? jobsForRound(all, round.firedAt) : [];
  const rest = all.filter((j) => !forRound.includes(j)).sort((a, b) => b.created_at.localeCompare(a.created_at));

  const reprint = async (job: PrintJob) => {
    setBusy(job.id);
    const res = await actions.reprint(job.id);
    setBusy(null);
    if (res) onClose();
  };

  const row = (j: PrintJob) => (
    <li key={j.id} className="flex min-h-14 items-center justify-between gap-3 rounded-tile bg-surface-2 px-4 py-2">
      <span className="min-w-0">
        <span className="block truncate text-line text-ink">
          {JOB_KIND_LABEL[j.kind] ?? j.kind}
          {j.copies > 1 ? ` · copy ${j.copy_no}/${j.copies}` : ""}
        </span>
        <span className="block truncate text-caption text-ink-2 tabular">
          {clock(j.created_at)} · {JOB_STATUS_LABEL[j.status] ?? j.status}
          {j.last_error ? ` · ${j.last_error}` : ""}
          {j.reprint_of ? " · reprint" : ""}
        </span>
      </span>
      <Button size="lg" variant="secondary" isDisabled={offline || busy !== null} isPending={busy === j.id} onPress={() => void reprint(j)}>
        Reprint
      </Button>
    </li>
  );

  return (
    <Sheet labelledClose isOpen={isOpen} onOpenChange={(o) => (!o ? onClose() : undefined)} title="Reprint ticket" description={round ? `Round ${round.number}${round.firedAt ? ` · sent ${clock(round.firedAt)}` : ""}` : "Tickets the register printed for this order"} isDismissable={busy === null}>
      {jobs.isLoading && !jobs.data ? <Skeleton lines={3} /> : null}
      {jobs.data && all.length === 0 ? <p className="text-body text-ink-2">No tickets have been printed for this order. Kitchen tickets print when a round is sent and a kitchen printer is set up.</p> : null}
      {forRound.length ? (
        <section className="mb-5">
          <h3 className="mb-2 text-caption text-ink-2 uppercase tracking-[0.04em]">This round</h3>
          <ul className="flex flex-col gap-2">{forRound.map(row)}</ul>
        </section>
      ) : null}
      {rest.length ? (
        <section>
          {forRound.length ? <h3 className="mb-2 text-caption text-ink-2 uppercase tracking-[0.04em]">Other tickets</h3> : null}
          <ul className="flex flex-col gap-2">{rest.map(row)}</ul>
        </section>
      ) : null}
    </Sheet>
  );
}
