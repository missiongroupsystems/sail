"use client";

import { Button, CashCounter, cashCounterTotal, Checklist, Money, ReasonPicker, Skeleton, type CashCounterMode, type ChecklistItem, useLocale } from "@sail/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toApiError } from "@/lib/api";
import { closeShift, openShift } from "../../api/register";
import type { Shift, ZReport } from "../../api/types";
import { usePos } from "../../components/PosContext";
import { posKeys, useLateJobs, useMerchant, useOpenOrders, useOpenServiceRequests, usePendingRounds, useShifts } from "../../hooks/queries";
import { useApi } from "../../hooks/useApi";
import { useCashDenominations } from "../../lib/cash";
import { roleAtLeast } from "../../hooks/useOrderActions";
import { useNavStore } from "../../state/nav";
import { useUiStore } from "../../state/ui";

const VARIANCE_REASONS = ["Change given wrongly", "Cash paid out for a purchase", "Float was not counted at open", "Cash left in the drawer from the last shift"];
/** What the register sends when a close needs a variance reason (shifts.close, design 4.9). */
type VarianceRefusal = { expected: number; counted: number; variance: number; variance_threshold: number };
function varianceRefusal(details: Record<string, unknown> | undefined): VarianceRefusal | null {
  return details && typeof details.variance_threshold === "number" ? (details as VarianceRefusal) : null;
}

type Phase = { kind: "idle" } | { kind: "checklist" } | { kind: "count" } | { kind: "reason"; cash: VarianceRefusal } | { kind: "result"; shift: Shift; report: ZReport };

/** Open shift → float; Close shift → checklist, blind count, result with the register's expected, counted and variance (design 4.9). */
export function ShiftHome({ onShowReport }: { onShowReport: () => void }) {
  const { money, clock } = useLocale();
  const api = useApi();
  const qc = useQueryClient();
  const { station, staff, offline } = usePos();
  const varianceThreshold = useMerchant().data?.settings.cash_variance_threshold;
  const notify = useUiStore((s) => s.notify);
  const go = useNavStore((s) => s.go);
  const open = useShifts(station.outlet_id, "open");
  const closed = useShifts(station.outlet_id, "closed");

  const mine = useMemo(() => (open.data ?? []).find((s) => s.station_id === station.id) ?? (open.data ?? []).find((s) => s.station_id === null) ?? null, [open.data, station.id]);
  const lastClosed = useMemo(() => [...(closed.data ?? [])].filter((s) => s.station_id === station.id || s.station_id === null).sort((a, b) => (b.closed_at ?? "").localeCompare(a.closed_at ?? ""))[0] ?? null, [closed.data, station.id]);
  const canOpen = roleAtLeast(staff.role, "cashier");
  const denominations = useCashDenominations();

  const [mode, setMode] = useState<CashCounterMode>("total");
  const [digits, setDigits] = useState("");
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [seeded, setSeeded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [left, setLeft] = useState<Set<string>>(new Set());

  // The float defaults to the last close's figure (design 4.9).
  useEffect(() => {
    if (seeded || !closed.data || mine) return;
    setSeeded(true);
    if (lastClosed?.float_counts && Object.keys(lastClosed.float_counts).length && denominations.length) {
      setMode("counts");
      setCounts(lastClosed.float_counts);
    } else if (lastClosed) setDigits(String(lastClosed.float_cents));
  }, [closed.data, lastClosed, mine, seeded, denominations.length]);

  const total = cashCounterTotal(mode, digits, counts, denominations);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["pos", "shifts", station.outlet_id] });
    void qc.invalidateQueries({ queryKey: ["pos", "z-report", station.outlet_id] });
  };

  const doOpen = async () => {
    setBusy(true);
    try {
      await openShift(api, { float_cents: total, float_counts: mode === "counts" ? counts : null });
      notify({ text: `Shift open with ${money(total)}`, tone: "success" }, 4000);
      refresh();
      setDigits("");
      setCounts({});
    } catch (e) {
      const err = toApiError(e);
      notify({ text: err.message, remedy: err.remedy ?? null, tone: "alert" }, 8000);
    } finally {
      setBusy(false);
    }
  };

  /* ---- Close: checklist from register reads ---- */
  const orders = useOpenOrders(station.outlet_id);
  const rounds = usePendingRounds(station.outlet_id);
  const late = useLateJobs(station.outlet_id);
  const requests = useOpenServiceRequests(station.outlet_id);
  const checklist: ChecklistItem[] = useMemo(() => {
    const mk = (id: string, n: number, one: string, many: string, detail: string, onView: () => void): ChecklistItem => ({
      id,
      title: n === 0 ? `No ${many}` : `${n} ${n === 1 ? one : many}`,
      detail: n === 0 ? null : detail,
      status: n === 0 ? "resolved" : left.has(id) ? "left" : "open",
      onView,
      onLeave: () => setLeft(new Set(left).add(id)),
      leaveLabel: "Leave open",
    });
    return [
      mk("orders", (orders.data ?? []).length, "open order", "open orders", "Pay or cancel them, or carry them to the next shift.", () => go({ kind: "orders" })),
      mk("rounds", (rounds.data ?? []).length, "QR order waiting", "QR orders waiting", "Accept or reject them from the Now rail.", () => go({ kind: "floor" })),
      mk("late", (late.data ?? []).length, "ticket not printed", "tickets not printed", "Send them to the backup printer or retry from the banner.", () => go({ kind: "floor" })),
      mk("requests", (requests.data ?? []).length, "table request open", "table requests open", "Mark them done from the Now rail.", () => go({ kind: "floor" })),
    ];
  }, [orders.data, rounds.data, late.data, requests.data, left, go]);
  const checklistDone = checklist.every((c) => c.status !== "open");

  const startClose = () => {
    setLeft(new Set());
    setMode("total");
    setDigits("");
    setCounts({});
    setPhase({ kind: "checklist" });
  };

  const close = async (varianceReason: string | null) => {
    if (!mine) return;
    setBusy(true);
    try {
      const counted = { counted_cash_cents: total, counted_counts: mode === "counts" ? counts : null };
      // Count first, then the register's expected figure (a blind count). Above the merchant's threshold the register refuses the close without a reason.
      const res = await closeShift(api, mine.id, { ...counted, variance_reason: varianceReason });
      setPhase({ kind: "result", shift: res.data, report: res.data.report });
      refresh();
      void qc.invalidateQueries({ queryKey: posKeys.orders(station.outlet_id) });
    } catch (e) {
      const err = toApiError(e);
      const refusal = err.code === "validation" && !varianceReason ? varianceRefusal(err.details) : null;
      if (refusal) {
        setPhase({ kind: "reason", cash: refusal });
        return;
      }
      notify({ text: err.message, remedy: err.remedy ?? null, tone: "alert" }, 8000);
    } finally {
      setBusy(false);
    }
  };

  if (open.isLoading && !open.data) {
    return (
      <div className="px-8 py-8">
        <Skeleton lines={4} />
      </div>
    );
  }

  /* ---- Result ---- */
  if (phase.kind === "result") {
    const c = phase.report.cash;
    return (
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-8 py-8">
        <div>
          <h1 className="text-title text-ink">Shift closed</h1>
          <p className="text-body text-ink-2">
            {phase.shift.opened_at ? `Opened ${clock(phase.shift.opened_at)}` : ""}
            {phase.shift.closed_at ? ` · closed ${clock(phase.shift.closed_at)}` : ""} · {phase.shift.closed_by ?? staff.name}
          </p>
        </div>
        <dl className="rounded-tile bg-surface px-5 py-3 hairline">
          <Row label="Float" cents={c.float} />
          <Row label="Cash payments" cents={c.cash_payments} />
          <Row label="Cash rounding" cents={c.rounding} />
          <Row label="Cash refunds" cents={-c.refunds} />
          <Row label="Expected" cents={c.expected} strong />
          <Row label="Counted" cents={c.counted ?? 0} strong />
          <Row label="Variance" cents={c.variance ?? 0} strong tone={(c.variance ?? 0) === 0 ? "paid" : varianceThreshold !== undefined && Math.abs(c.variance ?? 0) > varianceThreshold ? "alert" : undefined} />
          {phase.shift.variance_reason ? <p className="pt-2 text-caption text-ink-2">Reason: {phase.shift.variance_reason}</p> : null}
        </dl>
        <div className="flex gap-2">
          <Button size="lg" variant="secondary" onPress={onShowReport}>
            View Z-report
          </Button>
          <Button size="lg" variant="primary" onPress={() => setPhase({ kind: "idle" })}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  /* ---- Variance reason ---- */
  if (phase.kind === "reason") {
    const c = phase.cash;
    return (
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-8 py-8">
        <div>
          <h1 className="text-title text-ink">Variance {money(c.variance)}</h1>
          <p className="text-body text-ink-2">
            The register expected {money(c.expected)} and you counted {money(c.counted)}. Above {money(c.variance_threshold)} a reason is recorded with the close.
          </p>
        </div>
        <ReasonPicker reasons={VARIANCE_REASONS.map((r) => ({ id: r, name: r }))} isDisabled={busy} onPick={(r) => void close(r.text)} />
        <Button size="lg" variant="quiet" isDisabled={busy} onPress={() => setPhase({ kind: "count" })} className="self-start">
          Count again
        </Button>
      </div>
    );
  }

  /* ---- Count (before expected is shown) ---- */
  if (phase.kind === "count" && mine) {
    return (
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-8 py-8">
        <div>
          <h1 className="text-title text-ink">Count the cash</h1>
          <p className="text-body text-ink-2">Everything in the drawer, float included. The register shows what it expected after you count.</p>
        </div>
        <CashCounter mode={mode} onModeChange={setMode} totalDigits={digits} onTotalDigitsChange={setDigits} counts={counts} onCountsChange={setCounts} denominations={denominations} isDisabled={busy} />
        <div className="flex items-center justify-between gap-3">
          <Button size="lg" variant="quiet" isDisabled={busy} onPress={() => setPhase({ kind: "checklist" })}>
            Back to the checklist
          </Button>
          <Button size="lg" variant="primary" isDisabled={offline || busy || (mode === "total" && digits === "")} isPending={busy} onPress={() => void close(null)} className="min-w-[280px]">
            {offline ? "Offline" : `Close shift · counted ${money(total)} ▸`}
          </Button>
        </div>
      </div>
    );
  }

  /* ---- Checklist ---- */
  if (phase.kind === "checklist" && mine) {
    return (
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-8 py-8">
        <div>
          <h1 className="text-title text-ink">Before closing</h1>
          <p className="text-body text-ink-2">From the register, right now. Resolve each item or leave it for the next shift.</p>
        </div>
        <Checklist items={checklist} />
        <div className="flex items-center justify-between gap-3">
          <Button size="lg" variant="quiet" onPress={() => setPhase({ kind: "idle" })}>
            Not now
          </Button>
          <Button size="lg" variant="primary" isDisabled={!checklistDone} onPress={() => setPhase({ kind: "count" })} className="min-w-[240px]">
            {checklistDone ? "Next: count the cash ▸" : "Resolve or leave each item"}
          </Button>
        </div>
      </div>
    );
  }

  /* ---- Idle: open shift, or the open shift's summary ---- */
  if (!mine) {
    return (
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-8 py-8">
        <div>
          <h1 className="text-title text-ink">Open shift</h1>
          <p className="text-body text-ink-2">
            Count the float into the drawer.
            {lastClosed ? ` Last close: ${money(lastClosed.float_cents)} float${lastClosed.closed_at ? `, ${clock(lastClosed.closed_at)}` : ""}.` : ""}
          </p>
        </div>
        <CashCounter mode={mode} onModeChange={setMode} totalDigits={digits} onTotalDigitsChange={setDigits} counts={counts} onCountsChange={setCounts} denominations={denominations} isDisabled={busy || !canOpen} />
        {!canOpen ? <p className="text-body text-ink-2">Opening a shift needs a Cashier or above. Switch user to open it.</p> : null}
        <Button size="lg" variant="primary" isDisabled={offline || busy || !canOpen} isPending={busy} onPress={doOpen} className="min-w-[280px] self-end">
          {offline ? "Offline" : `Open shift with ${money(total)}`}
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-8 py-8">
      <div>
        <h1 className="text-title text-ink">Shift open</h1>
        <p className="text-body text-ink-2">
          Since {clock(mine.opened_at)} · opened by {mine.opened_by ?? "—"}
          {mine.name ? ` · ${mine.name}` : ""}
          {mine.station_id === null ? " · whole outlet" : ""}
        </p>
      </div>
      <dl className="rounded-tile bg-surface px-5 py-3 hairline">
        <Row label="Float" cents={mine.float_cents} strong />
        {mine.float_counts ? <p className="pt-1 text-caption text-ink-2">Counted by denomination at open.</p> : null}
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button size="lg" variant="secondary" onPress={onShowReport}>
          Z-report so far
        </Button>
        <Button size="lg" variant="primary" isDisabled={offline || !canOpen} onPress={startClose} className="min-w-[200px]">
          {offline ? "Offline" : "Close shift ▸"}
        </Button>
      </div>
      {!canOpen ? <p className="text-body text-ink-2">Closing a shift needs a Cashier or above.</p> : null}
    </div>
  );
}

export function Row({ label, cents, strong, tone }: { label: string; cents: number; strong?: boolean; tone?: "paid" | "alert" }) {
  return (
    <div className={strong ? "flex min-h-10 items-center justify-between gap-3 pt-1 hairline-t" : "flex min-h-8 items-center justify-between gap-3"}>
      <dt className={strong ? "text-line text-ink" : "text-body text-ink-2"}>{label}</dt>
      <dd>
        <Money cents={cents} size={strong ? "heading" : "body"} className={tone === "paid" ? "text-status-paid" : tone === "alert" ? "text-status-alert" : "text-ink"} />
      </dd>
    </div>
  );
}
