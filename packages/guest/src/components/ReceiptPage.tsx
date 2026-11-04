"use client";

import { BillDocumentView } from "@sail/ui";
import { useEffect, useMemo, useState } from "react";
import { ApiError, createGuestApi, readReceipt, toApiError } from "@/lib/api";
import type { ReceiptRead } from "@/lib/types";
import { Notice } from "./Notices";

type State = { kind: "loading" } | { kind: "ok"; receipt: ReceiptRead } | { kind: "expired" } | { kind: "error"; error: ApiError };

/** /r/<token>: the bill document for the guest's phone, with the brand's name on it (design 4.5 receipt chooser → QR). */
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
      <main className="mx-auto w-full max-w-[560px] px-4 py-8" aria-busy="true" aria-label="Loading the receipt">
        <div className="h-8 w-48 animate-skeleton rounded-tile bg-surface-2" />
        <div className="mt-3 h-5 w-64 animate-skeleton rounded bg-surface-2" />
      </main>
    );
  }
  if (state.kind === "expired") return <Notice title="This receipt link has expired." body="Ask a member of staff for a printed copy." />;
  if (state.kind === "error") return <Notice title={state.error.message} body={state.error.remedy ?? "Try again in a moment."} />;

  return (
    <main className="mx-auto w-full max-w-[560px] px-4 py-8">
      <BillDocumentView document={state.receipt.document} />
      <p className="mt-8 text-caption text-ink-2">Thank you for dining with us.</p>
    </main>
  );
}
