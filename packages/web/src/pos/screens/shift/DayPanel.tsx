"use client";

import { Button, cx, Money, Sheet, useLocale } from "@sail/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toApiError } from "@/lib/api";
import { closeBusinessDay } from "../../api/register";
import { usePos } from "../../components/PosContext";
import { useOpenOrders } from "../../hooks/queries";
import { useApi } from "../../hooks/useApi";
import { roleAtLeast } from "../../hooks/useOrderActions";
import { ORDER_TYPE_LABEL } from "../../lib/format";
import { useUiStore } from "../../state/ui";

/**
 * "The day": closing the business day, for a Manager, once every shift is closed. The register snapshots the
 * Z-report; open orders are listed in the confirmation first. On the Shift page it sits beside the station's shift.
 */
export function DayPanel({ className, layout = "panel" }: { className?: string; layout?: "panel" | "row" }) {
  const { clock, businessDay } = useLocale();
  const api = useApi();
  const qc = useQueryClient();
  const { station, staff, offline, tablesById, floor } = usePos();
  const notify = useUiStore((s) => s.notify);
  const [busy, setBusy] = useState(false);
  const [closedAt, setClosedAt] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const openOrders = useOpenOrders(station.outlet_id);
  // Today's business day only, as the back office lists them.
  const stillOpen = (openOrders.data ?? []).filter((o) => o.business_date === floor?.business_date);
  const canCloseDay = roleAtLeast(staff.role, "manager");

  const closeDay = async () => {
    setBusy(true);
    try {
      const res = await closeBusinessDay(api, station.outlet_id);
      setClosedAt(res.closed_at);
      setConfirming(false);
      notify({ text: `Business day ${businessDay(res.business_date)} closed`, tone: "success" }, 5000);
      void qc.invalidateQueries({ queryKey: ["pos", "z-report", station.outlet_id] });
    } catch (e) {
      const err = toApiError(e);
      notify({ text: err.message, remedy: err.remedy ?? null, tone: "alert" }, 8000);
    } finally {
      setBusy(false);
    }
  };

  const line = closedAt ? `Business day closed at ${clock(closedAt)}.` : canCloseDay ? "Close the business day once every shift is closed. The register snapshots the Z-report." : "Closing the business day needs a Manager.";
  const button = (
    <Button size="lg" variant="primary" isDisabled={offline || busy || !canCloseDay || Boolean(closedAt)} isPending={busy} onPress={() => setConfirming(true)} className={layout === "panel" ? "w-full" : undefined}>
      {offline ? "Offline" : closedAt ? "Business day closed" : "Close the business day…"}
    </Button>
  );

  return (
    <>
      {layout === "row" ? (
        <section className={cx("flex flex-wrap items-center justify-between gap-3 rounded-panel border border-rule bg-surface px-5 py-4", className)} aria-label="The day">
          <p className="min-w-0 flex-1 text-body text-ink-2">{line}</p>
          {button}
        </section>
      ) : (
        <section className={cx("flex flex-col overflow-hidden rounded-panel border border-rule bg-surface", className)} aria-label="The day">
          <h2 className="border-b border-rule px-5 py-3.5 font-heading text-[16px] font-semibold text-ink">The day</h2>
          <div className="flex flex-col gap-4 px-5 py-4">
            <dl className="flex flex-col gap-2 text-body">
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-ink-2">Business day</dt>
                <dd className="text-ink">{floor?.business_date ? businessDay(floor.business_date) : "—"}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-ink-2">Orders open today</dt>
                <dd className="text-ink tabular">{openOrders.data ? stillOpen.length : "—"}</dd>
              </div>
            </dl>
            <p className="text-body text-ink-2">{line}</p>
            {button}
          </div>
        </section>
      )}

      <Sheet labelledClose
        isOpen={confirming}
        onOpenChange={(o) => (!o ? setConfirming(false) : undefined)}
        title="Close the business day?"
        description="The register snapshots the Z-report as it stands now. Every shift must be closed first."
        isDismissable={!busy}
        footer={
          <>
            <Button size="lg" variant="quiet" isDisabled={busy} onPress={() => setConfirming(false)} className="mr-auto">
              Keep the day open
            </Button>
            <Button size="lg" variant="primary" isDisabled={offline || busy || openOrders.isPending} isPending={busy} onPress={closeDay}>
              Close business day
            </Button>
          </>
        }
      >
        {stillOpen.length > 0 ? (
          <div className="flex flex-col gap-2">
            <p className="text-line text-ink">{stillOpen.length === 1 ? "1 order is still open:" : `${stillOpen.length} orders are still open:`}</p>
            <ul className="flex flex-col">
              {stillOpen.slice(0, 8).map((o) => (
                <li key={o.id} className="flex min-h-11 items-center justify-between gap-3 hairline-b text-body text-ink">
                  <span>
                    {o.order_no}
                    {o.table_id ? ` · Table ${tablesById.get(o.table_id)?.name ?? ""}` : ` · ${ORDER_TYPE_LABEL[o.order_type]}`}
                  </span>
                  <Money cents={o.totals.total} size="body" />
                </li>
              ))}
            </ul>
            {stillOpen.length > 8 ? <p className="text-body text-ink-2">and {stillOpen.length - 8} more, in Orders.</p> : null}
            <p className="text-body text-ink-2">Pay or cancel {stillOpen.length === 1 ? "it" : "them"} first, unless {stillOpen.length === 1 ? "it carries" : "they carry"} over to the next day.</p>
          </div>
        ) : (
          <p className="text-body text-ink-2">{openOrders.isPending ? "Checking for open orders…" : "No orders are open."}</p>
        )}
      </Sheet>
    </>
  );
}
