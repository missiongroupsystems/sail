"use client";

import { Button, Money, SegmentedControl, Skeleton, useLocale } from "@sail/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toApiError } from "@/lib/api";
import { closeBusinessDay } from "../../api/register";
import { usePos } from "../../components/PosContext";
import { useZReport } from "../../hooks/queries";
import { useApi } from "../../hooks/useApi";
import { roleAtLeast } from "../../hooks/useOrderActions";
import { ORDER_TYPE_LABEL } from "../../lib/format";
import type { OrderType } from "../../api/types";
import { useUiStore } from "../../state/ui";
import { Row } from "./ShiftHome";

/** The Z-report (design 4.9): sales, tenders with the card total at 34pt, expected vs counted, voids, refunds and covers, every figure from the register. */
export function ZReportView() {
  const { money, clock } = useLocale();
  const api = useApi();
  const qc = useQueryClient();
  const { station, staff, offline } = usePos();
  const notify = useUiStore((s) => s.notify);
  const [scope, setScope] = useState<"station" | "outlet">("station");
  const report = useZReport(station.outlet_id, scope === "station" ? station.id : null, null);
  const [busy, setBusy] = useState(false);
  const [closedAt, setClosedAt] = useState<string | null>(null);
  const r = report.data;
  const canCloseDay = roleAtLeast(staff.role, "manager");

  const closeDay = async () => {
    setBusy(true);
    try {
      const res = await closeBusinessDay(api, station.outlet_id);
      setClosedAt(res.closed_at);
      notify({ text: `Business day ${res.business_date} closed`, tone: "success" }, 5000);
      void qc.invalidateQueries({ queryKey: ["pos", "z-report", station.outlet_id] });
    } catch (e) {
      const err = toApiError(e);
      notify({ text: err.message, remedy: err.remedy ?? null, tone: "alert" }, 8000);
    } finally {
      setBusy(false);
    }
  };

  // Terminal tenders are shown one by one at 34pt; the register does not return a combined figure and the iPad never adds one up.
  const nonCash = r ? r.tenders.filter((t) => !t.is_cash) : [];

  return (
    <div className="mx-auto flex w-full max-w-[880px] flex-col gap-6 px-8 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-title text-ink">Z-report</h1>
          <p className="text-body text-ink-2">{r ? `${r.scope.business_date} · ${scope === "station" ? station.name : "whole outlet"} · as of ${clock(r.generated_at)}` : "Today, from the register"}</p>
        </div>
        <SegmentedControl aria-label="Report scope" options={[{ id: "station", label: "This station" }, { id: "outlet", label: "Whole outlet" }]} selectedId={scope} onSelect={(id) => setScope(id as "station" | "outlet")} />
      </div>

      {!r ? (
        <Skeleton lines={6} />
      ) : (
        <div className="grid grid-cols-2 gap-4">
          <section className="rounded-tile bg-surface px-5 py-3 hairline">
            <h2 className="text-caption text-ink-2 uppercase tracking-[0.04em]">Sales</h2>
            <dl>
              <Row label="Gross" cents={r.sales.gross} />
              <Row label="Discounts" cents={-r.sales.discounts} />
              <Row label="Service and fees" cents={r.sales.fees} />
              <Row label="GST" cents={r.sales.gst} />
              <Row label="Net sales" cents={r.sales.net} strong />
            </dl>
            {r.adjustments.length ? (
              <dl className="mt-2 pt-2 hairline-t">
                {r.adjustments.map((a) => (
                  <Row key={a.rule_key} label={`${a.name} · ${a.count}`} cents={a.kind === "discount" ? -Math.abs(a.total) : a.total} />
                ))}
              </dl>
            ) : null}
          </section>

          <section className="rounded-tile bg-surface px-5 py-3 hairline">
            <h2 className="text-caption text-ink-2 uppercase tracking-[0.04em]">Tenders</h2>
            {nonCash.length ? (
              <div className="flex flex-col gap-1 py-2">
                {nonCash.map((t) => (
                  <div key={t.tender_type_id} className="flex items-baseline gap-3">
                    <Money cents={t.amount} size="amount-xl" className="text-ink" />
                    <span className="text-body text-ink-2">{t.tender}</span>
                  </div>
                ))}
                <p className="text-body text-ink-2">Compare each with the terminal's end-of-day total</p>
              </div>
            ) : null}
            <dl>
              {r.tenders.map((t) => (
                <Row key={t.tender_type_id} label={`${t.tender} · ${t.count}${t.tips ? ` · tips ${money(t.tips)}` : ""}`} cents={t.amount} />
              ))}
              {r.tenders.length === 0 ? <p className="py-2 text-body text-ink-2">No payments yet.</p> : null}
            </dl>
          </section>

          <section className="rounded-tile bg-surface px-5 py-3 hairline">
            <h2 className="text-caption text-ink-2 uppercase tracking-[0.04em]">Cash</h2>
            <dl>
              <Row label="Float" cents={r.cash.float} />
              <Row label="Cash payments" cents={r.cash.cash_payments} />
              <Row label="Cash rounding" cents={r.cash.rounding} />
              <Row label="Cash refunds" cents={-r.cash.refunds} />
              <Row label="Expected" cents={r.cash.expected} strong />
              {r.cash.counted != null ? <Row label="Counted" cents={r.cash.counted} strong /> : null}
              {r.cash.variance != null ? <Row label="Variance" cents={r.cash.variance} strong tone={r.cash.variance === 0 ? "paid" : "alert"} /> : <p className="pt-2 text-caption text-ink-2">Counted and variance appear once the shift is closed.</p>}
            </dl>
          </section>

          <section className="rounded-tile bg-surface px-5 py-3 hairline">
            <h2 className="text-caption text-ink-2 uppercase tracking-[0.04em]">Orders, voids and refunds</h2>
            <dl>
              <div className="flex min-h-8 items-center justify-between gap-3">
                <dt className="text-body text-ink-2">Orders</dt>
                <dd className="text-body text-ink tabular">
                  {r.orders.count} · {r.orders.covers} covers{r.orders.open_count ? ` · ${r.orders.open_count} open` : ""}
                </dd>
              </div>
              {Object.entries(r.orders.by_type).map(([type, n]) => (
                <div key={type} className="flex min-h-7 items-center justify-between gap-3">
                  <dt className="pl-3 text-caption text-ink-2">{ORDER_TYPE_LABEL[type as OrderType] ?? type}</dt>
                  <dd className="text-caption text-ink-2 tabular">{n}</dd>
                </div>
              ))}
              <Row label={`Voids · ${r.voids.count} (${r.voids.quantity} items)`} cents={r.voids.value} />
              <Row label={`Refunds · ${r.refunds.count}`} cents={-r.refunds.amount} />
            </dl>
          </section>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
        <p className="text-body text-ink-2">{closedAt ? `Business day closed at ${clock(closedAt)}.` : canCloseDay ? "Close the business day once every shift is closed. The register snapshots this report." : "Closing the business day needs a Manager."}</p>
        <Button size="lg" variant="primary" isDisabled={offline || busy || !canCloseDay || Boolean(closedAt)} isPending={busy} onPress={closeDay}>
          {offline ? "Offline" : "Close business day"}
        </Button>
      </div>
    </div>
  );
}
