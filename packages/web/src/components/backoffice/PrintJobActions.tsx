"use client";

import { Badge, Button, Dialog, InlineError, Select, TicketPreview, type BadgeTone, useLocale } from "@sail/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import { label } from "./labels";
import { PRINT_JOB_KIND_LABEL, PRINT_JOB_STATUS_LABEL, plural, type CreatedJob, type PrintJob, type Printer } from "./register";

export function jobTone(status: string): BadgeTone {
  switch (status) {
    case "printed":
      return "paid";
    case "failed":
      return "alert";
    case "claimed":
      return "sent";
    case "rerouted":
      return "neutral";
    default:
      return "seated";
  }
}

/** Waiting jobs that have not printed within the 10 s budget (server LATE_JOB_SECONDS). */
export function isLate(job: PrintJob): boolean {
  return (job.status === "queued" || job.status === "claimed" || job.status === "failed") && job.age_seconds >= 10;
}
export function isWaiting(job: PrintJob): boolean {
  return job.status === "queued" || job.status === "claimed" || job.status === "failed";
}

export function JobStatus({ job }: { job: PrintJob }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Badge tone={jobTone(job.status)}>{label(PRINT_JOB_STATUS_LABEL, job.status)}</Badge>
      {isLate(job) ? <Badge tone="alert">Late</Badge> : null}
    </span>
  );
}

type Done = (message: string, warnings: string[]) => void;

/** Reprint and reroute mutations for one outlet's jobs; both invalidate every print-job query. */
export function useJobMutations(onDone?: Done) {
  const qc = useQueryClient();
  const settle = async (created: CreatedJob[], verb: string, warnings: string[]) => {
    await qc.invalidateQueries({ queryKey: ["print-jobs"] });
    const names = Array.from(new Set(created.map((j) => j.printer_name)));
    onDone?.(`${verb} ${plural(created.length, "ticket")} on ${names.join(", ") || "the printer"}`, warnings);
  };
  const reprint = useMutation<{ data: CreatedJob[]; warnings: string[] }, ApiError, string>({
    mutationFn: (id) => req(api.POST("/v1/print-jobs/{id}/reprint", { params: { path: { id } }, body: {} })),
    onSuccess: (r) => settle(r.data, "Queued a reprint of", r.warnings),
  });
  const reroute = useMutation<{ data: CreatedJob[]; warnings: string[] }, ApiError, { jobIds: string[]; printerId: string | null }>({
    mutationFn: ({ jobIds, printerId }) => req(api.POST("/v1/print-jobs/reroute", { body: { job_ids: jobIds, printer_id: printerId } })),
    onSuccess: (r) => settle(r.data, "Rerouted", r.warnings),
  });
  return { reprint, reroute };
}

/** Picks the target printer for a reroute: the configured backup first, then any other printer of the same role. */
export function RerouteDialog({ jobs, printers, isOpen, onClose, onReroute, isPending, error }: { jobs: PrintJob[]; printers: Printer[]; isOpen: boolean; onClose: () => void; onReroute: (printerId: string | null) => void; isPending: boolean; error: ApiError | null }) {
  const sources = Array.from(new Set(jobs.map((j) => j.printer_id)));
  const source = sources.length === 1 ? printers.find((p) => p.id === sources[0]) ?? null : null;
  const backup = source?.backup_printer_id ? printers.find((p) => p.id === source.backup_printer_id && !p.archived) ?? null : null;
  const candidates = printers.filter((p) => !p.archived && !sources.includes(p.id) && (!source || p.role === source.role));
  const [target, setTarget] = useState<string | null>(null);
  const chosen = target ?? backup?.id ?? candidates[0]?.id ?? null;
  const chosenPrinter = printers.find((p) => p.id === chosen) ?? null;

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={(open) => !open && onClose()}
      title={`Send ${plural(jobs.length, "ticket")} to another printer`}
      footer={
        <>
          <Button variant="quiet" onPress={onClose} isDisabled={isPending}>
            Cancel
          </Button>
          <Button variant="primary" isDisabled={!chosen} isPending={isPending} onPress={() => onReroute(chosen)}>
            {chosenPrinter ? `Send to ${chosenPrinter.name}` : "Send"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 pt-2">
        <p>
          {source ? `Waiting on ${source.name}.` : `From ${sources.length} printers.`} The originals are marked rerouted; new tickets print on the printer you choose.
        </p>
        {candidates.length === 0 ? (
          <p className="text-status-alert">No other {source ? `${source.role} ` : ""}printer at this outlet. Add one in Printers first.</p>
        ) : (
          <Select
            label="Target printer"
            selectedKey={chosen}
            onSelectionChange={setTarget}
            items={candidates.map((p) => ({ id: p.id, label: p.name, description: p.id === backup?.id ? `Configured backup · ${p.ip}:${p.port}` : `${p.ip}:${p.port}` }))}
          />
        )}
        <InlineError error={error} />
      </div>
    </Dialog>
  );
}

/** The job's plain text as the register rendered it, on paper the printer's width. */
export function JobPreviewDialog({ job, printers, onClose }: { job: PrintJob | null; printers: Printer[]; onClose: () => void }) {
  const { dayClock } = useLocale();
  const printer = job ? printers.find((p) => p.id === job.printer_id) : null;
  return (
    <Dialog isOpen={job !== null} onOpenChange={(open) => !open && onClose()} title={job ? label(PRINT_JOB_KIND_LABEL, job.kind) : "Ticket"} className="max-w-[560px]">
      {job ? (
        <div className="flex flex-col gap-3 pt-1 pb-3">
          <TicketPreview text={job.text} paperWidth={printer?.paper_width ?? "80mm"} caption={`${printer?.name ?? "Printer"} · ${dayClock(job.created_at)} · copy ${job.copy_no} of ${job.copies} · job ${job.id.slice(0, 8)}`} />
        </div>
      ) : null}
    </Dialog>
  );
}

/**
 * Reprint, Reroute and Preview for one job. Used by the Print jobs page, the
 * Today page's late tickets and the order drawer's tickets. Reroute is only for
 * jobs that have not printed (the register refuses it otherwise).
 */
export function JobRowActions({ job, printers, onDone, compact }: { job: PrintJob; printers: Printer[]; onDone?: Done; compact?: boolean }) {
  const { reprint, reroute } = useJobMutations(onDone);
  const [rerouting, setRerouting] = useState(false);
  const [preview, setPreview] = useState<PrintJob | null>(null);
  const cls = compact ? "min-h-9 max-sm:min-h-11 px-2.5 text-caption" : undefined;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Button variant="quiet" className={cls} onPress={() => setPreview(job)}>
        Preview
      </Button>
      <Button variant="quiet" className={cls} onPress={() => reprint.mutate(job.id)} isPending={reprint.isPending && reprint.variables === job.id}>
        Reprint
      </Button>
      {isWaiting(job) ? (
        <Button variant="quiet" className={cls} onPress={() => setRerouting(true)}>
          Reroute
        </Button>
      ) : null}
      {rerouting ? (
        <RerouteDialog
          jobs={[job]}
          printers={printers}
          isOpen
          onClose={() => {
            setRerouting(false);
            reroute.reset();
          }}
          onReroute={(printerId) => reroute.mutate({ jobIds: [job.id], printerId }, { onSuccess: () => setRerouting(false) })}
          isPending={reroute.isPending}
          error={reroute.error}
        />
      ) : null}
      <JobPreviewDialog job={preview} printers={printers} onClose={() => setPreview(null)} />
      {reprint.error ? <InlineError error={reprint.error} className="basis-full" /> : null}
    </span>
  );
}
