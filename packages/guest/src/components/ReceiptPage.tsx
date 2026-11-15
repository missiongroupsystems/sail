"use client";

import { BillDocumentView, LocaleProvider } from "@sail/ui";
import { useEffect, useMemo, useState } from "react";
import { ApiError, createGuestApi, readReceipt, toApiError } from "@/lib/api";
import type { ReceiptRead } from "@/lib/types";
import { AlertTriangle, Clock } from "lucide-react";
import { Notice } from "./Notices";

type State = { kind: "loading" } | { kind: "ok"; receipt: ReceiptRead } | { kind: "expired" } | { kind: "error"; error: ApiError };

/**
 * /r/<token>: the bill document for the guest's phone, with the brand's name on it.
 * Amounts, dates and times format from the document's own currency, locale and zone.
 */
export function ReceiptPage({ token }: { token: string }) {
  const api = useMemo(() => createGuestApi({ getToken: () => null }), []);
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    readReceipt(api, token)
      .then((receipt) => {
        if (cancelled) return;
        setState({ kind: "ok", receipt });
        document.title = `Receipt · ${receipt.document.header.brand_name}`;
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const err = toApiError(e);
        setState(err.isNotFound ? { kind: "expired" } : { kind: "error", error: err });
      });
    return () => {
      cancelled = true;
    };
  }, [api, token]);

  if (state.kind === "loading") {
    return (
      <main className="flex w-full flex-col items-center gap-4 px-4 pt-[max(48px,env(safe-area-inset-top))]" aria-busy="true" aria-label="Loading the receipt">
        <div className="size-[72px] animate-skeleton rounded-full bg-surface-3" />
        <div className="h-8 w-48 animate-skeleton rounded-lg bg-surface-3" />
        <div className="h-5 w-64 animate-skeleton rounded-md bg-surface-3" />
        <div className="mt-4 h-40 w-full animate-skeleton rounded-sheet bg-surface-3" />
      </main>
    );
  }
  if (state.kind === "expired") return <Notice icon={Clock} title="This receipt link isn&apos;t valid or has expired." body="Check the link, or ask a member of staff for a printed copy." />;
  if (state.kind === "error") return <Notice icon={AlertTriangle} title={state.error.message} body={state.error.remedy ?? "Try again in a moment."} />;

  return (
    <LocaleProvider settings={{ currency: state.receipt.document.currency, currencyExponent: state.receipt.document.currency_exponent, locale: state.receipt.document.header.locale, timeZone: state.receipt.document.header.time_zone }}>
      <main className="w-full px-4 pt-[max(40px,env(safe-area-inset-top))] pb-10">
        <BillDocumentView document={state.receipt.document} />
        <p className="mt-8 text-center text-[14px] text-ink-2">Thank you for dining with us.</p>
      </main>
    </LocaleProvider>
  );
}
