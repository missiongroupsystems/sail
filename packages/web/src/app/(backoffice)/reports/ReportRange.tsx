"use client";

import { TextField, useLocale } from "@sail/ui";
import { useState } from "react";
import { OutletChoice, useOutletChoice } from "@/components/backoffice/OutletChoice";
import type { Outlet } from "@/lib/api/types";
import type { Scope } from "@/lib/cookies";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Outlet and business-date range for the register's reports (`from`/`to` as YYYY-MM-DD; today by default). */
export function useReportRange(outlets: Outlet[], scope: Scope, initialOutletId: string | null) {
  const { isoDate } = useLocale();
  const outlet = useOutletChoice(outlets, scope, initialOutletId);
  const [from, setFrom] = useState(isoDate());
  const [to, setTo] = useState(isoDate());
  const valid = DATE.test(from) && DATE.test(to) && from <= to;
  return { ...outlet, from, to, setFrom, setTo, valid, query: { outlet_id: outlet.outletId ?? undefined, from, to } };
}

export function ReportRange({ outlets, scope, range }: { outlets: Outlet[]; scope: Scope; range: ReturnType<typeof useReportRange> }) {
  return (
    <div className="mb-6 flex flex-wrap items-end gap-3">
      <OutletChoice outlets={outlets} scope={scope} outletId={range.outletId} onChange={range.setOutletId} />
      <TextField label="From" type="date" numeric value={range.from} onChange={range.setFrom} className="w-[170px]" />
      <TextField label="To" type="date" numeric value={range.to} onChange={range.setTo} className="w-[170px]" errorMessage={range.valid ? undefined : "From must be on or before To"} isInvalid={!range.valid} />
    </div>
  );
}
