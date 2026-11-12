"use client";

import { Button, InlineError } from "@sail/ui";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Table } from "@/lib/api/types";
import { openPdf } from "./register";

/** "Download QR sheet (PDF)": the register rotates every table token at the outlet and returns the cards. Admin. */
export function QrSheetButton({ outletId, outletName, canRotate }: { outletId: string; outletName: string; canRotate: boolean }) {
  const sheet = useMutation<void, ApiError>({ mutationFn: () => openPdf(`/v1/outlets/${outletId}/qr-sheet.pdf`, `qr-sheet-${outletName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.pdf`, "POST") });
  return (
    <div className="flex flex-col items-end gap-1">
      <Button onPress={() => sheet.mutate()} isPending={sheet.isPending} isDisabled={!canRotate}>
        Download QR sheet (PDF)
      </Button>
      <p className="max-w-[320px] text-right text-caption text-ink-2">{canRotate ? "Rotates every code at this outlet: sheets already on the tables stop working the moment this downloads." : "Admin only. Rotates every code at the outlet."}</p>
      <InlineError error={sheet.error} />
    </div>
  );
}

/** Per-table "Rotate code": old QR codes for the table stop working; the new URL is shown for a one-off print. Admin. */
export function RotateQrButton({ table, canRotate }: { table: Table; canRotate: boolean }) {
  const rotate = useMutation<{ url: string }, ApiError>({ mutationFn: () => req(api.POST("/v1/tables/{id}/qr/rotate", { params: { path: { id: table.id } }, body: {} })).then((r) => r.data) });
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!rotate.data) return;
    try {
      await navigator.clipboard.writeText(rotate.data.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button onPress={() => rotate.mutate()} isPending={rotate.isPending} isDisabled={!canRotate || table.archived}>
          Rotate code
        </Button>
        <span className="text-caption text-ink-2">{canRotate ? `The code on ${table.name} stops working.` : "Admin only"}</span>
      </div>
      {rotate.data ? (
        <div className="flex flex-col gap-1 rounded-tile bg-surface-2 px-3 py-2">
          <p className="text-caption text-ink-2">New guest link for {table.name}. Print a fresh card, or download the whole sheet.</p>
          <p className="break-all font-mono text-caption text-ink">{rotate.data.url}</p>
          <div>
            <Button variant="quiet" className="min-h-9 px-2.5 text-caption" onPress={copy}>
              {copied ? "Copied" : "Copy link"}
            </Button>
          </div>
        </div>
      ) : null}
      <InlineError error={rotate.error} />
    </div>
  );
}
