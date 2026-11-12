"use client";

import { BrandButton, InlineError, cx, useLocale } from "@sail/ui";
import { ArrowLeft } from "lucide-react";
import type { ApiError } from "@/lib/api";
import { lineStatusLabel, lineStatusTone, roundStage } from "@/lib/status";
import type { GuestLine, GuestSession, OrderView } from "@/lib/types";
import { LineText } from "./StatusView";

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

const toneClass = { sent: "text-status-sent", paid: "text-status-paid", seated: "text-status-seated", "ink-2": "text-ink-2" } as const;

/** "Our table" (design 4.11): everything the table has ordered, with statuses, this guest's items marked. */
export function OurTableView({ session, orderView, loading, error, onBack, onCallStaff, onOrderMore }: OurTableViewProps) {
  const { clock } = useLocale();
  const order = orderView?.order ?? null;
  const rounds = [...(orderView?.rounds ?? [])].sort((a, b) => a.submitted_at.localeCompare(b.submitted_at));
  const lines = orderView?.lines ?? [];
  const inRound = new Set(rounds.flatMap((r) => r.line_ids));
  const staffLines = lines.filter((l) => !inRound.has(l.id));

  const renderLine = (l: GuestLine) => (
    <li key={l.id} className="flex flex-col gap-1 py-3 hairline-b">
      <LineText line={l} />
      <span className="flex items-center gap-2 text-caption">
        <span className={cx(toneClass[lineStatusTone(l, order)])}>{lineStatusLabel(l, order)}</span>
        {l.mine ? <span className="rounded-chip bg-brand-accent px-2 py-0.5 text-on-brand-accent">Yours</span> : null}
      </span>
    </li>
  );

  return (
    <>
      <header className="sticky top-0 z-20 bg-bg/95 backdrop-blur-sm hairline-b">
        <div className="mx-auto flex w-full max-w-[560px] items-center gap-2 px-2 pb-2 pt-[max(8px,env(safe-area-inset-top))]">
          <BrandButton variant="quiet" onPress={onBack} aria-label="Back" className="px-3">
            <ArrowLeft size={22} aria-hidden />
            <span>Back</span>
          </BrandButton>
          <div className="min-w-0 flex-1 text-right">
            <h1 tabIndex={-1} className="truncate font-display text-heading text-ink outline-none">
              Our table
            </h1>
            <p className="text-caption text-ink-2">
              Table {session.table.name}
              {order ? ` · Order ${order.order_no}` : ""}
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[560px] flex-col gap-6 px-4 pb-44 pt-4">
        {!orderView && loading ? <p className="text-body text-ink-2">Checking with the kitchen…</p> : null}
        {!orderView && error ? <InlineError error={{ message: error.message, remedy: error.remedy ?? "Try again in a moment." }} /> : null}
        {orderView && lines.length === 0 ? <p className="py-8 text-body text-ink-2">Nothing has been ordered at this table yet.</p> : null}
        {order?.bill_requested ? (
          <p role="status" className="rounded-tile bg-surface-2 px-4 py-3 text-body text-ink">
            The bill has been requested. Someone will be with you shortly.
          </p>
        ) : null}

        {rounds.map((r) => {
          const rl = lines.filter((l) => r.line_ids.includes(l.id));
          if (!rl.length && r.status !== "rejected") return null;
          const stage = roundStage(r, order);
          return (
            <section key={r.id} aria-label={`Order sent ${clock(r.submitted_at)}`} className="flex flex-col">
              <h2 className="flex items-baseline justify-between gap-3 pb-1 text-caption text-ink-2">
                <span className="tabular">
                  Sent {clock(r.submitted_at)}
                  {r.guest_name ? ` · ${r.guest_name}` : ""}
                  {r.mine ? " · Yours" : ""}
                </span>
                {stage === "rejected" ? <span className="text-status-alert">Not accepted{r.reject_reason ? `: ${r.reject_reason}` : ""}</span> : null}
              </h2>
              <ul className="hairline-t">{rl.map(renderLine)}</ul>
            </section>
          );
        })}
        {staffLines.length ? (
          <section aria-label="Added by staff" className="flex flex-col">
            <h2 className="pb-1 text-caption text-ink-2">Added by staff</h2>
            <ul className="hairline-t">{staffLines.map(renderLine)}</ul>
          </section>
        ) : null}

        <p className="text-body text-ink">Pay at the counter or ask your server for the bill.</p>
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
