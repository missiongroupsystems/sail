"use client";

import { ReceiptText } from "lucide-react";
import { cx } from "../lib/cx";
import { Icon } from "../components/Icon";
import { Money } from "../components/Money";
import { useLocale } from "../lib/locale";
import { taxRows } from "../lib/tax";

/**
 * The bill document the register prints (shared/escpos BillDocument), typed
 * structurally so this package stays free of the schema. Every amount is an
 * integer in minor units of `currency` from the register; this component only
 * formats. Render it under a `LocaleProvider` built from the document's own
 * `currency`, `header.locale` and `header.time_zone`.
 */
export type BillDocumentLike = {
  kind: "prebill" | "receipt" | "refund_receipt";
  header: { outlet_name: string; brand_name: string; order_no: string; table_name?: string; printed_at: string; server_name?: string; pax?: number; time_zone: string; locale: string };
  /** ISO 4217 code every amount is in. */
  currency: string;
  /** Decimal places of the currency's minor unit, from the register. */
  currency_exponent: number;
  check_label: string;
  lines: { quantity: number; name: string; unit_price: number; amount: number; modifiers: { name: string; price: number }[]; seat_no?: number; share?: string }[];
  adjustments: { name: string; amount: number; kind: "fee" | "discount" }[];
  totals: { subtotal: number; discount_total: number; fee_total: number; tax_total: number; total: number; tax_mode: "inclusive" | "exclusive"; taxes: { name: string; bps: number; amount: number }[] };
  payments?: { tender: string; amount: number; rounding_cents?: number; reference?: string; tip?: number; change?: number }[];
  balance?: number;
  invoice_no?: string;
  credit_note_no?: string;
  original_check_no?: string;
  original_date?: string;
  refund_reason?: string;
  footer_lines?: string[];
  outlet_phone?: string;
  business_registration?: { label: string; value: string };
  tax_registration?: { label: string; value: string };
};

export type BillDocumentViewProps = {
  document: BillDocumentLike;
  className?: string;
};

const KIND_LABEL: Record<BillDocumentLike["kind"], string> = { prebill: "Bill", receipt: "Receipt", refund_receipt: "Refund receipt" };

function Row({ label, cents, strong, muted, signed }: { label: string; cents: number; strong?: boolean; muted?: boolean; signed?: boolean }) {
  return (
    <div className={cx("flex items-baseline justify-between gap-4", strong ? "pt-1 text-[18px] font-semibold text-ink" : muted ? "text-[15px] text-ink-2" : "text-[15px] text-ink")}>
      <span className="min-w-0 wrap-anywhere">{label}</span>
      <Money cents={cents} size={strong ? "heading" : "body"} signed={signed} className={cx(strong ? "font-heading text-[18px] font-semibold" : "text-[15px] text-ink")} />
    </div>
  );
}

/**
 * One bill grammar on every surface: the lines, the
 * adjustments, a row per tax component in the outlet's tax mode, the total, then the
 * payments with cash rounding, tip and change, and the document numbers. On the phone
 * it is a summary card: the brand over the document's name, the lines in a bordered
 * card, the totals in a grey panel.
 */
export function BillDocumentView({ document: doc, className }: BillDocumentViewProps) {
  const t = doc.totals;
  const tax = taxRows(t.taxes, t.tax_mode);
  const { stamp } = useLocale();
  return (
    <article className={cx("flex flex-col gap-5", className)} aria-label={`${KIND_LABEL[doc.kind]} ${doc.check_label}`}>
      <header className="flex flex-col items-center gap-1 text-center">
        <span aria-hidden className="mb-3 flex size-[72px] items-center justify-center rounded-full bg-surface-2 text-ink">
          <Icon icon={ReceiptText} size={32} />
        </span>
        <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight text-balance text-ink wrap-anywhere">{doc.header.brand_name}</h1>
        <p className="text-[15px] text-ink-2">{doc.header.outlet_name}</p>
        <p className="mt-2 text-[15.5px] font-medium text-ink">
          {KIND_LABEL[doc.kind]} · {doc.check_label}
        </p>
        <p className="text-[14px] text-ink-2 tabular">
          Order {doc.header.order_no}
          {doc.header.table_name ? ` · Table ${doc.header.table_name}` : ""}
          {" · "}
          {stamp(doc.header.printed_at)}
        </p>
        {doc.invoice_no ? <p className="font-mono text-caption text-ink-2">Tax invoice {doc.invoice_no}</p> : null}
        {doc.credit_note_no ? <p className="font-mono text-caption text-ink-2">Credit note {doc.credit_note_no}</p> : null}
        {doc.original_check_no ? (
          <p className="text-caption text-ink-2">
            Refund of {doc.original_check_no}
            {doc.original_date ? `, paid ${stamp(doc.original_date)}` : ""}
          </p>
        ) : null}
        {doc.refund_reason ? <p className="text-caption text-ink-2 wrap-anywhere">Reason: {doc.refund_reason}</p> : null}
      </header>

      <ul className="flex flex-col divide-y divide-rule-subtle rounded-sheet border border-rule px-4" aria-label="Items">
        {doc.lines.map((l, i) => (
          <li key={i} className="flex flex-col gap-0.5 py-3">
            <div className="flex items-baseline gap-3">
              <span className="min-w-0 flex-1 text-[15.5px] leading-snug text-ink wrap-anywhere">
                <span className="font-medium tabular">{l.quantity} ×</span> {l.name}
                {l.share ? <span className="text-ink-2"> · {l.share}</span> : null}
                {l.seat_no ? <span className="text-ink-2"> · Seat {l.seat_no}</span> : null}
              </span>
              <Money cents={l.amount} size="body" className="text-[15px] text-ink" />
            </div>
            {l.modifiers.map((m, j) => (
              <div key={j} className="flex items-baseline gap-3 text-[13.5px] text-ink-2">
                <span className="min-w-0 flex-1 wrap-anywhere">{m.name}</span>
                {m.price ? <Money cents={m.price} size="caption" signed /> : null}
              </div>
            ))}
            {l.quantity > 1 ? (
              <div className="text-[13.5px] text-ink-2">
                <Money cents={l.unit_price} size="caption" /> each
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      <section className="flex flex-col gap-2.5 rounded-sheet bg-surface-2 px-4 py-4" aria-label="Totals">
        <Row label="Subtotal" cents={t.subtotal} muted />
        {doc.adjustments.map((a, i) => (
          <Row key={i} label={a.name} cents={a.amount} muted />
        ))}
        {tax.before.map((r) => (
          <Row key={r.key} label={r.label} cents={r.amount} muted />
        ))}
        <div className="mt-1 border-t border-rule pt-2">
          <Row label="Total" cents={t.total} strong />
        </div>
        {tax.after.map((r) => (
          <Row key={r.key} label={r.label} cents={r.amount} muted />
        ))}
      </section>

      {doc.payments?.length ? (
        <section className="flex flex-col divide-y divide-rule-subtle rounded-sheet border border-rule" aria-label="Payments">
          {doc.payments.map((p, i) => (
            <div key={i} className="flex flex-col gap-1 px-4 py-3.5">
              <Row label={p.tender} cents={p.amount} />
              {p.reference ? <p className="font-mono text-caption text-ink-2">Ref {p.reference}</p> : null}
              {p.rounding_cents ? <Row label="Cash rounding" cents={p.rounding_cents} muted signed /> : null}
              {p.tip ? <Row label="Tip" cents={p.tip} muted /> : null}
              {p.change ? <Row label="Change" cents={p.change} muted /> : null}
            </div>
          ))}
        </section>
      ) : null}
      {doc.balance != null && doc.balance !== 0 ? (
        <section className="rounded-sheet bg-surface-2 px-4 py-3.5">
          <Row label="Balance due" cents={doc.balance} strong />
        </section>
      ) : null}

      {doc.footer_lines?.length || doc.outlet_phone || doc.business_registration || doc.tax_registration ? (
        <footer className="flex flex-col items-center gap-1 pt-1 text-center text-caption text-ink-2 wrap-anywhere">
          {doc.footer_lines?.map((f, i) => <p key={i}>{f}</p>)}
          {doc.outlet_phone ? <p className="tabular">Tel {doc.outlet_phone}</p> : null}
          {[doc.business_registration, doc.tax_registration].map((reg, i) =>
            reg ? (
              <p key={i} className="font-mono">
                {reg.label} {reg.value}
              </p>
            ) : null,
          )}
        </footer>
      ) : null}
    </article>
  );
}
