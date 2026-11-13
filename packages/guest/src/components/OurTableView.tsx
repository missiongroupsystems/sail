"use client";

import { BrandButton, Icon, InlineError, Pill, useLocale } from "@sail/ui";
import { ReceiptText, Utensils } from "lucide-react";
import type { ApiError } from "@/lib/api";
import { lineStatusLabel, lineStatusTone, roundStage } from "@/lib/status";
import type { GuestLine, GuestSession, OrderView } from "@/lib/types";
import { Dock, PageHeader } from "./Shell";
import { TotalsPanel } from "./TotalsPanel";
import { LineText, RoundHead, stagePill } from "./StatusView";

export type OurTableViewProps = {
  session: GuestSession;
  orderView: OrderView | null;
  loading: boolean;
  /** The register's error when the order view could not be read. */
  error: ApiError | null;
  onBack: () => void;
  onCallStaff: () => void;
  onOrderMore: () => void;
};

const pillTone = { sent: "sent", paid: "paid", seated: "seated", "ink-2": "neutral" } as const;
const yours = <span className="shrink-0 rounded-chip bg-surface-2 px-2 py-0.5 font-sans text-[12px] font-medium text-ink-2">Yours</span>;

/** "Our table": everything the table has ordered, a card per round with its stage, statuses on each line, this guest's items marked. */
export function OurTableView({ session, orderView, loading, error, onBack, onCallStaff, onOrderMore }: OurTableViewProps) {
  const { clock } = useLocale();
  const order = orderView?.order ?? null;
  const rounds = [...(orderView?.rounds ?? [])].sort((a, b) => a.submitted_at.localeCompare(b.submitted_at));
  const lines = orderView?.lines ?? [];
  const inRound = new Set(rounds.flatMap((r) => r.line_ids));
  const staffLines = lines.filter((l) => !inRound.has(l.id));

  const renderLine = (l: GuestLine) => (
    <li key={l.id} className="flex flex-col gap-1 py-3">
      <LineText line={l} struck={l.status === "voided"} />
      <span className="flex items-center gap-2">
        <Pill size="sm" tone={pillTone[lineStatusTone(l, order)]}>
          {lineStatusLabel(l, order)}
        </Pill>
        {l.mine ? yours : null}
      </span>
    </li>
  );

  return (
    <>
      <PageHeader title="Our table" subtitle={`Table ${session.table.name}${order ? ` · Order ${order.order_no}` : ""}`} onBack={onBack} backLabel="Back" />

      <main className="flex w-full min-w-0 flex-col gap-3 px-4 pb-44 pt-4">
        {!orderView && loading ? <p className="text-[15px] text-ink-2">Checking with the kitchen…</p> : null}
        {!orderView && error ? <InlineError error={{ message: error.message, remedy: error.remedy ?? "Try again in a moment." }} /> : null}
        {orderView && lines.length === 0 ? (
          <div className="flex flex-col items-center gap-4 px-4 py-20 text-center">
            <span className="flex size-14 items-center justify-center rounded-full bg-surface-2 text-ink">
              <Icon icon={Utensils} size={24} />
            </span>
            <p className="max-w-[32ch] text-[15.5px] leading-relaxed text-ink-2">Nothing has been ordered at this table yet.</p>
          </div>
        ) : null}
        {order?.bill_requested ? (
          <p role="status" className="flex items-start gap-3 rounded-sheet bg-status-bill-tint px-4 py-3.5 text-[15px] leading-snug text-ink">
            <Icon icon={ReceiptText} size={20} className="mt-0.5 text-status-bill" />
            The bill has been requested. Someone will be with you shortly.
          </p>
        ) : null}

        {rounds.map((r) => {
          const rl = lines.filter((l) => r.line_ids.includes(l.id));
          if (!rl.length && r.status !== "rejected") return null;
          const stage = roundStage(r, order);
          return (
            <section key={r.id} aria-label={`Order sent ${clock(r.submitted_at)}`} className="flex flex-col rounded-sheet border border-rule bg-surface">
              <RoundHead
                title={r.guest_name ?? (r.mine ? "Your order" : "Order")}
                at={`Sent ${clock(r.submitted_at)}`}
                pill={stagePill(stage, session.hold_orders)}
                extra={r.mine && r.guest_name ? yours : null}
              />
              {stage === "rejected" && r.reject_reason ? <p className="px-4 pb-2 text-[13.5px] text-status-alert wrap-anywhere">Not accepted: {r.reject_reason}</p> : null}
              {rl.length ? <ul className="flex flex-col divide-y divide-rule-subtle border-t border-rule-subtle px-4">{rl.map(renderLine)}</ul> : null}
            </section>
          );
        })}
        {staffLines.length ? (
          <section aria-label="Added by staff" className="flex flex-col rounded-sheet border border-rule bg-surface">
            <div className="px-4 pt-3.5 pb-2.5">
              <p className="font-display text-[15.5px] font-semibold text-ink">Added by staff</p>
            </div>
            <ul className="flex flex-col divide-y divide-rule-subtle border-t border-rule-subtle px-4">{staffLines.map(renderLine)}</ul>
          </section>
        ) : null}

        {orderView?.totals && lines.length ? <TotalsPanel totals={orderView.totals} /> : null}
        <p className="px-1 pt-1 text-[14px] leading-snug text-ink-2">Pay at the counter or ask your server for the bill.</p>
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
