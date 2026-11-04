import { cx } from "../lib/cx";
import { Money } from "../components/Money";
import { formatBpsText } from "../pos/AmountPad";

/**
 * The bill document the register prints (shared/escpos BillDocument), typed
 * structurally so this package stays free of the schema. Every amount is an
 * integer in cents from the register; this component only formats.
 */
export type BillDocumentLike = {
  kind: "prebill" | "receipt" | "refund_receipt";
  header: { outlet_name: string; brand_name: string; order_no: string; table_name?: string; printed_at: string; server_name?: string; pax?: number; time_zone?: string };
  check_label: string;
  lines: { quantity: number; name: string; unit_price: number; amount: number; modifiers: { name: string; price: number }[]; seat_no?: number; share?: string }[];
  adjustments: { name: string; amount: number; kind: "fee" | "discount" }[];
  totals: { subtotal: number; discount_total: number; fee_total: number; gst_total: number; total: number; tax_mode: "inclusive" | "exclusive"; gst_bps: number };
  payments?: { tender: string; amount: number; rounding_cents?: number; reference?: string; change?: number }[];
  balance?: number;
  invoice_no?: string;
  credit_note_no?: string;
  original_check_no?: string;
  original_date?: string;
  refund_reason?: string;
  footer_lines?: string[];
  outlet_phone?: string;
  uen?: string;
};

export type BillDocumentViewProps = {
  document: BillDocumentLike;
  className?: string;
};

const KIND_LABEL: Record<BillDocumentLike["kind"], string> = { prebill: "Bill", receipt: "Receipt", refund_receipt: "Refund receipt" };

function stamp(iso: string, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat("en-SG", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZone: timeZone ?? "Asia/Singapore" }).format(new Date(iso)).replace(/\b(AM|PM)\b/g, (m) => m.toLowerCase());
  } catch {
    return iso;
  }
}

function Row({ label, cents, strong, muted, signed }: { label: string; cents: number; strong?: boolean; muted?: boolean; signed?: boolean }) {
  return (
    <div className={cx("flex items-baseline justify-between gap-4", strong ? "text-title text-ink" : muted ? "text-body text-ink-2" : "text-body text-ink")}>
      <span className="min-w-0">{label}</span>
      <Money cents={cents} size={strong ? "title" : "body"} signed={signed} />
    </div>
  );
}

/**
 * One bill grammar on every surface (design principle 10): the lines, the
 * adjustments, the GST line in the outlet's tax mode, the total, then the
 * payments with cash rounding and change, and the document numbers.
 */
export function BillDocumentView({ document: doc, className }: BillDocumentViewProps) {
  const t = doc.totals;
  const gst = formatBpsText(t.gst_bps);
  return (
    <article className={cx("flex flex-col gap-6", className)} aria-label={`${KIND_LABEL[doc.kind]} ${doc.check_label}`}>
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-title text-ink">{doc.header.brand_name}</h1>
        <p className="text-body text-ink-2">{doc.header.outlet_name}</p>
        <p className="mt-2 text-line text-ink">
          {KIND_LABEL[doc.kind]} · {doc.check_label}
        </p>
        <p className="text-body text-ink-2 tabular">
          Order {doc.header.order_no}
          {doc.header.table_name ? ` · Table ${doc.header.table_name}` : ""}
          {" · "}
          {stamp(doc.header.printed_at, doc.header.time_zone)}
        </p>
        {doc.invoice_no ? <p className="font-mono text-caption text-ink-2">Tax invoice {doc.invoice_no}</p> : null}
        {doc.credit_note_no ? <p className="font-mono text-caption text-ink-2">Credit note {doc.credit_note_no}</p> : null}
        {doc.original_check_no ? (
          <p className="text-caption text-ink-2">
            Refund of {doc.original_check_no}
            {doc.original_date ? `, paid ${stamp(doc.original_date, doc.header.time_zone)}` : ""}
          </p>
        ) : null}
        {doc.refund_reason ? <p className="text-caption text-ink-2">Reason: {doc.refund_reason}</p> : null}
      </header>

      <ul className="flex flex-col hairline-t" aria-label="Items">
        {doc.lines.map((l, i) => (
          <li key={i} className="flex flex-col gap-1 py-3 hairline-b">
            <div className="flex items-baseline gap-3">
              <span className="w-7 shrink-0 text-body tabular text-ink-2">{l.quantity}×</span>
              <span className="min-w-0 flex-1 text-body text-ink">
                {l.name}
                {l.share ? <span className="text-ink-2"> · {l.share}</span> : null}
                {l.seat_no ? <span className="text-ink-2"> · Seat {l.seat_no}</span> : null}
              </span>
              <Money cents={l.amount} size="body" className="text-ink" />
            </div>
            {l.modifiers.map((m, j) => (
              <div key={j} className="flex items-baseline gap-3 pl-10 text-caption text-ink-2">
                <span className="min-w-0 flex-1">{m.name}</span>
                {m.price ? <Money cents={m.price} size="caption" signed /> : null}
              </div>
            ))}
            {l.quantity > 1 ? (
              <div className="pl-10 text-caption text-ink-2">
                <Money cents={l.unit_price} size="caption" /> each
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      <section className="flex flex-col gap-2" aria-label="Totals">
        <Row label="Subtotal" cents={t.subtotal} muted />
        {doc.adjustments.map((a, i) => (
          <Row key={i} label={a.name} cents={a.amount} muted />
        ))}
        {t.tax_mode === "exclusive" ? <Row label={`GST ${gst}`} cents={t.gst_total} muted /> : null}
        <div className="pt-2 hairline-t">
          <Row label="Total" cents={t.total} strong />
        </div>
        {t.tax_mode === "inclusive" ? <Row label={`Includes GST ${gst}`} cents={t.gst_total} muted /> : null}
      </section>

      {doc.payments?.length ? (
        <section className="flex flex-col gap-2 pt-4 hairline-t" aria-label="Payments">
          {doc.payments.map((p, i) => (
            <div key={i} className="flex flex-col gap-1">
              <Row label={p.tender} cents={p.amount} />
              {p.reference ? <p className="font-mono text-caption text-ink-2">Ref {p.reference}</p> : null}
              {p.rounding_cents ? <Row label="Cash rounding" cents={p.rounding_cents} muted signed /> : null}
              {p.change ? <Row label="Change" cents={p.change} muted /> : null}
            </div>
          ))}
        </section>
      ) : null}
      {doc.balance != null && doc.balance !== 0 ? (
        <section className="pt-4 hairline-t">
          <Row label="Balance due" cents={doc.balance} strong />
        </section>
      ) : null}

      {doc.footer_lines?.length || doc.outlet_phone || doc.uen ? (
        <footer className="flex flex-col gap-1 pt-4 text-caption text-ink-2 hairline-t">
          {doc.footer_lines?.map((f, i) => <p key={i}>{f}</p>)}
          {doc.outlet_phone ? <p className="tabular">Tel {doc.outlet_phone}</p> : null}
          {doc.uen ? <p className="font-mono">UEN {doc.uen}</p> : null}
        </footer>
      ) : null}
    </article>
  );
}
