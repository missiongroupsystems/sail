"use client";

import { DateField } from "@sail/ui";
import { useState, type ReactNode } from "react";
import { OutletChoice, useOutletChoice } from "@/components/backoffice/OutletChoice";
import type { Outlet } from "@/lib/api/types";
import type { Scope } from "@/lib/cookies";
import { useUrlState } from "@/lib/url-state";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Outlet and business-date range for the register's reports (`from`/`to` as YYYY-MM-DD). By default the register's
 * business day, which the page reads from the register: not the clock, so the server render and the browser agree.
 * The range and outlet live in the address (`?outlet=…&from=…&to=…`), so a refresh or a shared link keeps them.
 */
export function useReportRange(outlets: Outlet[], scope: Scope, initialOutletId: string | null, today: string | null, initial?: { from: string | null; to: string | null }) {
  const outlet = useOutletChoice(outlets, scope, initialOutletId);
  const [from, setFrom] = useState(initial?.from ?? today ?? "");
  const [to, setTo] = useState(initial?.to ?? today ?? "");
  const valid = DATE.test(from) && DATE.test(to) && from <= to;
  useUrlState({ outlet: outlet.scoped ? null : outlet.outletId, from: DATE.test(from) ? from : null, to: DATE.test(to) ? to : null });
  return { ...outlet, from, to, setFrom, setTo, valid, query: { outlet_id: outlet.outletId ?? undefined, from, to } };
}

/** The range's lines for an export: outlet name and ISO dates. */
export function rangeScope(outlets: Outlet[], range: ReturnType<typeof useReportRange>): [string, string][] {
  return [
    ["Outlet", outlets.find((o) => o.id === range.outletId)?.name ?? ""],
    ["From", range.from],
    ["To", range.to],
  ];
}

/** The report's filters; `children` are its own filters after the dates, `actions` its export at the row's end. */
export function ReportRange({ outlets, scope, range, children, actions }: { outlets: Outlet[]; scope: Scope; range: ReturnType<typeof useReportRange>; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start gap-3 print:hidden">
      <OutletChoice outlets={outlets} scope={scope} outletId={range.outletId} onChange={range.setOutletId} />
      {/* From and To sit inside their fields, so the row lines up with the outlet choice beside it. */}
      <DateField aria-label="From" prefix="From" value={range.from} onChange={range.setFrom} className="w-[240px]" />
      <DateField aria-label="To" prefix="To" value={range.to} onChange={range.setTo} className="w-[240px]" errorMessage="From must be on or before To" isInvalid={!range.valid} />
      {children}
      {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
