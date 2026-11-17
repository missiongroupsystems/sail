"use client";

import { Button, Icon, Menu, MenuItem, MenuTrigger, reportRows, toCsv, type CsvRow } from "@sail/ui";
import { ChevronDown } from "lucide-react";
import type { RefObject } from "react";
import { useSession } from "@/lib/session-context";

/** The currency's minor-unit exponent: the merchant's own setting, else the currency's standard one. */
function exponentOf(currency: string, exponent: number | null | undefined): number {
  if (typeof exponent === "number" && Number.isInteger(exponent)) return exponent;
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

export type ReportExportProps = {
  /** The report's name, the first line of the file: "Sales", "Z-report". */
  title: string;
  /** What the figures cover, as label/value lines under the title: outlet, dates, station. ISO dates. */
  scope: [string, string][];
  /** The file's name without `.csv`. */
  fileName: string;
  /** The report's figures as the page shows them. */
  target: RefObject<HTMLElement | null>;
  /** Nothing to export yet (still loading, or no figures). */
  isDisabled?: boolean;
};

/**
 * One quiet control in a report's action row: download the report as CSV, or print it. The CSV is read from the
 * figures on the page, so it has the same rows and totals as the screen; the print view is the page without the app's
 * rail and controls (`print:hidden`).
 */
export function ReportExport({ title, scope, fileName, target, isDisabled }: ReportExportProps) {
  const { currency, currency_exponent } = useSession().merchant.settings;

  const download = () => {
    if (!target.current) return;
    const exponent = exponentOf(currency, currency_exponent);
    const head: CsvRow[] = [[title], ...scope, ["Currency", currency]];
    const csv = toCsv([...head, [], ...reportRows(target.current, exponent)]);
    // A byte-order mark, so a spreadsheet opens accented names and the euro sign as UTF-8.
    const url = URL.createObjectURL(new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fileName}.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  return (
    <MenuTrigger>
      <Button size="sm" variant="quiet" isDisabled={isDisabled} className="print:hidden">
        Export
        <Icon icon={ChevronDown} size={14} className="text-ink-3" />
      </Button>
      <Menu minWidth={180} onAction={(key) => (key === "csv" ? download() : key === "print" ? window.print() : undefined)}>
        <MenuItem id="csv">Download CSV</MenuItem>
        <MenuItem id="print">Print</MenuItem>
      </Menu>
    </MenuTrigger>
  );
}

/** A file-name-safe piece: "Main Street" → "main-street". */
export function fileSlug(s: string): string {
  return s.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").toLowerCase() || "report";
}
