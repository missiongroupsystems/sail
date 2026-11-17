import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import type { BillDocument } from "@sail/shared";
import { pdfDateTime, pdfMoney, savePdf, winAnsi } from "../lib/pdf-text.js";
import { db, tx } from "../db/client.js";
import { checks, digitalReceipts, invoiceCancellations, merchants, outlets } from "../db/schema/index.js";
import type { Principal } from "../auth/principal.js";
import { AppError } from "../lib/errors.js";
import { randomToken, sha256 } from "../auth/tokens.js";
import { config } from "../config.js";

/**
 * Tax documents: gap-free numbering per merchant inside
 * the transaction, numbered PDF tax invoices with the outlet's registration
 * numbers, and digital receipt tokens.
 */
export const DOCUMENT_PREFIX: Record<string, string> = { invoice: "INV-", credit_note: "CN-", refund_receipt: "RR-" };

/** Next number for a document kind, incremented under a row lock so concurrent issuers never collide or skip. */
export async function nextDocumentNo(merchantId: string, kind: "invoice" | "credit_note" | "refund_receipt"): Promise<string> {
  const [row] = await tx()<{ n: number }[]>`
    insert into document_sequences (merchant_id, kind, next_no, prefix) values (${merchantId}, ${kind}, 2, ${DOCUMENT_PREFIX[kind] ?? ""})
    on conflict (merchant_id, kind) do update set next_no = document_sequences.next_no + 1
    returning next_no - 1 as n`;
  return `${DOCUMENT_PREFIX[kind] ?? ""}${String(row!.n).padStart(6, "0")}`;
}

export type InvoiceDocument = BillDocument & { invoice: { number: string; issued_at: string; merchant_name: string; outlet_address: string | null } };

/** Issue (or return the existing) tax invoice for a paid check. Issued once; reprints reuse the number. */
export async function issueInvoice(checkId: string, bill: BillDocument): Promise<{ check: typeof checks.$inferSelect; document: InvoiceDocument; reused: boolean }> {
  const [c] = await tx()<(typeof checks.$inferSelect & Record<string, unknown>)[]>`select * from checks where id = ${checkId} for update`;
  const check = c ? camel(c) : undefined;
  if (!check) throw AppError.notFound("bill", checkId);
  if (check.status !== "paid" && check.status !== "partially_refunded" && check.status !== "refunded") throw AppError.state(`${check.label} is not paid yet`, ["pay the bill first"], "An invoice can be issued once the bill is paid.");
  if (check.invoiceNo && check.invoiceDocument) return { check, document: check.invoiceDocument as InvoiceDocument, reused: true };
  const [merchant] = await db().select().from(merchants).where(eq(merchants.id, check.merchantId)).limit(1);
  const [outlet] = await db().select({ address: outlets.address }).from(outlets).where(eq(outlets.id, check.outletId)).limit(1);
  const number = await nextDocumentNo(check.merchantId, "invoice");
  const issuedAt = new Date();
  const document: InvoiceDocument = { ...bill, invoice_no: number, invoice: { number, issued_at: issuedAt.toISOString(), merchant_name: merchant?.name ?? "", outlet_address: outlet?.address ?? null } };
  const [updated] = await db().update(checks).set({ invoiceNo: number, invoiceIssuedAt: issuedAt, invoiceDocument: document, updatedAt: issuedAt }).where(eq(checks.id, checkId)).returning();
  return { check: updated!, document, reused: false };
}

/**
 * The credit note that cancels a whole invoice: every amount on it negated (items, adjustments, taxes, the payments it
 * recorded), numbered from the credit-note sequence, against the invoice's number. What a full refund's credit note holds.
 */
export function cancellingCreditNote(invoice: InvoiceDocument, creditNoteNo: string, issuedAt: Date, reason: string): InvoiceDocument {
  const neg = (n: number | undefined) => (n ? -n : n);
  return {
    ...invoice,
    kind: "refund_receipt",
    check_label: `Cancels ${invoice.invoice.number} · ${invoice.check_label}`,
    lines: invoice.lines.map((l) => ({ ...l, quantity: -l.quantity, amount: -l.amount, modifiers: l.modifiers.map((m) => ({ ...m, price: -m.price })) })),
    adjustments: invoice.adjustments.map((a) => ({ ...a, amount: -a.amount })),
    totals: { ...invoice.totals, subtotal: -invoice.totals.subtotal, discount_total: -invoice.totals.discount_total, fee_total: -invoice.totals.fee_total, tax_total: -invoice.totals.tax_total, total: -invoice.totals.total, taxes: invoice.totals.taxes.map((t) => ({ ...t, amount: -t.amount })) },
    payments: invoice.payments?.map((p) => ({ tender: p.tender, amount: -p.amount, rounding_cents: neg(p.rounding_cents), tip: neg(p.tip), charged: neg(p.charged) })),
    balance: undefined,
    invoice_no: invoice.invoice.number,
    credit_note_no: creditNoteNo,
    refund_reason: reason,
    invoice: { ...invoice.invoice, number: creditNoteNo, issued_at: issuedAt.toISOString() },
  };
}

/**
 * An invoice records a bill as paid. When a reopen or a void reverses the payment of an invoiced bill, so that the bill
 * owes money again, its invoice is cancelled by a credit note for its full amount; the bill is then free of an invoice and,
 * once paid again, is invoiced afresh with the next number. The cancelled invoice and its credit note stay retrievable.
 * Numbers stay gap-free: each is drawn only when its document is written. No money moves, so no report reads this.
 */
export async function cancelInvoicesOfReversedBills(orderId: string, reason: string, by: Principal, now = new Date()): Promise<{ check_id: string; invoice_no: string; credit_note_no: string }[]> {
  const rows = await db().select().from(checks).where(and(eq(checks.orderId, orderId), isNotNull(checks.invoiceNo))).orderBy(asc(checks.index));
  const out: { check_id: string; invoice_no: string; credit_note_no: string }[] = [];
  for (const c of rows) {
    if (c.status !== "open" || !c.invoiceNo || !c.invoiceDocument) continue;
    const creditNoteNo = await nextDocumentNo(c.merchantId, "credit_note");
    const invoice = c.invoiceDocument as InvoiceDocument;
    await db()
      .insert(invoiceCancellations)
      .values({ merchantId: c.merchantId, outletId: c.outletId, orderId, checkId: c.id, invoiceNo: c.invoiceNo, invoiceIssuedAt: c.invoiceIssuedAt, invoiceDocument: invoice, creditNoteNo, creditNoteDocument: cancellingCreditNote(invoice, creditNoteNo, now, reason), reason, cancelledBy: by.type === "staff" ? by.id : null, cancelledByName: "name" in by ? (by.name ?? null) : null });
    await db().update(checks).set({ invoiceNo: null, invoiceIssuedAt: null, invoiceDocument: null, updatedAt: now }).where(eq(checks.id, c.id));
    out.push({ check_id: c.id, invoice_no: c.invoiceNo, credit_note_no: creditNoteNo });
  }
  return out;
}

/** Cancelled invoices of these bills, oldest first, for the order snapshot. */
export async function cancelledInvoicesOf(checkIds: string[]) {
  if (!checkIds.length) return [];
  return db().select({ id: invoiceCancellations.id, checkId: invoiceCancellations.checkId, invoiceNo: invoiceCancellations.invoiceNo, creditNoteNo: invoiceCancellations.creditNoteNo, createdAt: invoiceCancellations.createdAt }).from(invoiceCancellations).where(inArray(invoiceCancellations.checkId, checkIds)).orderBy(asc(invoiceCancellations.createdAt));
}

function camel(r: Record<string, unknown>): typeof checks.$inferSelect {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) out[k.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase())] = v;
  for (const k of ["lockedAt", "paidAt", "invoiceIssuedAt", "createdAt", "updatedAt"]) if (typeof out[k] === "string") out[k] = new Date(out[k] as string);
  return out as unknown as typeof checks.$inferSelect;
}

/** Render a tax invoice or credit note as an A4 PDF from the stored document. Deterministic for the same document. */
export async function renderInvoicePdf(doc: InvoiceDocument, kind: "TAX INVOICE" | "CREDIT NOTE" = "TAX INVOICE", extra: { credit_note_no?: string; original_invoice_no?: string; reason?: string; cancelled_by?: string } = {}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${kind} ${extra.credit_note_no ?? doc.invoice.number}`);
  pdf.setProducer("Sail");
  pdf.setCreationDate(new Date(doc.invoice.issued_at));
  pdf.setModificationDate(new Date(doc.invoice.issued_at));
  const page = pdf.addPage([595.28, 841.89]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.11, 0.11, 0.12);
  const grey = rgb(0.37, 0.35, 0.33);
  let y = 790;
  // The standard fonts encode WinAnsi only (see `winAnsi`).
  const safe = winAnsi;
  const text = (raw: string, x: number, size = 10, f = font, color = ink) => page.drawText(safe(raw), { x, y, size, font: f, color });
  const right = (raw: string, xRight: number, size = 10, f = font) => {
    const s = safe(raw);
    page.drawText(s, { x: xRight - f.widthOfTextAtSize(s, size), y, size, font: f, color: ink });
  };
  const money = pdfMoney({ currency: doc.currency, locale: doc.header.locale });
  const rule = () => {
    page.drawLine({ start: { x: 48, y: y + 4 }, end: { x: 547, y: y + 4 }, thickness: 0.5, color: rgb(0.85, 0.83, 0.8) });
  };
  text(doc.invoice.merchant_name || doc.header.brand_name, 48, 16, bold);
  y -= 18;
  text(doc.header.outlet_name, 48, 10, font, grey);
  if (doc.invoice.outlet_address) {
    y -= 13;
    text(doc.invoice.outlet_address, 48, 9, font, grey);
  }
  for (const reg of [doc.business_registration, doc.tax_registration]) {
    if (!reg) continue;
    y -= 13;
    text(`${reg.label} ${reg.value}`, 48, 9, font, grey);
  }
  y = 790;
  right(kind, 547, 16, bold);
  y -= 18;
  right(extra.credit_note_no ?? doc.invoice.number, 547, 11, font);
  y -= 14;
  right(pdfDateTime(doc.invoice.issued_at, doc.header.locale, doc.header.time_zone), 547, 9, font);
  if (extra.original_invoice_no) {
    y -= 14;
    right(`Against invoice ${extra.original_invoice_no}`, 547, 9, font);
  }
  if (extra.cancelled_by) {
    y -= 14;
    right(`Cancelled by credit note ${extra.cancelled_by}`, 547, 9, bold);
  }
  y -= 36;
  text(`Order ${doc.header.order_no} · ${doc.check_label}${doc.header.table_name ? ` · Table ${doc.header.table_name}` : ""}${doc.header.customer_ref?.name ? ` · ${doc.header.customer_ref.name}` : ""}`, 48, 10, font, grey);
  y -= 24;
  text("Qty", 48, 9, bold);
  text("Item", 90, 9, bold);
  right("Unit", 460, 9, bold);
  right("Amount", 547, 9, bold);
  y -= 6;
  rule();
  y -= 14;
  // Every row multiplies by eye: Qty × Unit = Amount. The unit price includes the item's options, which are listed under
  // it by name with their own price, never as a second amount. A bill's share of a line shows the share and the line.
  for (const l of doc.lines) {
    const unit = l.unit_price + l.modifiers.reduce((n, m) => n + (m.unit_price ?? (l.quantity ? Math.round(m.price / l.quantity) : 0)), 0);
    if (l.share) {
      text(l.share, 48, 10);
      text(`${l.quantity === 1 ? "" : `${l.quantity} × `}${l.name} (share of the item)`, 90, 10);
      right(money(unit * l.quantity), 460, 10);
    } else {
      text(String(l.quantity), 48, 10);
      text(l.name, 90, 10);
      right(money(unit), 460, 10);
    }
    right(money(l.amount), 547, 10);
    y -= 14;
    for (const m of l.modifiers) {
      const each = m.unit_price ?? (l.quantity ? Math.round(m.price / l.quantity) : 0);
      text(each ? `+ ${m.name} ${money(each)}` : `+ ${m.name}`, 100, 9, font, grey);
      y -= 12;
    }
  }
  y -= 4;
  rule();
  y -= 16;
  // A long label ("Consumption tax 8% (reduced) (included)") starts further left rather than running into its amount.
  const row = (label: string, amount: number, f = font) => {
    const shown = money(amount);
    const room = 547 - f.widthOfTextAtSize(safe(shown), 10) - 12;
    text(label, Math.max(48, Math.min(340, room - f.widthOfTextAtSize(safe(label), 10))), 10, f);
    right(shown, 547, 10, f);
    y -= 14;
  };
  // Lowest rate first, as the POS, the receipt and the reports list them (review 2, N11).
  const taxes = [...doc.totals.taxes].sort((a, b) => a.bps - b.bps || a.name.localeCompare(b.name));
  row("Subtotal", doc.totals.subtotal);
  for (const a of doc.adjustments) row(a.name, a.amount);
  // One row per tax component, labelled with its own name.
  if (doc.totals.tax_mode === "exclusive") for (const t of taxes) row(t.name, t.amount);
  row(kind === "CREDIT NOTE" ? "Credit total" : "Total", doc.totals.total, bold);
  if (doc.totals.tax_mode === "inclusive") for (const t of taxes) row(`${t.name} (included)`, t.amount);
  if (doc.tax_note) {
    text(doc.tax_note, Math.max(48, Math.min(340, 547 - font.widthOfTextAtSize(safe(doc.tax_note), 8))), 8, font, grey);
    y -= 12;
  }
  if (doc.payments?.length) {
    y -= 6;
    for (const p of doc.payments) {
      row(p.tender + (p.reference ? ` · ${p.reference}` : ""), p.amount);
      // The same rows, in the same order, as the thermal receipt and the digital one.
      if (p.rounding_cents) row("Cash rounding", p.rounding_cents);
      if (p.tip) row("Tip", p.tip);
      if (p.charged) row("Charged", p.charged);
      if (p.change && p.tendered) row("Tendered", p.tendered);
      if (p.change) row("Change", p.change);
    }
  }
  if (extra.reason) {
    y -= 10;
    text(`Reason: ${extra.reason}`, 48, 9, font, grey);
  }
  y = 60;
  for (const line of doc.footer_lines ?? []) {
    text(line, 48, 9, font, grey);
    y -= 12;
  }
  return savePdf(pdf, [font, bold]);
}

/** Create a public digital receipt link for a check (or refund). */
export async function createDigitalReceipt(input: { merchantId: string; outletId: string; checkId?: string | null; refundId?: string | null; document: unknown; channel: "qr" | "email" | "sms" | "link"; destination?: string | null }): Promise<{ token: string; url: string; delivery_status: string }> {
  const token = randomToken(18);
  const expiresAt = new Date(Date.now() + 90 * 24 * 3600 * 1000);
  // Email and SMS providers are a v0.9 input; until then the link and QR are the delivery.
  const deliveryStatus = input.channel === "email" || input.channel === "sms" ? "provider_not_configured" : "link_only";
  // Only the hash is stored: the token is the sole guard on the public link.
  await db().insert(digitalReceipts).values({ token: sha256(token), merchantId: input.merchantId, outletId: input.outletId, checkId: input.checkId ?? null, refundId: input.refundId ?? null, document: input.document, channel: input.channel, destination: input.destination ?? null, deliveryStatus, expiresAt });
  return { token, url: `${config().GUEST_APP_URL.replace(/\/$/, "")}/r/${token}`, delivery_status: deliveryStatus };
}

export async function readDigitalReceipt(token: string) {
  const [row] = await db().select().from(digitalReceipts).where(and(eq(digitalReceipts.token, sha256(token)))).limit(1);
  if (!row || row.expiresAt.getTime() < Date.now()) throw AppError.notFound("receipt");
  return row;
}
