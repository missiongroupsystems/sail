import { EscPosEncoder, canEncodeSingleByte, type Align, type CjkEncoder, type SizeMultiplier } from "./encoder.js";
import { ORDER_TYPE_LABELS, formatDate, formatDateTime, formatTime, referenceLabel } from "./format.js";
import {
  COLUMNS,
  DOTS_PER_LINE,
  columns,
  detailLine,
  documentToText,
  feed,
  fit,
  itemLine,
  justify,
  kitchenItemBlock,
  large,
  modifierLine,
  money,
  moneyRow,
  rule,
  seatChip,
  text,
  wrap,
  type DocLine,
} from "./layout.js";
import { renderTextAsImageDefault, type RenderTextAsImage } from "./raster.js";
import type { BillDocument, KitchenTicket, PrintJobPayload, PrinterProfile, ServiceSlip, TicketHeader } from "./types.js";

/**
 * The three templates of scope doc 4.7: kitchen ticket (with void and reprint
 * banners), bill (pre-bill, receipt, refund receipt) and service-request slip.
 *
 * Each template first builds a styled document (layout.ts), then renders it
 * twice: as plain text for golden files and the back-office preview, and as
 * ESC/POS bytes for the relay. Both come from the same lines, so what the
 * preview shows is what the printer prints, column for column.
 */

export interface RenderOptions {
  /** Replaces the deterministic placeholder renderer used for lines the code page cannot carry. */
  renderTextAsImage?: RenderTextAsImage;
  /** Byte encoder for Kanji-mode text when the profile has `code_page_cjk`. Defaults to UTF-8. */
  encodeCjk?: CjkEncoder;
  /** ESC t code page for single-byte text. Defaults to 16 (WPC1252). */
  codePage?: number;
}

export interface RenderedJob {
  bytes: Uint8Array;
  /** Plain-text rendering with the same layout and no control bytes. */
  text: string;
}

const BANNER_BY_KIND: Record<KitchenTicket["kind"], string | undefined> = {
  kitchen: undefined,
  void: "VOID",
  reprint: "REPRINT",
};

const BILL_TITLE: Record<BillDocument["kind"], string> = {
  prebill: "Pre-bill",
  receipt: "Receipt",
  refund_receipt: "Refund receipt",
};

// ---------------------------------------------------------------------------
// Shared blocks

function outletBlock(h: TicketHeader, opts: { largeName: boolean }): DocLine[] {
  const out: DocLine[] = [];
  out.push(text(h.outlet_name, { align: "center", bold: true, height: opts.largeName ? 2 : 1 }));
  if (h.brand_name.trim() !== h.outlet_name.trim()) out.push(text(h.brand_name, { align: "center" }));
  return out;
}

function timeAndJob(h: TicketHeader, cols: number): DocLine[] {
  return columns(formatDateTime(h.printed_at, h.time_zone, h.locale), `Job ${h.job_id}`, cols).map((t) => text(t));
}

function customerOrderDetails(h: TicketHeader, cols: number): DocLine[] {
  const out: DocLine[] = [];
  if (h.ready_by) out.push(text(`Ready by ${formatTime(h.ready_by, h.time_zone, h.locale)}`, { bold: true }));
  if (h.order_type === "delivery") {
    if (h.delivery_address) for (const t of wrap(`Deliver to: ${h.delivery_address}`, cols, { indent: 2 })) out.push(text(t));
    if (h.delivery_notes) for (const t of wrap(`Notes: ${h.delivery_notes}`, cols, { indent: 2 })) out.push(text(t));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Kitchen ticket

export function buildKitchenTicketDocument(data: KitchenTicket, cols: number): DocLine[] {
  const h = data.header;
  const doc: DocLine[] = [];
  doc.push(...outletBlock(h, { largeName: false }));

  const banner = data.banner ?? BANNER_BY_KIND[data.kind];
  if (banner) {
    doc.push(text(rule(cols, "=")));
    doc.push(text(banner, { align: "center", bold: true, width: 2, height: 2 }));
    doc.push(text(rule(cols, "=")));
  } else {
    doc.push(text(rule(cols)));
  }

  // Reference and order facts.
  for (const t of columns(h.order_no, ORDER_TYPE_LABELS[h.order_type], cols)) doc.push(text(t, { bold: true }));
  const round = h.round_no !== undefined ? `Round ${h.round_no}` : "";
  for (const t of justify(referenceLabel(h), round, cols, { indent: 0 })) doc.push(large(t, { bold: true }));
  if (h.order_type !== "dine_in" && h.table_name && h.customer_ref) {
    // A pickup collected at a table, say: the table is the reference, the customer still matters.
    const who = [h.customer_ref.name, h.customer_ref.mobile].filter((p): p is string => !!p).join(" ");
    if (who) doc.push(text(who));
  }
  doc.push(...customerOrderDetails(h, cols));
  const server = h.server_name ? `Server: ${h.server_name}` : "";
  const station = h.station_name ? `Station: ${h.station_name}` : "";
  if (server || station) for (const t of columns(server, station, cols)) doc.push(text(t));
  doc.push(...timeAndJob(h, cols));
  doc.push(text(rule(cols)));

  // Items.
  for (const line of data.lines) doc.push(...kitchenItemBlock(line, cols));
  doc.push(text(rule(cols)));

  // Footer.
  if (data.copy_no !== undefined) {
    doc.push(text(data.copies !== undefined ? `Copy ${data.copy_no} of ${data.copies}` : `Copy ${data.copy_no}`, { align: "center" }));
  }
  doc.push(feed(1));
  return doc;
}

// ---------------------------------------------------------------------------
// Bill (pre-bill, receipt, refund receipt)

export function buildBillDocument(data: BillDocument, cols: number): DocLine[] {
  const h = data.header;
  const fmt = { currency: data.currency, locale: h.locale };
  const doc: DocLine[] = [];

  doc.push(...outletBlock(h, { largeName: true }));
  if (data.outlet_phone) doc.push(text(`Tel ${data.outlet_phone}`, { align: "center" }));
  for (const reg of [data.business_registration, data.tax_registration]) if (reg) doc.push(text(`${reg.label} ${reg.value}`, { align: "center" }));
  doc.push(text(rule(cols)));

  doc.push(text(BILL_TITLE[data.kind], { align: "center", bold: true, height: 2 }));
  doc.push(text(data.check_label, { align: "center" }));
  for (const t of columns(h.order_no, ORDER_TYPE_LABELS[h.order_type], cols)) doc.push(text(t));
  const reference = referenceLabel(h);
  if (reference !== ORDER_TYPE_LABELS[h.order_type]) doc.push(text(reference));
  doc.push(...customerOrderDetails(h, cols));
  const server = h.server_name ? `Server: ${h.server_name}` : "";
  for (const t of columns(formatDateTime(h.printed_at, h.time_zone, h.locale), server, cols)) doc.push(text(t));
  if (data.invoice_no) doc.push(text(`Invoice ${data.invoice_no}`, { bold: true }));
  if (data.kind === "refund_receipt") {
    if (data.original_check_no) {
      const dated = data.original_date ? `Bill date ${formatDate(data.original_date, h.time_zone, h.locale)}` : "";
      for (const t of columns(`Refund of bill ${data.original_check_no}`, dated, cols)) doc.push(text(t));
    }
    if (data.credit_note_no) doc.push(text(`Credit note ${data.credit_note_no}`, { bold: true }));
    if (data.refund_reason) for (const t of wrap(`Reason: ${data.refund_reason}`, cols, { indent: 2 })) doc.push(text(t));
  }
  doc.push(text(rule(cols)));

  // Lines.
  for (const line of data.lines) {
    for (const t of itemLine(line.quantity, line.name, cols, money(line.amount, fmt))) doc.push(text(t));
    if (line.quantity !== 1) for (const t of detailLine(`${line.quantity} @ ${money(line.unit_price, fmt)}`, cols)) doc.push(text(t));
    for (const m of line.modifiers) for (const t of modifierLine(m.name, cols, { price: m.price, fmt })) doc.push(text(t));
    const chips: string[] = [];
    if (line.seat_no !== undefined) chips.push(seatChip(line.seat_no));
    if (line.share) chips.push(`share ${line.share}`);
    if (chips.length > 0) for (const t of detailLine(chips.join(", "), cols)) doc.push(text(t));
  }
  doc.push(text(rule(cols)));

  // Totals.
  // Tax rows are labelled with the component's own name ("VAT 20%", "State sales tax").
  const totals = data.totals;
  for (const t of moneyRow("Subtotal", totals.subtotal, cols, fmt)) doc.push(text(t));
  for (const adj of data.adjustments) for (const t of moneyRow(adj.name, adj.amount, cols, fmt)) doc.push(text(t));
  if (totals.tax_mode === "exclusive") for (const tax of totals.taxes) for (const t of moneyRow(tax.name, tax.amount, cols, fmt)) doc.push(text(t));
  const totalLabel = data.kind === "refund_receipt" ? "Refund total" : "Total";
  for (const t of justify(totalLabel, money(totals.total, fmt), cols)) doc.push(large(t, { bold: true }));
  if (totals.tax_mode === "inclusive") for (const tax of totals.taxes) for (const t of moneyRow(`${tax.name} (included)`, tax.amount, cols, fmt)) doc.push(text(t));

  // Payments.
  if (data.payments && data.payments.length > 0) {
    doc.push(text(rule(cols)));
    for (const p of data.payments) {
      const label = p.reference ? `${p.tender} ${p.reference}` : p.tender;
      for (const t of moneyRow(label, p.amount, cols, fmt)) doc.push(text(t));
      if (p.rounding_cents !== undefined && p.rounding_cents !== 0) for (const t of moneyRow("Cash rounding", p.rounding_cents, cols, fmt)) doc.push(text(t));
      if (p.change !== undefined && p.change !== 0) for (const t of moneyRow("Change", p.change, cols, fmt)) doc.push(text(t));
    }
  }
  if (data.balance !== undefined) {
    if (!data.payments || data.payments.length === 0) doc.push(text(rule(cols)));
    for (const t of moneyRow("Balance due", data.balance, cols, fmt)) doc.push(text(t, { bold: true }));
  }

  // Footer.
  const footer = data.footer_lines?.filter((l) => l.trim().length > 0) ?? [];
  if (footer.length > 0 || data.digital_receipt_url) {
    doc.push(text(rule(cols)));
    for (const line of footer) for (const t of wrap(line, cols)) doc.push(text(t, { align: "center" }));
    if (data.digital_receipt_url) {
      doc.push(text("Digital receipt", { align: "center" }));
      for (const t of wrap(data.digital_receipt_url, cols)) doc.push(text(t, { align: "center" }));
    }
  }
  doc.push(feed(1));
  return doc;
}

// ---------------------------------------------------------------------------
// Service-request slip

export function buildServiceSlipDocument(data: ServiceSlip, cols: number): DocLine[] {
  const h = data.header;
  const doc: DocLine[] = [];
  doc.push(text("Service request", { align: "center", bold: true }));
  const wide: SizeMultiplier = data.request_type.length * 2 <= cols ? 2 : 1;
  doc.push(text(data.request_type, { align: "center", bold: true, width: wide, height: 2 }));
  doc.push(text(rule(cols)));
  doc.push(large(referenceLabel(h), { bold: true }));
  if (data.guest_name) doc.push(text(`Guest: ${data.guest_name}`));
  for (const t of columns(h.order_no, ORDER_TYPE_LABELS[h.order_type], cols)) doc.push(text(t));
  doc.push(...timeAndJob(h, cols));
  doc.push(feed(1));
  return doc;
}

// ---------------------------------------------------------------------------
// Rendering

/**
 * Encode a styled document for a printer. Lines the single-byte code page
 * cannot carry go out as Kanji-mode text when the profile has a CJK code
 * page, and as a raster image otherwise.
 */
export function documentToBytes(doc: readonly DocLine[], profile: PrinterProfile, options: RenderOptions = {}): Uint8Array {
  const cols = COLUMNS[profile.width];
  const dots = DOTS_PER_LINE[profile.width];
  const renderImage = options.renderTextAsImage ?? renderTextAsImageDefault;
  const enc = new EscPosEncoder({ cjk: profile.code_page_cjk, encodeCjk: options.encodeCjk, codePage: options.codePage });
  enc.init();

  let align: Align = "left";
  let bold = false;
  let width: SizeMultiplier = 1;
  let height: SizeMultiplier = 1;
  const setAlign = (a: Align) => {
    if (a !== align) enc.align((align = a));
  };
  const setBold = (b: boolean) => {
    if (b !== bold) enc.bold((bold = b));
  };
  const setSize = (w: SizeMultiplier, hgt: SizeMultiplier) => {
    if (w !== width || hgt !== height) enc.size((width = w), (height = hgt));
  };

  for (const line of doc) {
    if (line.kind === "feed") {
      enc.feed(line.lines);
      continue;
    }
    const a = line.align ?? "left";
    const w = line.width ?? 1;
    const hgt = line.height ?? 1;
    const content = fit(line.text, Math.floor(cols / w));
    if (!profile.code_page_cjk && !canEncodeSingleByte(content)) {
      // Raster fallback: a full-width image with the alignment baked in.
      setAlign("left");
      enc.raster(renderImage(content, dots, { align: a, width: w, height: hgt }));
      continue;
    }
    setAlign(a);
    setBold(line.bold ?? false);
    setSize(w, hgt);
    enc.line(content);
  }

  setBold(false);
  setSize(1, 1);
  setAlign("left");
  enc.feed(profile.cut ? 2 : 4);
  if (profile.beep) enc.beep();
  if (profile.cut) enc.cut();
  return enc.toBytes();
}

function render(doc: DocLine[], profile: PrinterProfile, options: RenderOptions): RenderedJob {
  return { bytes: documentToBytes(doc, profile, options), text: documentToText(doc, COLUMNS[profile.width]) };
}

export function renderKitchenTicket(data: KitchenTicket, profile: PrinterProfile, options: RenderOptions = {}): RenderedJob {
  return render(buildKitchenTicketDocument(data, COLUMNS[profile.width]), profile, options);
}

export function renderBill(data: BillDocument, profile: PrinterProfile, options: RenderOptions = {}): RenderedJob {
  return render(buildBillDocument(data, COLUMNS[profile.width]), profile, options);
}

export function renderServiceSlip(data: ServiceSlip, profile: PrinterProfile, options: RenderOptions = {}): RenderedJob {
  return render(buildServiceSlipDocument(data, COLUMNS[profile.width]), profile, options);
}

/** Render a stored print-job payload with the template it names. */
export function renderPrintJob(payload: PrintJobPayload, profile: PrinterProfile, options: RenderOptions = {}): RenderedJob {
  switch (payload.template) {
    case "kitchen_ticket":
      return renderKitchenTicket(payload.data, profile, options);
    case "bill":
      return renderBill(payload.data, profile, options);
    case "service_slip":
      return renderServiceSlip(payload.data, profile, options);
  }
}
