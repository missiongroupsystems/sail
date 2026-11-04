"use client";

import { Button, EmptyState, InlineError, Select, Skeleton, TextField } from "@sail/ui";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { todayBusinessDate } from "@/components/backoffice/labels";
import { OutletChoice, useOutletChoice } from "@/components/backoffice/OutletChoice";
import { boKeys, can, rolesFor, type BusinessDayClose, type ZReport } from "@/components/backoffice/register";
import { ZReportBody } from "@/components/backoffice/ZReportBody";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Outlet } from "@/lib/api/types";
import type { Scope } from "@/lib/cookies";
import { formatDayClock } from "@/lib/format";
import { useSession } from "@/lib/session-context";

const ALL = "__all__";

export function ZReportView({ outlets, scope, initialOutletId }: { outlets: Outlet[]; scope: Scope; initialOutletId: string | null }) {
  const { me } = useSession();
  const qc = useQueryClient();
  const canClose = can(me, "business_days.close");
  const { outletId, setOutletId } = useOutletChoice(outlets, scope, initialOutletId);
  const [date, setDate] = useState(todayBusinessDate());
  const [stationId, setStationId] = useState<string | null>(null);
  const [closed, setClosed] = useState<BusinessDayClose | null>(null);

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
    refetchInterval: date === todayBusinessDate() ? 30_000 : false,
  });
  const close = useMutation<{ data: BusinessDayClose; warnings: string[] }, ApiError>({
    mutationFn: () => req(api.POST("/v1/outlets/{id}/business-days/close", { params: { path: { id: outletId! } }, body: { business_date: date } })).then((r) => r as unknown as { data: BusinessDayClose; warnings: string[] }),
    onSuccess: async (r) => {
      setClosed(r.data);
      await qc.invalidateQueries({ queryKey: ["z-report"] });
    },
  });
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
          <Button variant="primary" onPress={() => close.mutate()} isPending={close.isPending} isDisabled={!canClose || !outletId || !validDate || stationId !== null}>
            Close business day {date}
          </Button>
          <p className="text-caption text-ink-2">{!canClose ? rolesFor("business_days.close") : stationId ? "Choose All stations to close the day" : "Snapshots this Z-report once every shift is closed"}</p>
        </div>
      </div>

      {closed ? (
        <div className="mb-6 flex flex-col gap-1 rounded-tile bg-surface-2 px-4 py-3" role="status">
          <p className="text-body text-ink">
            Business day {closed.business_date} closed at {formatDayClock(closed.closed_at)}. The Z-report below is its snapshot.
          </p>
        </div>
      ) : null}
      <InlineError error={close.error} className="mb-6" />

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
