"use client";

import { Button, CashCounter, cx, cashCounterTotal, Checklist, checklistDone as allDone, checklistStatus, Money, ReasonPicker, Skeleton, type CashCounterMode, type ChecklistItem, useLocale } from "@sail/ui";
import { drawerCap } from "@sail/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toApiError } from "@/lib/api";
import { closeShift, openShift } from "../../api/register";
import type { Shift, ZReport } from "../../api/types";
import { usePos } from "../../components/PosContext";
import { GREY_PILL } from "../../components/styles";
import { posKeys, putShift, useLateJobs, useMerchant, useOpenOrders, useOpenServiceRequests, usePendingRounds, useShifts } from "../../hooks/queries";
import { useApi } from "../../hooks/useApi";
import { useCashDenominations } from "../../lib/cash";
import { roleAtLeast } from "../../hooks/useOrderActions";
import { useNavStore } from "../../state/nav";
import { useUiStore } from "../../state/ui";

const VARIANCE_REASONS = ["Change given wrongly", "Cash paid out for a purchase", "Float was not counted at open", "Cash left in the drawer from the last shift"];
/** What the register sends when a close needs a variance reason (shifts.close). */
/** Below Manager the register withholds `expected` and `variance` (a blind count, S-9): only the count and the threshold come back. */
type VarianceRefusal = { expected?: number; counted: number; variance?: number; variance_threshold: number; withheld?: boolean };
function varianceRefusal(details: Record<string, unknown> | undefined): VarianceRefusal | null {
  return details && typeof details.variance_threshold === "number" ? (details as VarianceRefusal) : null;
}

type Phase = { kind: "idle" } | { kind: "checklist" } | { kind: "count" } | { kind: "reason"; cash: VarianceRefusal; reason?: string | null } | { kind: "result"; shift: Shift; report: ZReport };

/** Open shift → float; Close shift → checklist, blind count, result with the register's expected, counted and variance. */
export function ShiftHome({ onShowReport, onCounting }: { onShowReport: () => void; onCounting?: (counting: boolean) => void }) {
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
  // When the close started: the checklist takes only answers the register gave after it, not data cached by the floor.
  const [closeStartedAt, setCloseStartedAt] = useState(0);
  const counting = phase.kind === "checklist" || phase.kind === "count" || phase.kind === "reason";
  useEffect(() => onCounting?.(counting), [counting, onCounting]);

  // The float defaults to the last close's figure.
  useEffect(() => {
    if (seeded || !closed.data || mine) return;
    setSeeded(true);
    if (lastClosed?.float_counts && Object.keys(lastClosed.float_counts).length && denominations.length) {
      setMode("counts");
      setCounts(lastClosed.float_counts);
    } else if (lastClosed) setDigits(String(lastClosed.float_cents));
  }, [closed.data, lastClosed, mine, seeded, denominations.length]);

  const total = cashCounterTotal(mode, digits, counts, denominations);
  const cap = drawerCap(denominations.map((d) => d.cents));
  const over = total > cap;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["pos", "shifts", station.outlet_id] });
    void qc.invalidateQueries({ queryKey: ["pos", "z-report", station.outlet_id] });
  };

  const doOpen = async () => {
    setBusy(true);
    try {
      const shift = await openShift(api, { float_cents: total, float_counts: mode === "counts" ? counts : null });
      // The card follows the register's reply, not a read that may be slower or refused (review 4 U6).
      await putShift(qc, station.outlet_id, shift);
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
  // A station's shift counts the orders opened at this station; an outlet-wide shift counts them all. QR orders, tickets
  // and table requests belong to no station, so those lines say "at this outlet" (B notes).
  const mineOrders = (orders.data ?? []).filter((o) => !mine?.station_id || o.station_id === mine.station_id);
  const openTables = mineOrders.filter((o) => o.order_type === "dine_in").length;
  const openElsewhere = mineOrders.length - openTables;
  const where = [openTables ? `${openTables} on the floor` : null, openElsewhere ? `${openElsewhere} in Orders` : null].filter(Boolean).join(", ");
  const openOrdersDetail = `${where ? `${where}. ` : ""}Pay or cancel them, or carry them to the next shift.`;
  // Each item is the register's answer since the close started: until a read answers, its item is still being checked and
  // the close cannot go on (a "No open orders" shown before the orders had loaded, or from a minute-old copy, let the
  // count start with orders still open).
  const readOf = (q: { data?: unknown[]; dataUpdatedAt: number; isError: boolean; errorUpdatedAt: number }, count?: number) => {
    const answered = Boolean(q.data) && q.dataUpdatedAt >= closeStartedAt;
    return { count: answered ? (count ?? q.data!.length) : null, failed: !answered && q.isError && q.errorUpdatedAt >= closeStartedAt };
  };
  const ordersRead = readOf(orders, mineOrders.length);
  const roundsRead = readOf(rounds);
  const lateRead = readOf(late);
  const requestsRead = readOf(requests);
  /**
   * One checklist line in each state: `subject` while checking or when the register did not answer ("Checking …",
   * "Could not check …"), `clear` when nothing is left (said plainly: "Every ticket printed", never "No tickets not
   * printed"), else the count with `one` or `many`.
   */
  type Wording = { subject: string; clear: string; one: string; many: string };
  const mk = (id: string, read: { count: number | null; failed: boolean }, w: Wording, detail: string, onView: () => void): ChecklistItem => {
    const n = read.count ?? 0;
    const status = checklistStatus(read, left.has(id));
    return {
      id,
      title: status === "checking" ? `Checking ${w.subject}…` : read.count === null ? `Could not check ${w.subject}` : n === 0 ? w.clear : `${n} ${n === 1 ? w.one : w.many}`,
      detail: read.count === null ? (read.failed ? "The register did not answer. It is checked again shortly, or leave it for the next shift." : null) : n === 0 ? null : detail,
      status,
      onView,
      onLeave: () => setLeft((prev) => new Set(prev).add(id)),
      leaveLabel: "Leave open",
    };
  };
  const ordersFrom = mine?.station_id ? " from this station" : "";
  const checklist: ChecklistItem[] = [
    // Tables are on the floor and the rest in Orders: the line says how many are where, and View opens Orders when
    // anything is there (the floor otherwise), so it never opens an empty list.
    mk("orders", ordersRead, { subject: `open orders${ordersFrom}`, clear: `No open orders${ordersFrom}`, one: `open order${ordersFrom}`, many: `open orders${ordersFrom}` }, openOrdersDetail, () => go({ kind: openElsewhere > 0 ? "orders" : "floor" })),
    mk("rounds", roundsRead, { subject: "QR orders waiting at this outlet", clear: "No QR orders waiting at this outlet", one: "QR order waiting at this outlet", many: "QR orders waiting at this outlet" }, "Accept or reject them from the Now rail.", () => go({ kind: "floor" })),
    mk("late", lateRead, { subject: "ticket printing at this outlet", clear: "Every ticket printed at this outlet", one: "ticket not printed at this outlet", many: "tickets not printed at this outlet" }, "Send them to the backup printer or retry from the banner.", () => go({ kind: "floor" })),
    mk("requests", requestsRead, { subject: "table requests open at this outlet", clear: "No table requests open at this outlet", one: "table request open at this outlet", many: "table requests open at this outlet" }, "Mark them done from the Now rail.", () => go({ kind: "floor" })),
  ];
  const checklistDone = allDone(checklist);
  const checking = checklist.some((c) => c.status === "checking");

  const startClose = () => {
    setCloseStartedAt(Date.now());
    for (const q of [orders, rounds, late, requests]) void q.refetch();
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
      await putShift(qc, station.outlet_id, res.data);
      // The next open starts from this shift's float, which the open form names as the last close's, not from the cash
      // just counted (review 2, N11).
      const floatCounts = mine.float_counts && Object.keys(mine.float_counts).length && denominations.length ? mine.float_counts : null;
      setMode(floatCounts ? "counts" : "total");
      setCounts(floatCounts ?? {});
      setDigits(floatCounts ? "" : String(mine.float_cents));
      setSeeded(true);
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
      <div className="rounded-panel border border-rule bg-surface px-5 py-5">
        <Skeleton lines={4} />
      </div>
    );
  }

  /* ---- Result ---- */
  if (phase.kind === "result") {
    const c = phase.report.cash;
    return (
      <Card
        title="Shift closed"
        sub={
          <>
            {/* Who opened the drawer and who closed it: often two people (L5). */}
            {phase.shift.opened_at ? `Opened ${clock(phase.shift.opened_at)}${phase.shift.opened_by ? ` by ${phase.shift.opened_by}` : ""}` : ""}
            {` · closed ${phase.shift.closed_at ? `${clock(phase.shift.closed_at)} ` : ""}by ${phase.shift.closed_by ?? staff.name}`}
          </>
        }
        footer={
          <>
            <Button size="lg" variant="quiet" onPress={onShowReport} className={GREY_PILL}>
              View Z-report
            </Button>
            <Button size="lg" variant="primary" onPress={() => setPhase({ kind: "idle" })}>
              Done
            </Button>
          </>
        }
      >
        <dl className="rounded-tile bg-surface-2 px-5 py-3">
          <Row label="Float" cents={c.float} />
          <Row label="Cash payments" cents={c.cash_payments} />
          <Row label="Cash rounding" cents={c.rounding} />
          <Row label="Cash tips" cents={c.tips} />
          <Row label="Cash refunds" cents={-c.refunds} />
          <Row label="Expected" cents={c.expected} strong />
          <Row label="Counted" cents={c.counted ?? 0} strong />
          <Row label="Variance" cents={c.variance ?? 0} strong tone={(c.variance ?? 0) === 0 ? "paid" : varianceThreshold !== undefined && Math.abs(c.variance ?? 0) > varianceThreshold ? "alert" : undefined} />
          {phase.shift.variance_reason ? <p className="pt-2 text-caption text-ink-2">Reason: {phase.shift.variance_reason}</p> : null}
        </dl>
      </Card>
    );
  }

  /* ---- Variance reason ---- */
  if (phase.kind === "reason") {
    const c = phase.cash;
    const reason = phase.reason ?? null;
    return (
      <Card
        title={c.variance != null ? `Variance ${money(c.variance)}` : "Count outside the allowed variance"}
        sub={c.expected != null ? `The register expected ${money(c.expected)} and you counted ${money(c.counted)}. Above ${money(c.variance_threshold)} a reason is recorded with the close.` : `You counted ${money(c.counted)}, more than ${money(c.variance_threshold)} away from what the register expects. Count again, or close with a reason; the figures show once the shift is closed.`}
        footer={
          <>
            <Button size="lg" variant="quiet" isDisabled={busy} onPress={() => setPhase({ kind: "count" })} className={GREY_PILL}>
              Count again
            </Button>
            <Button size="lg" variant="primary" isDisabled={offline || busy || !reason} isPending={busy} onPress={() => reason && void close(reason)}>
              {offline ? "Offline" : reason ? "Close shift" : "Choose a reason"}
            </Button>
          </>
        }
      >
        {c.expected != null && c.variance != null ? (
          <dl className="rounded-tile bg-surface-2 px-5 py-3">
            <Row label="Expected" cents={c.expected} />
            <Row label="Counted" cents={c.counted} />
            <Row label="Variance" cents={c.variance} strong tone="alert" />
          </dl>
        ) : null}
        <ReasonPicker reasons={VARIANCE_REASONS.map((r) => ({ id: r, name: r }))} isDisabled={busy} selected={reason} onPick={(r) => setPhase({ kind: "reason", cash: c, reason: r.text })} />
      </Card>
    );
  }

  /* ---- Count (before expected is shown) ---- */
  if (phase.kind === "count" && mine) {
    return (
      <Card
        title="Count the cash"
        sub="Everything in the drawer, float included. The register shows what it expected after you count."
        footer={
          <>
            <Button size="lg" variant="quiet" isDisabled={busy} onPress={() => setPhase({ kind: "checklist" })} className={GREY_PILL}>
              Back to the checklist
            </Button>
            <Button size="lg" variant="primary" isDisabled={offline || busy || (mode === "total" && digits === "")} isPending={busy} onPress={() => void close(null)}>
              {offline ? "Offline" : `Close shift · counted ${money(total)}`}
            </Button>
          </>
        }
      >
        <CashCounter mode={mode} onModeChange={setMode} totalDigits={digits} onTotalDigitsChange={setDigits} counts={counts} onCountsChange={setCounts} denominations={denominations} isDisabled={busy} totalLabel="Cash counted in the drawer" />
      </Card>
    );
  }

  /* ---- Checklist ---- */
  if (phase.kind === "checklist" && mine) {
    return (
      <Card
        title="Before closing"
        sub="From the register, right now. Resolve each item or leave it for the next shift."
        footer={
          <>
            <Button size="lg" variant="quiet" onPress={() => setPhase({ kind: "idle" })} className={GREY_PILL}>
              Not now
            </Button>
            <Button size="lg" variant="primary" isDisabled={!checklistDone} onPress={() => setPhase({ kind: "count" })}>
              {checklistDone ? "Next: count the cash" : checking ? (offline ? "Offline" : "Checking the register…") : "Resolve or leave each item"}
            </Button>
          </>
        }
      >
        <Checklist items={checklist} />
      </Card>
    );
  }

  /* ---- Idle: open shift, or the open shift's summary ---- */
  if (!mine) {
    // Off until a float is entered (a typed $0.00 is a float); the counter's total is always entered.
    const entered = mode === "counts" || digits !== "";
    return (
      <Card
        title="Open shift"
        sub={
          <>
            No shift is open on this station. Open one with the float in the drawer; cash taken here is then counted against it.
            {lastClosed ? ` Last close: ${money(lastClosed.float_cents)} float${lastClosed.closed_at ? `, ${clock(lastClosed.closed_at)}` : ""}.` : ""}
          </>
        }
        footer={
          <>
            {!canOpen ? <p className="text-body text-ink-2">Opening a shift needs a Cashier or above. Switch user to open it.</p> : null}
            <Button size="lg" variant="primary" isDisabled={offline || busy || !canOpen || !entered || over} isPending={busy} onPress={doOpen}>
              {offline ? "Offline" : entered ? `Open shift with ${money(total)}` : "Open shift"}
            </Button>
          </>
        }
      >
        <CashCounter mode={mode} onModeChange={setMode} totalDigits={digits} onTotalDigitsChange={setDigits} counts={counts} onCountsChange={setCounts} denominations={denominations} isDisabled={busy || !canOpen} totalLabel="Opening float" max={cap} />
      </Card>
    );
  }

  return (
    <Card
      title="Shift open"
      sub={
        <>
          Since {clock(mine.opened_at)} · opened by {mine.opened_by ?? "—"}
          {mine.name ? ` · ${mine.name}` : ""}
          {mine.station_id === null ? " · whole outlet" : ""}
        </>
      }
      footer={
        <>
          {!canOpen ? <p className="text-body text-ink-2">Closing a shift needs a Cashier or above.</p> : null}
          <Button size="lg" variant="primary" isDisabled={offline || !canOpen} onPress={startClose}>
            {offline ? "Offline" : "Close shift"}
          </Button>
        </>
      }
    >
      <dl>
        <Row label="Opening float" cents={mine.float_cents} />
        <div className="flex min-h-10 items-center justify-between gap-3">
          {/* The register works out expected cash for this shift at the close, after the blind count. */}
          <dt className="text-body text-ink-2">Expected and variance</dt>
          <dd className="text-body text-ink-2">after the count</dd>
        </div>
        {mine.float_counts ? <p className="pt-1 text-caption text-ink-2">Float counted by denomination at open.</p> : null}
      </dl>
    </Card>
  );
}

/**
 * The station's shift as a panel ("This station's shift", a header divider row), the current step's title and line
 * under it, the step's content in a body that scrolls on its own, and the step's actions pinned at the foot, so the
 * primary action stays on screen at every iPad size however long the count runs.
 */
function Card({ title, sub, children, footer }: { title: string; sub: ReactNode; children: ReactNode; footer: ReactNode }) {
  return (
    <section className="flex max-h-full min-h-0 w-full flex-col overflow-hidden rounded-panel border border-rule bg-surface" aria-label="This station's shift">
      <p className="shrink-0 border-b border-rule px-5 py-3.5 font-heading text-[16px] font-semibold text-ink">This station&rsquo;s shift</p>
      <div className="shrink-0 px-5 pt-4 pb-3">
        <h2 className="font-heading text-[18px] leading-tight font-semibold text-ink">{title}</h2>
        <p className="mt-0.5 text-body text-ink-2">{sub}</p>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 pb-5">{children}</div>
      {/* A full-width pill; a second action sits under it, the primary always on top. */}
      <div className="flex shrink-0 flex-col-reverse gap-2 px-5 pt-1 pb-5 [&>button]:w-full">{footer}</div>
    </section>
  );
}

export function Row({ label, cents, strong, tone, indent }: { label: string; cents: number; strong?: boolean; tone?: "paid" | "alert"; indent?: boolean }) {
  return (
    <div className={strong ? "flex min-h-10 items-center justify-between gap-3 pt-1 border-t border-rule first:border-t-0 first:pt-0" : "flex min-h-8 items-center justify-between gap-3"}>
      <dt className={strong ? "text-body font-semibold text-ink" : cx("text-body text-ink-2", indent && "pl-3")}>{label}</dt>
      <dd>
        {/* A total is the same size as its rows, in semibold, so the panels keep one scale. */}
        <Money cents={cents} size="body" className={cx(strong && "font-semibold", tone === "paid" ? "text-status-paid" : tone === "alert" ? "text-status-alert" : "text-ink")} />
      </dd>
    </div>
  );
}
