"use client";

import { BackButton, Badge, BillCard, Button, Checkbox, formatCents, Icon, Money, QuantityStepper, SegmentedControl, Sheet, Skeleton, type BillCardLine, type BillCardRow } from "@sail/ui";
import { Check } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button as AriaButton } from "react-aria-components";
import type { CheckSnapshot, OrderSnapshot, SnapshotLine } from "../api/types";
import { Frame } from "../components/Frame";
import { usePos } from "../components/PosContext";
import { RefundSheet } from "../components/RefundSheet";
import { useOrder } from "../hooks/queries";
import { roleAtLeast, useOrderActions } from "../hooks/useOrderActions";
import { ORDER_TYPE_LABEL } from "../lib/format";
import { useNavStore } from "../state/nav";
import { useUiStore } from "../state/ui";

type Mode = "one" | "even" | "seat" | "item";

const MODE_LABEL: Record<Mode, string> = { one: "One", even: "Even", seat: "Seat", item: "Item" };
const FRACTIONS: Record<string, string> = { "1/2": "½", "1/3": "⅓", "1/4": "¼", "1/5": "⅕", "1/6": "⅙", "1/8": "⅛" };

/** How the bills are currently split, read from the register's allocations. */
function detectMode(order: OrderSnapshot): Mode {
  const checks = order.checks;
  if (checks.length <= 1) return "one";
  if (checks.every((c) => c.seat_no != null)) return "seat";
  const n = checks.length;
  const live = order.lines.filter((l) => l.status !== "voided");
  const even = live.length > 0 && live.every((l) => checks.every((c) => c.allocations.some((a) => a.line_id === l.id && a.share === `1/${n}`)));
  return even ? "even" : "item";
}

export const shareText = (share: string) => FRACTIONS[share] ?? (share === "1" ? "" : share);

export function billLabel(check: CheckSnapshot): string {
  return check.seat_no != null ? `${check.label} · Seat ${check.seat_no}` : check.label;
}

/** Rows under a bill's lines: every figure as the register returned it. */
export function billRows(check: CheckSnapshot, inclusive: boolean): BillCardRow[] {
  const rows: BillCardRow[] = [];
  if (check.totals.discount_total !== 0) rows.push({ key: "discount", label: "Discounts", cents: check.totals.discount_total });
  if (check.totals.fee_total !== 0) rows.push({ key: "fee", label: "Service and fees", cents: check.totals.fee_total });
  rows.push({ key: "gst", label: inclusive ? "Includes GST" : "GST", cents: check.totals.gst_total });
  rows.push({ key: "total", label: "Total", cents: check.totals.total, kind: "total" });
  if (check.paid_total > 0) rows.push({ key: "paid", label: "Paid", cents: check.paid_total, kind: "paid" });
  if (check.rounding_total !== 0) rows.push({ key: "rounding", label: "Cash rounding", cents: check.rounding_total });
  if (check.refunded_total > 0) rows.push({ key: "refunded", label: "Refunded", cents: -check.refunded_total });
  if (check.paid_total > 0 && check.status === "open") rows.push({ key: "balance", label: "Balance", cents: check.balance, kind: "balance" });
  return rows;
}

/**
 * The Bill screen (design 4.4): One / Even / By seat / By item, bills as
 * cards with the register's figures, "✓ Bills add up to", Pre-bill and Pay
 * per bill, and the lock on paid bills.
 */
export function BillScreen({ orderId }: { orderId: string }) {
  const { tablesById, offline, staff } = usePos();
  const back = useNavStore((s) => s.back);
  const openPay = useNavStore((s) => s.openPay);
  const notify = useUiStore((s) => s.notify);
  const inFlight = useUiStore((s) => (s.inFlight[orderId] ?? 0) > 0);
  const order = useOrder(orderId);
  const actions = useOrderActions(orderId);
  const snap = order.data;

  const [mode, setMode] = useState<Mode | null>(null);
  const [shared, setShared] = useState<"even" | "manual">("even");
  const [selectedLine, setSelectedLine] = useState<string | null>(null);
  const [sharing, setSharing] = useState<SnapshotLine | null>(null);
  const [refundCheck, setRefundCheck] = useState<CheckSnapshot | null>(null);
  const [evenN, setEvenN] = useState<number | null>(null);
  const evenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (snap && mode === null) setMode(detectMode(snap));
  }, [snap, mode]);
  useEffect(() => {
    if (snap && (snap.status === "cancelled" || snap.status === "completed")) back();
  }, [snap, back]);

  const live = useMemo(() => (snap?.lines ?? []).filter((l) => l.status !== "voided" && !l.optimistic), [snap]);
  const linesById = useMemo(() => new Map(live.map((l) => [l.id, l])), [live]);
  const paidChecks = useMemo(() => (snap?.checks ?? []).filter((c) => c.locked || c.payments.length > 0 || c.status !== "open"), [snap]);
  const lockReason = paidChecks.length ? `${paidChecks[0]!.label} is paid. Refund it to change the split.` : null;
  const lockedLineIds = useMemo(() => new Set(paidChecks.flatMap((c) => c.allocations.map((a) => a.line_id))), [paidChecks]);
  const sum = (snap?.checks ?? []).reduce((s, c) => s + c.totals.total, 0);
  const inclusive = snap?.totals.tax_mode === "inclusive";
  const canPay = roleAtLeast(staff.role, "cashier");

  if (!snap || mode === null) {
    return (
      <Frame left={<BackButton label="Order" onPress={back} />} title="Bill">
        <div className="flex flex-1 gap-4 p-4">
          <Skeleton className="h-full w-[300px]" />
          <Skeleton className="h-full flex-1" />
        </div>
      </Frame>
    );
  }

  const table = snap.table_id ? tablesById.get(snap.table_id) : null;
  const backLabel = snap.order_type === "dine_in" ? `Table ${table?.name ?? ""}` : snap.order_no;
  const title = ["Bill", snap.pax ? `${snap.pax} ${snap.pax === 1 ? "guest" : "guests"}` : ORDER_TYPE_LABEL[snap.order_type], `Total ${formatCents(snap.totals.total)}`].join(" · ");

  const switchMode = async (next: Mode) => {
    if (next === mode) return;
    setSelectedLine(null);
    const prev = mode;
    setMode(next);
    let ok: OrderSnapshot | null = null;
    if (next === "one") ok = await actions.unsplit();
    else if (next === "even") {
      const n = Math.min(20, Math.max(2, snap.pax ?? 2));
      setEvenN(n);
      ok = await actions.splitEven(n);
    } else if (next === "seat") ok = await actions.splitBySeat(shared);
    else ok = snap.checks.length >= 2 ? snap : await actions.splitEven(2);
    if (!ok) setMode(prev);
  };

  /** The register keeps no empty bill, so another bill means an even re-split first; items are then moved by hand. */
  const addBill = async () => {
    const n = Math.min(20, snap.checks.length + 1);
    const res = await actions.splitEven(n);
    if (res) notify({ text: `${n} bills, shared evenly again`, remedy: "Move items between them by tapping.", tone: "info", orderId }, 5000);
  };

  const changeEven = (n: number) => {
    setEvenN(n);
    if (evenTimer.current) clearTimeout(evenTimer.current);
    evenTimer.current = setTimeout(() => void actions.splitEven(n), 250);
  };

  const changeShared = async (s: "even" | "manual") => {
    setShared(s);
    await actions.splitBySeat(s);
  };

  const moveTo = async (check: CheckSnapshot) => {
    if (!selectedLine) return;
    const line = linesById.get(selectedLine);
    setSelectedLine(null);
    const snapAfter = await actions.allocate([{ line_id: selectedLine, check_ids: [check.id] }]);
    if (snapAfter && line) notify({ text: `${line.name} moved to ${check.label}`, tone: "info", orderId }, 3000);
  };

  const shareBetween = async (line: SnapshotLine, checkIds: string[]) => {
    setSharing(null);
    setSelectedLine(null);
    await actions.allocate([{ line_id: line.id, check_ids: checkIds }]);
  };

  const whereIs = (lineId: string): string => {
    const on = snap.checks.filter((c) => c.allocations.some((a) => a.line_id === lineId));
    if (on.length === 0) return "Not on a bill";
    if (on.length === 1) return on[0]!.label;
    const share = on[0]!.allocations.find((a) => a.line_id === lineId)?.share ?? "";
    return `Shared ${on.map(() => shareText(share) || share).join("·")}`;
  };

  const canPick = (mode === "item" || (mode === "seat" && shared === "manual")) && !offline;
  const modeOptions = (["one", "even", "seat", "item"] as Mode[]).map((m) => ({
    id: m,
    label: MODE_LABEL[m],
    isDisabled: Boolean(lockReason) && m !== mode,
    reason: lockReason,
  }));

  const cardLines = (check: CheckSnapshot): BillCardLine[] =>
    check.allocations
      .map((a) => ({ a, line: linesById.get(a.line_id) }))
      .filter((x) => x.line)
      .map(({ a, line }) => ({
        id: a.line_id,
        name: `${line!.quantity} ${line!.name}`,
        share: shareText(a.share) || null,
        detail: line!.modifiers.length ? line!.modifiers.map((m) => m.name).join(", ") : null,
        amountCents: a.total,
        isSelected: selectedLine === a.line_id,
        isDisabled: check.locked || lockedLineIds.has(a.line_id),
        onPress: canPick && !check.locked ? () => setSelectedLine(selectedLine === a.line_id ? null : a.line_id) : undefined,
      }));

  const payFor = (check: CheckSnapshot) => {
    if (offline) return;
    openPay(orderId, check.id, "bill");
  };

  return (
    <Frame
      left={<BackButton label={backLabel} onPress={back} />}
      title={title}
      right={<SegmentedControl aria-label="Split mode" options={modeOptions} selectedId={mode} onSelect={(id) => void switchMode(id as Mode)} onDisabledPress={(o) => notify({ text: o.reason ?? "This split is locked", tone: "info", orderId }, 5000)} />}
    >
      <div className="flex min-h-0 flex-1">
        {mode === "item" || (mode === "seat" && shared === "manual") ? (
          <section className="flex w-[320px] shrink-0 flex-col hairline-r bg-surface" aria-label="Lines">
            <header className="px-4 pt-4 pb-2">
              <h2 className="text-caption text-ink-2 uppercase tracking-[0.04em]">Lines</h2>
              <p className="text-caption text-ink-2">{selectedLine ? "Now tap the bill to move it to." : "Tap a line, then a bill."}</p>
            </header>
            <ul className="min-h-0 flex-1 overflow-y-auto px-2">
              {live.map((l) => {
                const locked = lockedLineIds.has(l.id);
                const selected = selectedLine === l.id;
                return (
                  <li key={l.id}>
                    <AriaButton
                      onPress={() => setSelectedLine(selected ? null : l.id)}
                      isDisabled={locked || offline}
                      aria-pressed={selected}
                      aria-description={locked ? lockReason ?? undefined : undefined}
                      className={
                        "press pos-touch flex min-h-14 w-full items-center gap-2 rounded-tile px-3 py-2 text-left outline-none data-[pressed]:bg-surface-2 data-[hovered]:bg-surface-2 data-[disabled]:opacity-45 data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-[-2px] data-[focus-visible]:outline-status-seated " +
                        (selected ? "bg-[color-mix(in_srgb,var(--status-seated)_14%,transparent)] shadow-[inset_0_0_0_1.5px_var(--status-seated)]" : "")
                      }
                    >
                      <span className="w-6 shrink-0 text-line tabular text-ink">{l.quantity}</span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2 text-line text-ink">
                          <span className="truncate">{l.name}</span>
                          {l.seat_no != null ? <span className="shrink-0 rounded-chip bg-surface-2 px-2 text-caption text-ink-2 tabular">S{l.seat_no}</span> : null}
                        </span>
                        <span className="block truncate text-caption text-ink-2">{whereIs(l.id)}</span>
                      </span>
                      <Money cents={l.amounts.total} size="line" className="text-ink" />
                    </AriaButton>
                  </li>
                );
              })}
            </ul>
            <footer className="flex flex-col gap-2 p-3 hairline-t">
              <Button size="lg" variant="secondary" isDisabled={!selectedLine || offline || snap.checks.length < 2} onPress={() => setSharing(selectedLine ? (linesById.get(selectedLine) ?? null) : null)}>
                Share between bills…
              </Button>
              <Button size="lg" variant="quiet" isDisabled={offline || snap.checks.length >= 20 || Boolean(lockReason)} onPress={() => void addBill()}>
                Split into {Math.min(20, snap.checks.length + 1)} bills
              </Button>
            </footer>
          </section>
        ) : null}

        <section className="flex min-w-0 flex-1 flex-col">
          {mode === "even" ? (
            <div className="flex items-center gap-4 px-5 pt-3">
              <span className="text-line text-ink">Split evenly between</span>
              <QuantityStepper value={evenN ?? snap.checks.length} onChange={changeEven} min={2} max={20} label="Number of bills" />
              <span className="text-line text-ink">bills</span>
              {inFlight ? <span className="text-caption text-ink-2">Checking…</span> : snap.checks[0] ? <span className="text-caption text-ink-2 tabular">{formatCents(snap.checks[0].totals.total)} each</span> : null}
            </div>
          ) : null}
          {mode === "seat" ? (
            <div className="flex items-center gap-4 px-5 pt-3">
              <span className="text-line text-ink">Shared lines</span>
              <SegmentedControl aria-label="Shared lines" options={[{ id: "even", label: "Split evenly", isDisabled: Boolean(lockReason), reason: lockReason }, { id: "manual", label: "Assign by hand", isDisabled: Boolean(lockReason), reason: lockReason }]} selectedId={shared} onSelect={(id) => void changeShared(id as "even" | "manual")} onDisabledPress={() => notify({ text: lockReason ?? "", tone: "info", orderId }, 5000)} />
            </div>
          ) : null}
          <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-5 py-3">
            {snap.checks.map((check) => {
              const paid = check.status !== "open";
              return (
                <BillCard
                  key={check.id}
                  label={billLabel(check)}
                  status={check.status}
                  lines={cardLines(check)}
                  rows={billRows(check, inclusive)}
                  tenders={check.payments.filter((p) => p.status !== "voided").map((p) => ({ id: p.id, label: `${p.tender}${p.reference ? ` · ${p.reference}` : ""}`, cents: p.amount }))}
                  isTarget={Boolean(selectedLine) && !check.locked}
                  onPress={selectedLine && !check.locked ? () => void moveTo(check) : undefined}
                  actions={
                    paid ? (
                      <>
                        <Button size="md" variant="quiet" isDisabled={offline} onPress={() => void actions.printReceipt(check.id)}>
                          Receipt
                        </Button>
                        <Button size="md" variant="quiet" isDisabled={offline} onPress={() => void actions.issueInvoice(check.id)}>
                          {check.invoice_no ? `Invoice ${check.invoice_no}` : "Get invoice"}
                        </Button>
                        <Button size="md" variant="secondary" isDisabled={offline || check.status === "refunded"} onPress={() => setRefundCheck(check)}>
                          Refund
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button size="lg" variant="secondary" isDisabled={offline} onPress={() => void actions.prebill(check.id)}>
                          Pre-bill
                        </Button>
                        <Button size="lg" variant="primary" isDisabled={offline || check.balance <= 0 || live.length === 0} onPress={() => payFor(check)} className="gap-1">
                          Pay {formatCents(check.balance)} ▸{!canPay ? <Badge tone="bill">Manager approval</Badge> : null}
                        </Button>
                      </>
                    )
                  }
                />
              );
            })}
          </div>
          <footer className="flex h-[72px] shrink-0 items-center gap-3 px-5 hairline-t bg-surface">
            {inFlight ? (
              <span className="text-line text-ink-2">Checking…</span>
            ) : sum === snap.totals.total ? (
              <span className="inline-flex items-center gap-2 text-line text-ink">
                <Icon icon={Check} size={20} className="text-status-paid" /> Bills add up to {formatCents(sum)}
              </span>
            ) : (
              <span className="text-line text-status-alert tabular">
                Bills add up to {formatCents(sum)} · order total {formatCents(snap.totals.total)}
              </span>
            )}
            <div className="flex-1" />
            <Button size="lg" variant="secondary" isDisabled={offline || snap.checks.every((c) => c.status !== "open")} onPress={() => void actions.prebill(null)}>
              {snap.checks.filter((c) => c.status === "open").length > 1 ? "Print all pre-bills" : "Print pre-bill"}
            </Button>
            <Button size="lg" variant="primary" onPress={back} className="min-w-[140px]">
              Done
            </Button>
          </footer>
        </section>
      </div>

      <ShareSheet line={sharing} checks={snap.checks} onClose={() => setSharing(null)} onShare={shareBetween} />
      <RefundSheet isOpen={Boolean(refundCheck)} onClose={() => setRefundCheck(null)} order={snap} actions={actions} initialCheckId={refundCheck?.id ?? null} />
    </Frame>
  );
}

/** "Share between bills…" (design 4.4): pick the bills for an equal share, such as the wine three ways. */
function ShareSheet({ line, checks, onClose, onShare }: { line: SnapshotLine | null; checks: CheckSnapshot[]; onClose: () => void; onShare: (line: SnapshotLine, checkIds: string[]) => void }) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (line) setPicked(new Set(checks.filter((c) => !c.locked && c.allocations.some((a) => a.line_id === line.id)).map((c) => c.id)));
  }, [line, checks]);
  const open = checks.filter((c) => !c.locked);
  return (
    <Sheet
      isOpen={Boolean(line)}
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={line ? `Share ${line.name}` : ""}
      description="Equal shares between the bills you pick. The register works out each share."
      footer={
        <Button variant="primary" size="lg" isDisabled={!line || picked.size === 0} onPress={() => line && onShare(line, [...picked])}>
          {picked.size <= 1 ? (picked.size === 1 ? `Move to ${checks.find((c) => picked.has(c.id))?.label ?? "the bill"}` : "Pick at least one bill") : `Share between ${picked.size} bills`}
        </Button>
      }
    >
      <div className="flex flex-col gap-1">
        {open.map((c) => (
          <Checkbox
            key={c.id}
            isSelected={picked.has(c.id)}
            onChange={(on) => {
              const next = new Set(picked);
              if (on) next.add(c.id);
              else next.delete(c.id);
              setPicked(next);
            }}
          >
            <span className="text-line">{billLabel(c)}</span>
          </Checkbox>
        ))}
        {checks.some((c) => c.locked) ? <p className="pt-2 text-caption text-ink-2">Paid bills are locked and not listed.</p> : null}
      </div>
    </Sheet>
  );
}

