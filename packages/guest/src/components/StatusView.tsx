"use client";

import { BrandButton, RoundTimeline } from "@sail/ui";
import { formatClock } from "@/lib/format";
import { roundStage } from "@/lib/status";
import type { GuestStreamStatus } from "@/lib/stream";
import type { GuestLine, GuestRound, GuestSession, OrderView } from "@/lib/types";

export type StatusViewProps = {
  session: GuestSession;
  orderView: OrderView | null;
  loading: boolean;
  lastRoundId: string | null;
  streamStatus: GuestStreamStatus | null;
  onOrderMore: () => void;
  onCallStaff: () => void;
  onOurTable: () => void;
};

/** "Laksa (Chicken, Less spicy) ×1" from a guest line. */
export function LineText({ line }: { line: GuestLine }) {
  return (
    <span className="flex items-baseline justify-between gap-3">
      <span className="min-w-0 text-body text-ink">
        {line.name}
        {line.modifiers.length ? <span className="text-ink-2"> ({line.modifiers.join(", ")})</span> : null}
        {line.notes ? <span className="block text-caption text-ink-2">Note: {line.notes}</span> : null}
      </span>
      <span className="shrink-0 text-body tabular text-ink-2">×{line.quantity}</span>
    </span>
  );
}

/** The order status page (design 4.11): the round's timeline, live, its items, and what happens next. */
export function StatusView({ session, orderView, loading, lastRoundId, streamStatus, onOrderMore, onCallStaff, onOurTable }: StatusViewProps) {
  const order = orderView?.order ?? null;
  const mine = (orderView?.rounds ?? []).filter((r) => r.mine).sort((a, b) => b.submitted_at.localeCompare(a.submitted_at));
  const highlighted = mine.find((r) => r.id === lastRoundId) ?? mine[0] ?? null;
  const others = mine.filter((r) => r.id !== highlighted?.id);
  const linesOf = (r: GuestRound) => (orderView?.lines ?? []).filter((l) => r.line_ids.includes(l.id));

  return (
    <>
      <header className="mx-auto w-full max-w-[560px] px-4 pt-[max(16px,env(safe-area-inset-top))]">
        <h1 className="font-display text-title text-ink">{highlighted ? (highlighted.status === "rejected" ? "Order not accepted" : "Order sent") : "Your order"}</h1>
        <p className="text-body text-ink-2 tabular">
          Table {session.table.name}
          {highlighted ? ` · ${formatClock(highlighted.submitted_at)}` : ""}
          {highlighted?.guest_name ? ` · ${highlighted.guest_name}` : ""}
        </p>
      </header>

      <main className="mx-auto flex w-full max-w-[560px] flex-col gap-8 px-4 pb-44 pt-6">
        {!orderView && loading ? <p className="text-body text-ink-2">Checking with the kitchen…</p> : null}
        {orderView && !highlighted ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-body text-ink-2">No orders have been sent from this phone yet.</p>
          </div>
        ) : null}

        {highlighted ? (
          <section aria-label="Latest order" className="flex flex-col gap-5">
            <RoundTimeline stage={roundStage(highlighted, order)} rejectReason={highlighted.reject_reason} holdOrders={session.hold_orders} />
            <RoundLines round={highlighted} lines={linesOf(highlighted)} />
          </section>
        ) : null}

        {others.length ? (
          <section aria-label="Earlier orders" className="flex flex-col gap-4">
            <h2 className="font-display text-heading text-ink">Earlier from this phone</h2>
            {others.map((r) => {
              const stage = roundStage(r, order);
              return (
                <div key={r.id} className="flex flex-col gap-2 rounded-tile bg-surface p-4 hairline">
                  <p className="flex items-baseline justify-between text-body">
                    <span className="text-ink-2 tabular">Sent {formatClock(r.submitted_at)}</span>
                    <span className={stage === "rejected" ? "text-status-alert" : "text-ink"}>{stageWord(stage, session.hold_orders)}</span>
                  </p>
                  {stage === "rejected" && r.reject_reason ? <p className="text-caption text-ink-2">{r.reject_reason}</p> : null}
                  <RoundLines round={r} lines={linesOf(r)} />
                </div>
              );
            })}
          </section>
        ) : null}

        <p className="text-body text-ink">Pay at the counter or ask your server for the bill.</p>
        <button type="button" onClick={onOurTable} className="press min-h-12 self-start text-left text-body text-brand-accent underline-offset-4 hover:underline">
          Our table: see everything the table has ordered
        </button>
        {streamStatus === "reconnecting" ? (
          <p role="status" className="text-caption text-ink-2">
            Reconnecting… updates may be a moment behind.
          </p>
        ) : null}
      </main>

      <div className="fixed inset-x-0 bottom-0 z-30 bg-bg/95 backdrop-blur-sm hairline-t">
        <div className="mx-auto grid w-full max-w-[560px] grid-cols-2 gap-3 px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3">
          <BrandButton variant="accent" className="min-h-14" onPress={onOrderMore}>
            Order more
          </BrandButton>
          <BrandButton className="min-h-14" onPress={onCallStaff}>
            Call staff
          </BrandButton>
        </div>
      </div>
    </>
  );
}

function stageWord(stage: ReturnType<typeof roundStage>, holdOrders: boolean): string {
  switch (stage) {
    case "sent":
      return "Sent";
    case "accepted":
      return holdOrders ? "Accepted" : "Received";
    case "preparing":
      return "Preparing";
    case "done":
      return "Done";
    case "rejected":
      return "Not accepted";
  }
}

function RoundLines({ round, lines }: { round: GuestRound; lines: GuestLine[] }) {
  if (!lines.length) return <p className="text-caption text-ink-2">{round.line_ids.length} {round.line_ids.length === 1 ? "item" : "items"}</p>;
  return (
    <ul className="flex flex-col gap-2" aria-label="Items in this order">
      {lines.map((l) => (
        <li key={l.id}>
          <LineText line={l} />
        </li>
      ))}
    </ul>
  );
}
