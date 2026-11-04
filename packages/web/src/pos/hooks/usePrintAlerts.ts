"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toApiError } from "@/lib/api";
import * as reg from "../api/register";
import type { Printer, PrintJob, Relay } from "../api/types";
import { useUiStore } from "../state/ui";
import { useLateJobs, usePrinters, useRelays } from "./queries";
import { useApi } from "./useApi";

export type LateGroup = {
  printer: Printer | null;
  printerId: string;
  jobs: PrintJob[];
  backup: Printer | null;
  /** Age of the oldest waiting ticket, in seconds, ticking on the iPad from the register's `age_seconds`. */
  oldestSeconds: number;
  lastError: string | null;
};

export type PrintAlerts = {
  late: PrintJob[];
  groups: LateGroup[];
  /** No relay at the outlet has reported recently: the cause is the print box, not a printer (design 4.8). */
  relayOffline: boolean;
  /** Set for 5 s after the last late ticket printed: the green "printer is back" banner. */
  recoveredAt: number | null;
  busy: boolean;
  reroute: (jobs: PrintJob[], printerId?: string | null) => Promise<boolean>;
  retry: (jobs: PrintJob[]) => Promise<boolean>;
  lateOrderIds: Set<string>;
};

/**
 * The print failure alert (design 4.8): late jobs from the register, grouped by
 * printer, with the backup printer's name for "Send to…", relay status for the
 * offline wording, and the recovery moment. Polling is in `useLateJobs`.
 */
export function usePrintAlerts(outletId: string | null, now: number): PrintAlerts {
  const api = useApi();
  const qc = useQueryClient();
  const notify = useUiStore((s) => s.notify);
  const showUndo = useUiStore((s) => s.showUndo);
  const late = useLateJobs(outletId);
  const printers = usePrinters(outletId);
  const anyLate = (late.data?.length ?? 0) > 0;
  const relays = useRelays(outletId, anyLate);
  const [busy, setBusy] = useState(false);
  const [recoveredAt, setRecoveredAt] = useState<number | null>(null);
  const hadLate = useRef(false);
  const receivedAt = useRef<number>(Date.now());

  useEffect(() => {
    if (late.data) receivedAt.current = late.dataUpdatedAt || Date.now();
  }, [late.data, late.dataUpdatedAt]);

  useEffect(() => {
    if (!late.data) return;
    if (late.data.length > 0) hadLate.current = true;
    else if (hadLate.current) {
      hadLate.current = false;
      setRecoveredAt(Date.now());
    }
  }, [late.data]);

  const groups = useMemo<LateGroup[]>(() => {
    const byPrinter = new Map<string, PrintJob[]>();
    for (const j of late.data ?? []) (byPrinter.get(j.printer_id) ?? byPrinter.set(j.printer_id, []).get(j.printer_id)!).push(j);
    const elapsed = Math.max(0, (now - receivedAt.current) / 1000);
    return [...byPrinter.entries()].map(([printerId, jobs]) => {
      const printer = printers.data?.find((p) => p.id === printerId) ?? null;
      const backup = printer?.backup_printer_id ? (printers.data?.find((p) => p.id === printer.backup_printer_id) ?? null) : null;
      return {
        printer,
        printerId,
        jobs,
        backup,
        oldestSeconds: Math.max(...jobs.map((j) => j.age_seconds)) + elapsed,
        lastError: jobs.map((j) => j.last_error).find((e) => e) ?? null,
      };
    });
  }, [late.data, printers.data, now]);

  const relayOffline = anyLate && relays.data !== undefined && (relays.data.length === 0 || relays.data.every((r: Relay) => !r.online));

  const done = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["pos", "print-jobs", outletId] });
  }, [outletId, qc]);

  /** Reroute is T1 (design 4.8): it offers Undo, which sends the new tickets back to the printer they came from. */
  const reroute = useCallback(
    async (jobs: PrintJob[], printerId?: string | null) => {
      if (!jobs.length) return false;
      setBusy(true);
      try {
        const created = await reg.rerouteJobs(api, jobs.map((j) => j.id), printerId);
        const label = `Sent ${created.length} ${created.length === 1 ? "ticket" : "tickets"} to ${created[0]?.printer_name ?? "the backup printer"}`;
        const sources = new Set(jobs.map((j) => j.printer_id));
        const [origin] = sources;
        if (created.length && sources.size === 1 && origin) {
          showUndo(label, async () => {
            try {
              await reg.rerouteJobs(api, created.map((j) => j.id), origin);
              done();
            } catch (e) {
              const err = toApiError(e);
              notify({ text: err.message, remedy: err.remedy ?? null, tone: "alert" }, 8000);
            }
          });
        } else notify({ text: label, tone: "success" }, 5000);
        done();
        return true;
      } catch (e) {
        const err = toApiError(e);
        notify({ text: err.message, remedy: err.remedy ?? null, tone: "alert" }, 8000);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [api, done, notify, showUndo],
  );

  const retry = useCallback(
    async (jobs: PrintJob[]) => {
      if (!jobs.length) return false;
      setBusy(true);
      try {
        let n = 0;
        for (const j of jobs) n += (await reg.reprintJob(api, j.id)).length;
        notify({ text: `Retrying ${n} ${n === 1 ? "ticket" : "tickets"}`, tone: "info" }, 4000);
        done();
        return true;
      } catch (e) {
        const err = toApiError(e);
        notify({ text: err.message, remedy: err.remedy ?? null, tone: "alert" }, 8000);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [api, done, notify],
  );

  const lateOrderIds = useMemo(() => new Set((late.data ?? []).map((j) => j.order_id).filter((id): id is string => Boolean(id))), [late.data]);

  return { late: late.data ?? [], groups, relayOffline, recoveredAt, busy, reroute, retry, lateOrderIds };
}
