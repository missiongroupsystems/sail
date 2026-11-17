"use client";

import { Button, Dialog } from "@sail/ui";
import { useState, type ReactNode } from "react";
import { greyPill } from "@/components/office/parts";

export type ConfirmRequest = {
  /** A question: "Archive Kopi?" */
  title: string;
  /** What will happen, in one or two plain sentences: what disappears from the POS and the guest menu. */
  body: ReactNode;
  /** The action, as on the button that asked: "Archive product". */
  confirmLabel: string;
  /** The way back: "Keep the product". */
  cancelLabel?: string;
  onConfirm: () => void;
};

/**
 * Ask once before an archive or a delete, in the confirm dialog style of the back office (Close business day, Archive
 * station): a question, what will happen, the way back, then the destructive action. `ask` opens it; render `dialog`.
 */
export function useConfirm() {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const close = () => setRequest(null);
  const dialog = (
    <Dialog
      isOpen={request !== null}
      onOpenChange={(open) => !open && close()}
      role="alertdialog"
      title={request?.title ?? ""}
      footer={
        <>
          <Button variant="secondary" className={greyPill} onPress={close}>
            {request?.cancelLabel ?? "Cancel"}
          </Button>
          <Button
            variant="destructive"
            onPress={() => {
              request?.onConfirm();
              close();
            }}
          >
            {request?.confirmLabel ?? "Confirm"}
          </Button>
        </>
      }
    >
      {request ? <p>{request.body}</p> : null}
    </Dialog>
  );
  return { ask: setRequest, dialog };
}
