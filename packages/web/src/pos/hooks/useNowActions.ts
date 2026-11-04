"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { toApiError } from "@/lib/api";
import * as reg from "../api/register";
import type { FloorSnapshot } from "../api/types";
import { useUiStore } from "../state/ui";
import { applySnapshot, posKeys } from "./queries";
import { useApi } from "./useApi";

/**
 * Actions on the Now rail (design 4.2, 4.11): accept or reject a QR order,
 * acknowledge a table request, and mark a ready pickup collected. Each is one
 * tap; the register's snapshot goes straight into the cache.
 */
export function useNowActions(outletId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const notify = useUiStore((s) => s.notify);
  const [busy, setBusy] = useState<string | null>(null);

  const fail = useCallback(
    (e: unknown) => {
      const err = toApiError(e);
      notify({ text: err.message, remedy: err.remedy ?? null, tone: "alert" }, 8000);
    },
    [notify],
  );

  const refreshNow = useCallback(() => {
    void qc.invalidateQueries({ queryKey: posKeys.rounds(outletId) });
    void qc.invalidateQueries({ queryKey: posKeys.requests(outletId) });
    void qc.invalidateQueries({ queryKey: posKeys.floor(outletId) });
  }, [outletId, qc]);

  const acceptRound = useCallback(
    async (roundId: string) => {
      setBusy(roundId);
      try {
        const res = await reg.acceptRound(api, roundId);
        applySnapshot(qc, res.data);
        for (const w of res.warnings) notify({ text: w, tone: "info" }, 6000);
        refreshNow();
        return res.data;
      } catch (e) {
        fail(e);
        refreshNow();
        return null;
      } finally {
        setBusy(null);
      }
    },
    [api, fail, notify, qc, refreshNow],
  );

  const rejectRound = useCallback(
    async (roundId: string, reason: string) => {
      setBusy(roundId);
      try {
        const res = await reg.rejectRound(api, roundId, reason);
        applySnapshot(qc, res.data);
        refreshNow();
        return res.data;
      } catch (e) {
        fail(e);
        refreshNow();
        return null;
      } finally {
        setBusy(null);
      }
    },
    [api, fail, qc, refreshNow],
  );

  const acknowledge = useCallback(
    async (requestId: string) => {
      setBusy(requestId);
      try {
        await reg.acknowledgeServiceRequest(api, requestId);
        refreshNow();
        return true;
      } catch (e) {
        fail(e);
        refreshNow();
        return false;
      } finally {
        setBusy(null);
      }
    },
    [api, fail, refreshNow],
  );

  /** A ready pickup or takeaway handed over: completes the order when it is paid. Returns false when a balance remains, so the caller opens Pay. */
  const collect = useCallback(
    async (order: FloorSnapshot["other_orders"][number]) => {
      setBusy(order.id);
      try {
        const snap = await reg.getOrder(api, order.id);
        if (snap.balance > 0) return { paid: false as const, order: snap };
        const res = await reg.completeOrder(api, order.id, { expectedVersion: snap.version });
        applySnapshot(qc, res.data);
        notify({ text: `${res.data.order_no} collected`, tone: "success" }, 3000);
        return { paid: true as const, order: res.data };
      } catch (e) {
        fail(e);
        return null;
      } finally {
        setBusy(null);
      }
    },
    [api, fail, notify, qc],
  );

  return useMemo(() => ({ acceptRound, rejectRound, acknowledge, collect, busy }), [acceptRound, rejectRound, acknowledge, collect, busy]);
}
