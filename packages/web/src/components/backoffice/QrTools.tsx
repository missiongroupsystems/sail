"use client";

import { Button, Dialog, InlineError } from "@sail/ui";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Table } from "@/lib/api/types";
import { greyPill } from "@/components/office/parts";
import { openPdf } from "./register";

/**
 * "Download QR sheet (PDF)": the cards for the codes on the tables now, as often as needed. Rotating every code is a
 * separate action behind a confirmation, because the cards on the tables stop working and that cannot be undone. Admin.
 */
export function QrSheetButton({ outletId, outletName, canRotate }: { outletId: string; outletName: string; canRotate: boolean }) {
  const sheet = useMutation<void, ApiError>({ mutationFn: () => openPdf(`/v1/outlets/${outletId}/qr-sheet.pdf`, `qr-sheet-${outletName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.pdf`, "POST") });
  const [confirming, setConfirming] = useState(false);
  const rotateAll = useMutation<{ rotated: number }, ApiError>({
    mutationFn: () => req(api.POST("/v1/outlets/{id}/qr/rotate", { params: { path: { id: outletId } }, body: {} })).then((r) => r.data),
    onSuccess: () => setConfirming(false),
  });
  return (
    <div className="flex flex-col items-end gap-1 max-sm:items-start">
      <div className="flex flex-wrap justify-end gap-2 max-sm:justify-start">
        <Button size="sm" variant="secondary" className={greyPill} onPress={() => setConfirming(true)} isDisabled={!canRotate}>
          Rotate every code…
        </Button>
        <Button size="sm" onPress={() => sheet.mutate()} isPending={sheet.isPending} isDisabled={!canRotate}>
          Download QR sheet (PDF)
        </Button>
      </div>
      <p className="text-right text-[12.5px] text-ink-3 max-sm:text-left" role="status">
        {!canRotate ? "Admin only." : rotateAll.data ? `${rotateAll.data.rotated} new codes. Download the sheet and replace the cards on the tables.` : "The sheet prints the codes on the tables now."}
      </p>
      <InlineError error={sheet.error} />
      <Dialog
        isOpen={confirming}
        onOpenChange={(open) => !open && setConfirming(false)}
        role="alertdialog"
        title={`Rotate every QR code at ${outletName}?`}
        footer={
          <>
            <Button variant="secondary" className={greyPill} onPress={() => setConfirming(false)}>
              Keep the codes
            </Button>
            <Button variant="destructive" isPending={rotateAll.isPending} onPress={() => rotateAll.mutate()}>
              Rotate every code
            </Button>
          </>
        }
      >
        <p>The cards on the tables stop working at once, and guests scanning them cannot order. Do this when codes have been copied or photographed, then print the new sheet and replace every card.</p>
        <InlineError error={rotateAll.error} />
      </Dialog>
    </div>
  );
}

/** Per-table "Rotate code": old QR codes for the table stop working; the new URL is shown for a one-off print. Admin. */
export function RotateQrButton({ table, canRotate }: { table: Table; canRotate: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const rotate = useMutation<{ url: string }, ApiError>({ mutationFn: () => req(api.POST("/v1/tables/{id}/qr/rotate", { params: { path: { id: table.id } }, body: {} })).then((r) => r.data), onSuccess: () => setConfirming(false) });
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
        {/* The card on the table stops working at once, so the button asks first, as Rotate every code does (live-test E-L20). */}
        <Button onPress={() => setConfirming(true)} isDisabled={!canRotate || table.archived}>
          Rotate code…
        </Button>
        <span className="text-[12.5px] text-ink-3">{canRotate ? `The code on ${table.name} stops working.` : "Admin only"}</span>
      </div>
      {rotate.data ? (
        <div className="flex flex-col gap-1.5 rounded-field bg-surface-2 px-3 py-2.5">
          <p className="text-[12.5px] text-ink-2">New guest link for {table.name}. Print a fresh card, or download the whole sheet.</p>
          <p className="break-all font-mono text-[12.5px] text-ink">{rotate.data.url}</p>
          <div>
            <Button variant="secondary" className="min-h-9 px-3 text-[13px]" onPress={copy}>
              {copied ? "Copied" : "Copy link"}
            </Button>
          </div>
        </div>
      ) : null}
      <Dialog
        isOpen={confirming}
        onOpenChange={(open) => !open && setConfirming(false)}
        role="alertdialog"
        title={`Rotate the QR code on ${table.name}?`}
        footer={
          <>
            <Button variant="secondary" className={greyPill} onPress={() => setConfirming(false)}>
              Keep the code
            </Button>
            <Button variant="destructive" isPending={rotate.isPending} onPress={() => rotate.mutate()}>
              Rotate code
            </Button>
          </>
        }
      >
        <p>The card on {table.name} stops working at once: guests scanning it cannot order until it is replaced with the new one.</p>
        <InlineError error={rotate.error} />
      </Dialog>
    </div>
  );
}
