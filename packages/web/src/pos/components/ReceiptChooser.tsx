"use client";

import { Button, TextField } from "@sail/ui";
import { useEffect, useRef, useState } from "react";
import type { CheckSnapshot, Invoice, OrderSnapshot, ReceiptSend } from "../api/types";
import type { OrderActions } from "../hooks/useOrderActions";
import { usePos } from "./PosContext";
import { QrCodeImage } from "./QrCodeImage";

export type ReceiptChooserProps = {
  order: OrderSnapshot;
  check: CheckSnapshot;
  actions: OrderActions;
  /** "Paid · Bill 2 · $43.16". */
  heading: string;
  /** "Change $6.85", from the register. */
  sub?: string | null;
  /** Leave the screen with no choice after this long (design 4.5: 4 s). 0 turns it off. */
  autoReturnMs?: number;
  onDone: () => void;
  doneLabel: string;
};

type Choice = "print" | "qr" | "send" | "none" | null;

/**
 * The payment done screen (design 4.5): the result in one line, then Print,
 * QR on screen, Email/SMS and No receipt as large buttons, Get invoice, and an
 * auto-return that any tap cancels.
 */
export function ReceiptChooser({ order, check, actions, heading, sub, autoReturnMs = 4000, onDone, doneLabel }: ReceiptChooserProps) {
  const { offline } = usePos();
  const [choice, setChoice] = useState<Choice>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<ReceiptSend | null>(null);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [channel, setChannel] = useState<"email" | "sms">("email");
  const [destination, setDestination] = useState("");
  const [printed, setPrinted] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [counting, setCounting] = useState(autoReturnMs > 0);

  useEffect(() => {
    if (!counting || autoReturnMs <= 0) return;
    timer.current = setTimeout(onDone, autoReturnMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [counting, autoReturnMs, onDone]);

  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    setCounting(false);
  };

  const print = async () => {
    stop();
    setChoice("print");
    setBusy(true);
    const jobs = await actions.printReceipt(check.id);
    setBusy(false);
    if (jobs) setPrinted(true);
  };
  const qr = async () => {
    stop();
    setChoice("qr");
    setBusy(true);
    const res = await actions.sendReceipt(check.id, "qr");
    setBusy(false);
    if (res) setSent(res);
  };
  const send = async () => {
    setBusy(true);
    const res = await actions.sendReceipt(check.id, channel, destination.trim());
    setBusy(false);
    if (res) setSent(res);
  };
  const getInvoice = async () => {
    stop();
    setBusy(true);
    const inv = await actions.issueInvoice(check.id);
    setBusy(false);
    if (inv) setInvoice(inv);
  };

  const big = "min-h-24 flex-1 min-w-[180px] text-heading";

  return (
    <div className="flex h-full flex-col items-center justify-center gap-8 px-8 py-6" onPointerDownCapture={stop}>
      <div className="flex flex-col items-center gap-1">
        <p className="text-display text-ink tabular">{heading}</p>
        {sub ? <p className="text-amount-xl text-ink-2 tabular">{sub}</p> : null}
        {order.status === "completed" ? <p className="text-body text-ink-2">Every bill is paid. The order is done.</p> : <p className="text-body text-ink-2">{order.checks.filter((c) => c.status === "open").length} more {order.checks.filter((c) => c.status === "open").length === 1 ? "bill" : "bills"} to pay on this order.</p>}
      </div>

      {choice === null || choice === "print" || choice === "none" ? (
        <div className="flex w-full max-w-[880px] flex-wrap gap-3" role="group" aria-label="Receipt">
          <Button size="lg" variant={printed ? "primary" : "secondary"} isDisabled={offline || busy} isPending={busy && choice === "print"} onPress={print} className={big}>
            {printed ? "Printed ✓ · Print again" : "Print"}
          </Button>
          <Button size="lg" variant="secondary" isDisabled={offline || busy} onPress={qr} className={big}>
            QR on screen
          </Button>
          <Button
            size="lg"
            variant="secondary"
            isDisabled={offline || busy}
            onPress={() => {
              stop();
              setChoice("send");
            }}
            className={big}
          >
            Email / SMS
          </Button>
          <Button
            size="lg"
            variant="secondary"
            onPress={() => {
              stop();
              setChoice("none");
              onDone();
            }}
            className={big}
          >
            No receipt
          </Button>
        </div>
      ) : null}

      {choice === "qr" ? (
        <div className="flex flex-col items-center gap-3">
          {sent ? <QrCodeImage url={sent.url} size={260} label="Receipt link as a QR code" /> : <div className="size-[260px] animate-skeleton rounded-tile bg-surface-2" />}
          <p className="text-body text-ink-2">The guest scans this to open their receipt.</p>
          <Button size="lg" variant="quiet" onPress={() => setChoice(null)}>
            Other receipt options
          </Button>
        </div>
      ) : null}

      {choice === "send" ? (
        <div className="flex w-full max-w-[520px] flex-col gap-3">
          {sent ? (
            <p className="rounded-tile bg-surface-2 px-4 py-3 text-line text-ink">
              {sent.delivery_status === "sent" ? `Receipt sent by ${channel === "email" ? "email" : "SMS"}` : `Receipt link ready · ${sent.delivery_status.replace(/_/g, " ")}`}
            </p>
          ) : (
            <>
              <div className="flex gap-2" role="group" aria-label="Channel">
                <Button size="lg" variant={channel === "email" ? "primary" : "secondary"} onPress={() => setChannel("email")} aria-pressed={channel === "email"} className="flex-1">
                  Email
                </Button>
                <Button size="lg" variant={channel === "sms" ? "primary" : "secondary"} onPress={() => setChannel("sms")} aria-pressed={channel === "sms"} className="flex-1">
                  SMS
                </Button>
              </div>
              <TextField aria-label={channel === "email" ? "Email address" : "Mobile number"} value={destination} onChange={setDestination} type={channel === "email" ? "email" : "tel"} placeholder={channel === "email" ? "guest@example.com" : "9123 4567"} autoFocus inputClassName="min-h-14 text-line" />
              <Button size="lg" variant="primary" isDisabled={offline || busy || destination.trim().length < 3} isPending={busy} onPress={send}>
                Send receipt by {channel === "email" ? "email" : "SMS"}
              </Button>
            </>
          )}
          <Button size="lg" variant="quiet" onPress={() => setChoice(null)}>
            Other receipt options
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-center gap-3">
        {check.invoice_no || invoice ? (
          <span className="rounded-chip bg-surface-2 px-3 py-2 text-body text-ink tabular">Invoice {invoice?.invoice_no ?? check.invoice_no}</span>
        ) : (
          <Button size="lg" variant="quiet" isDisabled={offline || busy} onPress={getInvoice}>
            Get invoice
          </Button>
        )}
        <Button size="lg" variant="primary" onPress={onDone} className="relative min-w-[220px] overflow-hidden">
          {doneLabel}
          {counting ? <span aria-hidden className="pos-countdown keep-motion absolute inset-x-0 bottom-0 h-1 bg-on-primary/40" style={{ "--pos-countdown-ms": `${autoReturnMs}ms` } as React.CSSProperties} /> : null}
        </Button>
      </div>
    </div>
  );
}
