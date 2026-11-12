"use client";

import { Button, Dialog, EmptyState, InlineError, Select, Skeleton, TextField, useLocale } from "@sail/ui";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { OutletChoice, useOutletChoice } from "@/components/backoffice/OutletChoice";
import { boKeys, can, rolesFor, type BusinessDayClose, type ZReport } from "@/components/backoffice/register";
import { ZReportBody } from "@/components/backoffice/ZReportBody";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Outlet } from "@/lib/api/types";
import type { Scope } from "@/lib/cookies";
import { useSession } from "@/lib/session-context";

const ALL = "__all__";

export function ZReportView({ outlets, scope, initialOutletId }: { outlets: Outlet[]; scope: Scope; initialOutletId: string | null }) {
  const { dayClock, isoDate, money } = useLocale();
  const { me } = useSession();
  const qc = useQueryClient();
  const canClose = can(me, "business_days.close");
  const { outletId, setOutletId } = useOutletChoice(outlets, scope, initialOutletId);
  const [date, setDate] = useState(isoDate());
  const [stationId, setStationId] = useState<string | null>(null);
  const [closed, setClosed] = useState<BusinessDayClose | null>(null);
  const [confirming, setConfirming] = useState(false);

  const stations = useQuery({
    queryKey: ["stations", outletId ?? ""],
    queryFn: () => req(api.GET("/v1/outlets/{id}/stations", { params: { path: { id: outletId! } } })).then((r) => r.data),
    enabled: outletId !== null,
    staleTime: 60_000,
  });
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date);
  const report = useQuery<ZReport, ApiError>({
    queryKey: boKeys.zReport(outletId ?? "", date, stationId),
    queryFn: () => req(api.GET("/v1/outlets/{id}/z-report", { params: { path: { id: outletId! }, query: { business_date: date, station_id: stationId ?? undefined } } })).then((r) => r.data as unknown as ZReport),
    enabled: outletId !== null && validDate,
    placeholderData: keepPreviousData,
    refetchInterval: date === isoDate() ? 30_000 : false,
  });
  const close = useMutation<{ data: BusinessDayClose; warnings: string[] }, ApiError>({
    mutationFn: () => req(api.POST("/v1/outlets/{id}/business-days/close", { params: { path: { id: outletId! } }, body: { business_date: date } })).then((r) => r as unknown as { data: BusinessDayClose; warnings: string[] }),
    onSuccess: async (r) => {
      setClosed(r.data);
      setConfirming(false);
      await qc.invalidateQueries({ queryKey: ["z-report"] });
    },
  });
  // What is still open on that business day, listed before the day is closed.
  const stillOpen = useQuery({
    queryKey: ["z-report", "open-orders", outletId ?? "", date],
    queryFn: () => req(api.GET("/v1/outlets/{id}/orders", { params: { path: { id: outletId! }, query: { business_date: date, open_only: "true", limit: 50 } } })).then((r) => r.data as unknown as { id: string; order_no: string; totals: { total: number } }[]),
    enabled: confirming && outletId !== null && validDate,
  });
  const closedToday = closed?.business_date === date;
  const stationName = (id: string | null) => (id ? (stations.data ?? []).find((s) => s.id === id)?.name ?? "Station" : "All stations");

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <OutletChoice outlets={outlets} scope={scope} outletId={outletId} onChange={setOutletId} />
          <TextField aria-label="Business date" type="date" numeric value={date} onChange={setDate} className="w-[170px]" />
          <Select aria-label="Station" variant="toolbar" selectedKey={stationId ?? ALL} onSelectionChange={(k) => setStationId(k === ALL ? null : k)} items={[{ id: ALL, label: "All stations" }, ...(stations.data ?? []).filter((s) => !s.archived || s.id === stationId).map((s) => ({ id: s.id, label: s.name }))]} />
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button variant="primary" onPress={() => setConfirming(true)} isDisabled={!canClose || !outletId || !validDate || stationId !== null || closedToday}>
            {closedToday ? `Business day ${date} closed` : `Close business day ${date}…`}
          </Button>
          <p className="text-caption text-ink-2">{!canClose ? rolesFor("business_days.close") : stationId ? "Choose All stations to close the day" : "Snapshots this Z-report once every shift is closed"}</p>
        </div>
      </div>

      {closed ? (
        <div className="mb-6 flex flex-col gap-1 rounded-tile bg-surface-2 px-4 py-3" role="status">
          <p className="text-body text-ink">
            Business day {closed.business_date} closed at {dayClock(closed.closed_at)}. The Z-report below is its snapshot.
          </p>
        </div>
      ) : null}
      <InlineError error={close.error} className="mb-6" />
      <Dialog
        isOpen={confirming}
        onOpenChange={(open) => !open && setConfirming(false)}
        role="alertdialog"
        title={`Close business day ${date}?`}
        footer={
          <>
            <Button variant="quiet" onPress={() => setConfirming(false)}>
              Keep the day open
            </Button>
            <Button variant="primary" isPending={close.isPending} isDisabled={stillOpen.isPending} onPress={() => close.mutate()}>
              Close business day
            </Button>
          </>
        }
      >
        <p>The register snapshots the Z-report as it stands now. Every shift must be closed first.</p>
        {stillOpen.isPending ? <p className="pt-2">Checking for open orders…</p> : null}
        {stillOpen.data && stillOpen.data.length > 0 ? (
          <div className="pt-3">
            <p className="text-ink">{stillOpen.data.length === 1 ? "1 order is still open:" : `${stillOpen.data.length} orders are still open:`}</p>
            <ul className="pt-1">
              {stillOpen.data.map((o) => (
                <li key={o.id} className="flex justify-between gap-3 tabular">
                  <span>{o.order_no}</span>
                  <span>{money(o.totals.total)}</span>
                </li>
              ))}
            </ul>
            <p className="pt-2">Pay or cancel {stillOpen.data.length === 1 ? "it" : "them"} first, unless {stillOpen.data.length === 1 ? "it carries" : "they carry"} over to the next day.</p>
          </div>
        ) : stillOpen.data ? (
          <p className="pt-2">No orders are open.</p>
        ) : null}
        <InlineError error={close.error} />
      </Dialog>

      {outlets.length === 0 ? <EmptyState title="No outlets yet" hint="A Z-report belongs to an outlet." /> : null}
      {report.isPending && outletId ? <Skeleton lines={6} /> : null}
      <InlineError error={report.error} />
      {report.data ? (
        <div className={report.isPlaceholderData ? "opacity-60" : undefined}>
          <ZReportBody report={report.data} stationName={stationName} />
        </div>
      ) : null}
    </>
  );
}
