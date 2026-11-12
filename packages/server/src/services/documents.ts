import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { and, eq } from "drizzle-orm";
import { formatMoney, type BillDocument } from "@sail/shared";
import { db, tx } from "../db/client.js";
import { checks, digitalReceipts, merchants, outlets } from "../db/schema/index.js";
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

function camel(r: Record<string, unknown>): typeof checks.$inferSelect {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) out[k.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase())] = v;
  for (const k of ["lockedAt", "paidAt", "invoiceIssuedAt", "createdAt", "updatedAt"]) if (typeof out[k] === "string") out[k] = new Date(out[k] as string);
  return out as unknown as typeof checks.$inferSelect;
}

/** Render a tax invoice or credit note as an A4 PDF from the stored document. Deterministic for the same document. */
export async function renderInvoicePdf(doc: InvoiceDocument, kind: "TAX INVOICE" | "CREDIT NOTE" = "TAX INVOICE", extra: { credit_note_no?: string; original_invoice_no?: string; reason?: string } = {}): Promise<Uint8Array> {
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
  // The standard fonts encode WinAnsi only: use a hyphen for the minus sign and a placeholder for other scripts (CJK fonts are a follow-up).
  const safe = (s: string) => s.replace(/\u2212/g, "-").replace(/[^\u0020-\u007e\u00a0-\u00ff\u2013\u2014\u2018\u2019\u201c\u201d\u2022\u2026]/g, "?");
  const text = (raw: string, x: number, size = 10, f = font, color = ink) => page.drawText(safe(raw), { x, y, size, font: f, color });
  const right = (raw: string, xRight: number, size = 10, f = font) => {
    const s = safe(raw);
    page.drawText(s, { x: xRight - f.widthOfTextAtSize(s, size), y, size, font: f, color: ink });
  };
  const fmt = { currency: doc.currency, locale: doc.header.locale };
  const money = (amount: number) => formatMoney(amount, fmt);
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
  right(new Date(doc.invoice.issued_at).toLocaleString(doc.header.locale, { timeZone: doc.header.time_zone, dateStyle: "medium", timeStyle: "short" }), 547, 9, font);
  if (extra.original_invoice_no) {
    y -= 14;
    right(`Against invoice ${extra.original_invoice_no}`, 547, 9, font);
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
  for (const l of doc.lines) {
    text(String(l.quantity), 48, 10);
    text(l.share ? `${l.name} (${l.share})` : l.name, 90, 10);
    right(money(l.unit_price), 460, 10);
    right(money(l.amount), 547, 10);
    y -= 14;
    for (const m of l.modifiers) {
      text(`+ ${m.name}`, 100, 9, font, grey);
      if (m.price) right(money(m.price), 547, 9);
      y -= 12;
    }
  }
  y -= 4;
  rule();
  y -= 16;
  const row = (label: string, amount: number, f = font) => {
    text(label, 340, 10, f);
    right(money(amount), 547, 10, f);
    y -= 14;
  };
  row("Subtotal", doc.totals.subtotal);
  for (const a of doc.adjustments) row(a.name, a.amount);
  // One row per tax component, labelled with its own name.
  if (doc.totals.tax_mode === "exclusive") for (const t of doc.totals.taxes) row(t.name, t.amount);
  row(kind === "CREDIT NOTE" ? "Credit total" : "Total", doc.totals.total, bold);
  if (doc.totals.tax_mode === "inclusive") for (const t of doc.totals.taxes) row(`${t.name} (included)`, t.amount);
  if (doc.payments?.length) {
    y -= 6;
    for (const p of doc.payments) {
      row(p.tender + (p.reference ? ` · ${p.reference}` : ""), p.amount);
      if (p.rounding_cents) row("Cash rounding", p.rounding_cents);
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
  return pdf.save({ useObjectStreams: false });
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
