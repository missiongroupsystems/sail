"use client";

import { BrandButton, cx, Icon, InlineError, Money, Pill, RoundTimeline, useLocale, type PillTone, type RoundStage } from "@sail/ui";
import { Ban, Check, CheckCheck, ChefHat, ChevronRight, CircleAlert, ReceiptText, Send, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button as AriaButton } from "react-aria-components";
import type { ApiError } from "@/lib/api";
import { roundStage } from "@/lib/status";
import type { GuestStreamStatus } from "@/lib/stream";
import type { GuestLine, GuestRound, GuestSession, OrderView } from "@/lib/types";
import { Dock, PageHeader } from "./Shell";
import { TotalsPanel } from "./TotalsPanel";

export type StatusViewProps = {
  session: GuestSession;
  orderView: OrderView | null;
  loading: boolean;
  /** The register's error when the order view could not be read (shown with its remedy). */
  error: ApiError | null;
  lastRoundId: string | null;
  streamStatus: GuestStreamStatus | null;
  onOrderMore: () => void;
  onCallStaff: () => void;
  onOurTable: () => void;
};

/** "1 × Noodle soup (Chicken, Less spicy)" from a guest line, with its note under it and the register's amount at the right. Long text wraps inside the card. */
export function LineText({ line, struck = false }: { line: GuestLine; struck?: boolean }) {
  return (
    <span className="flex items-start gap-4">
      <LineWords line={line} struck={struck} />
      {line.amount != null && !struck ? <Money cents={line.amount} size="body" className="shrink-0 text-[15.5px] leading-snug text-ink" /> : null}
    </span>
  );
}

function LineWords({ line, struck }: { line: GuestLine; struck: boolean }) {
  return (
    <span className={cx("block min-w-0 flex-1 wrap-anywhere", struck && "text-ink-3 line-through")}>
      <span className={cx("block text-[15.5px] leading-snug", struck ? "text-ink-3" : "text-ink")}>
        <span className="font-medium tabular">{line.quantity} ×</span> {line.name}
        {line.modifiers.length ? <span className="text-ink-2"> ({line.modifiers.join(", ")})</span> : null}
      </span>
      {line.notes ? <span className="block text-[13.5px] leading-snug text-ink-2 italic">Note: {line.notes}</span> : null}
    </span>
  );
}

/** The word, tone and icon for a round's stage, as a status pill. */
export function stagePill(stage: RoundStage, holdOrders: boolean): { label: string; tone: PillTone; icon: LucideIcon } {
  switch (stage) {
    case "sent":
      return { label: "Sent", tone: "seated", icon: Send };
    case "accepted":
      return { label: holdOrders ? "Accepted" : "Received", tone: "seated", icon: Check };
    case "preparing":
      return { label: "Preparing", tone: "sent", icon: ChefHat };
    case "done":
      return { label: "Done", tone: "paid", icon: CheckCheck };
    case "rejected":
      return { label: "Not accepted", tone: "alert", icon: Ban };
  }
}

/** The order status page: the round's timeline, live, in a card with its items, earlier rounds, and what happens next. */
export function StatusView({ session, orderView, loading, error, lastRoundId, streamStatus, onOrderMore, onCallStaff, onOurTable }: StatusViewProps) {
  const { clock } = useLocale();
  const order = orderView?.order ?? null;
  const mine = (orderView?.rounds ?? []).filter((r) => r.mine).sort((a, b) => b.submitted_at.localeCompare(a.submitted_at));
  const highlighted = mine.find((r) => r.id === lastRoundId) ?? mine[0] ?? null;
  const others = mine.filter((r) => r.id !== highlighted?.id);
  const linesOf = (r: GuestRound) => (orderView?.lines ?? []).filter((l) => r.line_ids.includes(l.id));

  return (
    <>
      <PageHeader title={`Table ${session.table.name}`} subtitle={order ? `Order ${order.order_no}` : undefined} onBack={onOrderMore} backLabel="Back to the menu" />

      <main className="flex w-full min-w-0 flex-col gap-4 px-4 pb-44 pt-4">
        {highlighted ? <SentBanner rejected={highlighted.status === "rejected"} waiting={highlighted.status === "pending"} at={clock(highlighted.submitted_at)} guestName={highlighted.guest_name} /> : null}
        {!orderView && loading ? <p className="text-[15px] text-ink-2">Checking with the kitchen…</p> : null}
        {!orderView && error ? <InlineError error={{ message: error.message, remedy: error.remedy ?? "Try again in a moment." }} /> : null}
        {orderView && !highlighted ? <p className="py-8 text-center text-[15px] text-ink-2">No orders have been sent from this phone yet.</p> : null}

        {highlighted ? (
          <section aria-label="Latest order" className="flex flex-col rounded-sheet border border-rule bg-surface">
            <RoundHead title="Your order" at={`Sent ${clock(highlighted.submitted_at)}`} pill={stagePill(roundStage(highlighted, order), session.hold_orders)} />
            <RoundTimeline stage={roundStage(highlighted, order)} rejectReason={highlighted.reject_reason} holdOrders={session.hold_orders} className="border-t border-rule-subtle px-4 py-3" />
            <div className="border-t border-rule-subtle px-4">
              <RoundLines round={highlighted} lines={linesOf(highlighted)} />
            </div>
          </section>
        ) : null}

        {others.length ? (
          <section aria-label="Earlier orders" className="flex flex-col gap-3">
            <h2 className="pt-2 font-display text-[16px] font-semibold tracking-tight text-ink">Earlier from this phone</h2>
            {others.map((r) => {
              const stage = roundStage(r, order);
              return (
                <div key={r.id} className="flex flex-col rounded-sheet border border-rule bg-surface">
                  <RoundHead title={r.guest_name ?? "Your order"} at={`Sent ${clock(r.submitted_at)}`} pill={stagePill(stage, session.hold_orders)} />
                  {stage === "rejected" && r.reject_reason ? <p className="px-4 pb-2 text-[13.5px] text-ink-2 wrap-anywhere">{r.reject_reason}</p> : null}
                  <div className="border-t border-rule-subtle px-4">
                    <RoundLines round={r} lines={linesOf(r)} />
                  </div>
                </div>
              );
            })}
          </section>
        ) : null}

        {orderView?.totals && orderView.lines.some((l) => l.status !== "voided") ? <TotalsPanel totals={orderView.totals} /> : null}
        <p className="px-1 text-[14px] leading-snug text-ink-2">Pay at the counter or ask your server for the bill.</p>
        <AriaButton
          onPress={onOurTable}
          className="press flex min-h-14 w-full items-center gap-3 rounded-sheet border border-rule px-4 py-3 text-left outline-none transition-colors duration-[120ms] data-[hovered]:bg-surface-2 data-[pressed]:bg-surface-2 data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-focus"
        >
          <Icon icon={ReceiptText} size={20} className="text-ink-2" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-[15.5px] font-medium text-ink">Our table</span>
            <span className="text-[13.5px] text-ink-2">See everything the table has ordered</span>
          </span>
          <Icon icon={ChevronRight} size={20} className="text-ink-3" />
        </AriaButton>
        {streamStatus === "reconnecting" ? (
          <p role="status" className="text-caption text-ink-2">
            Reconnecting… updates may be a moment behind.
          </p>
        ) : null}
      </main>

      <Dock>
        <div className="flex items-center gap-2.5">
          <BrandButton variant="secondary" className="min-h-14 flex-1 text-[16px]" onPress={onCallStaff}>
            Call staff
          </BrandButton>
          <BrandButton variant="accent" className="min-h-14 flex-[1.4] text-[16.5px]" onPress={onOrderMore}>
            Order more
          </BrandButton>
        </div>
      </Dock>
    </>
  );
}

/** The banner under the header after a send: green "Order sent", or "Order not accepted" when staff turned it down. */
function SentBanner({ rejected, waiting, at, guestName }: { rejected: boolean; waiting: boolean; at: string; guestName: string | null }) {
  const sub = rejected ? "Staff could not accept it. Ask them, or order again." : waiting ? "Staff will accept it in a moment." : "The kitchen is preparing it.";
  return (
    <div role="status" className={cx("flex items-start gap-3 rounded-sheet px-4 py-3.5", rejected ? "bg-status-alert-tint" : "bg-status-paid-tint")}>
      <Icon icon={rejected ? CircleAlert : Check} size={20} className={cx("mt-0.5 shrink-0", rejected ? "text-status-alert" : "text-status-paid")} />
      <div className="min-w-0">
        <h2 className={cx("font-display text-[16px] leading-snug font-semibold", rejected ? "text-status-alert" : "text-status-paid")}>
          {/* The banner follows the order: sent while staff accept it, accepted once they have (the pill then says Preparing). */}
          {rejected ? "Order not accepted" : waiting ? "Order sent" : "Order accepted"}
        </h2>
        <p className="text-[14px] leading-snug text-ink-2 wrap-anywhere">
          {sub}
          <span className="tabular">
            {" "}
            {at}
            {guestName ? ` · ${guestName}` : ""}
          </span>
        </p>
      </div>
    </div>
  );
}

/** A round card's head: who and when on the left, the stage as a pill on the right. */
export function RoundHead({ title, at, pill, extra }: { title: string; at: string; pill: { label: string; tone: PillTone; icon: LucideIcon }; extra?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 pt-3.5 pb-2.5">
      <div className="min-w-0">
        <p className="flex items-center gap-2 font-display text-[15.5px] font-semibold text-ink">
          <span className="min-w-0 truncate">{title}</span>
          {extra}
        </p>
        <p className="text-[13px] text-ink-3 tabular">{at}</p>
      </div>
      <Pill tone={pill.tone} icon={pill.icon}>
        {pill.label}
      </Pill>
    </div>
  );
}

function RoundLines({ round, lines }: { round: GuestRound; lines: GuestLine[] }) {
  if (!lines.length) return <p className="py-3 text-[13.5px] text-ink-2">{round.line_ids.length} {round.line_ids.length === 1 ? "item" : "items"}</p>;
  return (
    <ul className="flex flex-col divide-y divide-rule-subtle" aria-label="Items in this order">
      {lines.map((l) => (
        <li key={l.id} className="py-3">
          <LineText line={l} struck={l.status === "voided"} />
        </li>
      ))}
    </ul>
  );
}
