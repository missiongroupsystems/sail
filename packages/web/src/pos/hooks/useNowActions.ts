"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { toApiError } from "@/lib/api";
import * as reg from "../api/register";
import type { FloorSnapshot } from "../api/types";
import { useUiStore } from "../state/ui";
import { applySnapshot, posKeys, refreshStock } from "./queries";
import { useApi } from "./useApi";

/**
 * Actions on the Now rail: accept or reject a QR order,
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

  /** A decision whose answer was lost: done when the round no longer waits (true), otherwise the error is shown (null). */
  const settled = useCallback(
    async (e: unknown, roundId: string): Promise<true | null> => {
      try {
        await reg.afterLostDecision(api, e, outletId, roundId, null);
        return true;
      } catch (err) {
        fail(err);
        return null;
      }
    },
    [api, fail, outletId],
  );

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
        refreshNow();
        return settled(e, roundId);
      } finally {
        setBusy(null);
      }
    },
    [api, notify, qc, refreshNow, settled],
  );

  /** A reject as sold out names the products: the register rejects and marks them in one request (review 4 U1). */
  const rejectRound = useCallback(
    async (roundId: string, reason: string, soldOut: string[] = []) => {
      setBusy(roundId);
      try {
        const res = await reg.rejectRound(api, roundId, reason, undefined, soldOut);
        applySnapshot(qc, res.data);
        if (soldOut.length) refreshStock(qc, outletId);
        refreshNow();
        return res.data;
      } catch (e) {
        refreshNow();
        const done = await settled(e, roundId);
        if (done && soldOut.length) refreshStock(qc, outletId);
        return done;
      } finally {
        setBusy(null);
      }
    },
    [api, outletId, qc, refreshNow, settled],
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
