"use client";

import { Button, Icon, Money, TextField, useLocale } from "@sail/ui";
import { Check, Mail, Printer, QrCode } from "lucide-react";
import { useState } from "react";
import type { CheckSnapshot, OrderSnapshot, ReceiptSend } from "../api/types";
import type { OrderActions } from "../hooks/useOrderActions";
import { usePos } from "./PosContext";
import { QrCodeImage } from "./QrCodeImage";

export type ReceiptChooserProps = {
  order: OrderSnapshot;
  check: CheckSnapshot;
  actions: OrderActions;
  /** The grey line over the amount: "Paid · Bill 2 · Table 4". */
  caption: string;
  /** The amount in large type, from the register. */
  amount: number;
  /** Quiet actions beside Get invoice (Void payment on the paid screen). */
  extra?: React.ReactNode;
  /** "Change $6.85", from the register. */
  sub?: { main: string | null; minor: string | null } | null;
  onDone: () => void;
  doneLabel: string;
};

type Choice = "print" | "qr" | "send" | "none" | null;

/**
 * The payment done screen: a grey line saying what was paid over the amount in large type, then Print,
 * QR on screen, Email/SMS and No receipt as large buttons, Get invoice, and an
 * auto-return that any tap cancels.
 */
/** Whether an email or SMS provider delivers receipts. None is configured in Sail, so the guest scans or is sent the link. */
const DELIVERY_CONFIGURED = false;

export function ReceiptChooser({ order, check, actions, caption, amount, extra, sub, onDone, doneLabel }: ReceiptChooserProps) {
  const { offline } = usePos();
  const { money } = useLocale();
  // A part payment leaves this bill open: say what is left on it (the register's balance), and count only the other bills.
  const thisOpen = order.checks.find((c) => c.id === check.id);
  const leftHere = thisOpen && thisOpen.status === "open" && thisOpen.balance > 0 ? `${money(thisOpen.balance)} left to pay on ${thisOpen.label}` : null;
  const others = order.checks.filter((c) => c.status === "open" && c.id !== check.id).length;
  const parts = [leftHere, others ? `${others} more ${others === 1 ? "bill" : "bills"} to pay on this order` : null].filter(Boolean);
  const stillToPay = parts.length ? `${parts.join(" · ")}.` : "Nothing more to pay on this order.";
  const [choice, setChoice] = useState<Choice>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<ReceiptSend | null>(null);
  const [invoiceNo, setInvoiceNo] = useState<string | null>(null);
  const [channel, setChannel] = useState<"email" | "sms">("email");
  const [copied, setCopied] = useState(false);
  const [destination, setDestination] = useState("");
  const [printed, setPrinted] = useState(false);
  const print = async () => {
    setChoice("print");
    setBusy(true);
    const jobs = await actions.printReceipt(check.id);
    setBusy(false);
    if (jobs) setPrinted(true);
  };
  const qr = async () => {
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
  // One path with the Bill screen and closed orders: issue the invoice if the bill has none, then open its PDF in the
  // same tap (review 3, S3).
  const [opening, setOpening] = useState(false);
  const getInvoice = async () => {
    setOpening(true);
    const no = await actions.getInvoice(check.id, invoiceNo ?? check.invoice_no);
    setOpening(false);
    if (no) setInvoiceNo(no);
  };

  // White receipt cards with an icon over the label, as on the paid screen's reference.
  const big = "min-h-24 w-[176px] flex-col gap-1.5 rounded-panel! border! border-rule! bg-surface! gap-1.5! text-[15px]! font-medium data-[hovered]:bg-surface-2! data-[pressed]:bg-surface-2!";

  return (
    <div className="flex h-full flex-col items-center justify-center gap-8 px-8 py-6">
      {/* The block's name is the whole sentence ("Paid · Bill 2 · $43.16"), so a screen reader hears it at once. */}
      <section aria-label={`${caption.split(" · ").slice(0, 2).join(" · ")} · ${money(amount)}`} className="flex flex-col items-center gap-1.5 text-center">
        <span aria-hidden className="mb-3 flex size-14 items-center justify-center rounded-full bg-status-paid-tint text-status-paid">
          <Icon icon={Check} size={24} />
        </span>
        <p className="text-[16px] text-ink-2 tabular">{caption}</p>
        <Money cents={amount} size="amount-xl" className="font-heading text-[40px] leading-tight font-semibold tracking-[-0.02em] text-ink" />
        {/* The change to hand over on its own line; the tip (and any rounding) small and grey under it. */}
        {sub?.main ? <p className="mt-1 text-[18px] text-ink tabular">{sub.main}</p> : null}
        {sub?.minor ? <p className="text-[14px] text-ink-2 tabular">{sub.minor}</p> : null}
        {order.status === "completed" ? <p className="text-body text-ink-2">Every bill is paid. The order is done.</p> : <p className="text-body text-ink-2">{stillToPay}</p>}
      </section>

      {choice === null || choice === "print" || choice === "none" ? (
        <div className="flex w-full max-w-[880px] flex-wrap justify-center gap-2.5" role="group" aria-label="Receipt">
          <Button size="lg" variant="secondary" isDisabled={offline || busy} isPending={busy && choice === "print"} onPress={print} className={big}>
            <Icon icon={Printer} size={18} className="opacity-70" />
            {printed ? "Printed ✓ · Print again" : "Print"}
          </Button>
          <Button size="lg" variant="secondary" isDisabled={offline || busy} onPress={qr} className={big}>
            <Icon icon={QrCode} size={18} className="opacity-70" />
            QR on screen
          </Button>
          {/* Email and SMS are offered only where a delivery provider is set up; Sail ships none, so the QR code and the link are the delivery. */}
          {DELIVERY_CONFIGURED ? (
          <Button
            size="lg"
            variant="secondary"
            isDisabled={offline || busy}
            onPress={() => {
              setChoice("send");
            }}
            className={big}
          >
            <Icon icon={Mail} size={18} className="opacity-70" />
            Email / SMS
          </Button>
          ) : null}
          <Button
            size="lg"
            variant="secondary"
            onPress={() => {
              setChoice("none");
              onDone();
            }}
            className={big}
          >
            <Icon icon={Check} size={18} className="opacity-70" />
            No receipt
          </Button>
        </div>
      ) : null}

      {choice === "qr" ? (
        <div className="flex flex-col items-center gap-3">
          {sent ? <QrCodeImage url={sent.url} size={260} label="Receipt link as a QR code" /> : <div className="size-[260px] animate-skeleton rounded-tile bg-surface-2" />}
          <p className="text-body text-ink-2">The guest scans this to open their receipt.</p>
          <div className="flex flex-wrap justify-center gap-2">
            {sent ? (
              <Button
                size="lg"
                variant="secondary"
                onPress={() => {
                  void navigator.clipboard?.writeText(sent.url).then(
                    () => setCopied(true),
                    () => setCopied(false),
                  );
                }}
              >
                {copied ? "Link copied" : "Copy link"}
              </Button>
            ) : null}
            <Button size="lg" variant="quiet" onPress={() => setChoice(null)}>
              Other receipt options
            </Button>
          </div>
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
              <TextField aria-label={channel === "email" ? "Email address" : "Mobile number"} value={destination} onChange={setDestination} type={channel === "email" ? "email" : "tel"} placeholder={channel === "email" ? "guest@example.com" : "Mobile number"} autoFocus inputClassName="min-h-14 text-line" />
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
        {extra}
        {(check.invoice_no || invoiceNo) && !actions.mayReadInvoice ? (
          <span className="rounded-chip bg-surface-2 px-3 py-2 text-body text-ink tabular">Invoice {invoiceNo ?? check.invoice_no}</span>
        ) : (
          // Issued before (here or on another screen): its PDF opens again from here.
          <Button size="lg" variant="quiet" isDisabled={offline || busy} isPending={opening} onPress={getInvoice} className="tabular">
            {check.invoice_no || invoiceNo ? `Invoice ${invoiceNo ?? check.invoice_no} · PDF` : "Get invoice"}
          </Button>
        )}
        <Button size="lg" variant="primary" onPress={onDone} className="min-w-[220px]">
          {doneLabel}
        </Button>
      </div>
    </div>
  );
}
