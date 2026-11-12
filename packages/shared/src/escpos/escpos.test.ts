import { describe, expect, it } from "vitest";
import {
  COLUMNS,
  DLE_EOT_STATUS,
  EscPosEncoder,
  SEQUENCES,
  bitmapToAscii,
  buildBillDocument,
  canEncodeSingleByte,
  center,
  columns,
  containsBytes,
  displayWidth,
  documentToText,
  encodeSingleByte,
  endsWithBytes,
  formatDateTime,
  formatTime,
  glyph5x7,
  isWideChar,
  itemLine,
  justify,
  modifierLine,
  moneyRow,
  noteLine,
  qtyColumn,
  renderBill,
  renderKitchenTicket,
  renderPrintJob,
  renderServiceSlip,
  renderTextAsImageDefault,
  rule,
  startsWithBytes,
  wrap,
  BillDocumentSchema,
  KitchenTicketSchema,
  PrintJobPayloadSchema,
  PrinterProfileSchema,
  ServiceSlipSchema,
  type BillDocument,
  type KitchenTicket,
  type PaperWidth,
  type PrinterProfile,
  type ServiceSlip,
  type TicketHeader,
} from "./index.js";

// ---------------------------------------------------------------------------
// Fixtures

const PROFILES: Record<PaperWidth, PrinterProfile> = {
  "80mm": { width: "80mm", code_page_cjk: false, cut: true },
  "58mm": { width: "58mm", code_page_cjk: false, cut: true },
};
const WIDTHS: PaperWidth[] = ["80mm", "58mm"];

const dineInHeader: TicketHeader = {
  outlet_name: "Sail Kopitiam Tanjong Pagar",
  brand_name: "Sail Kopitiam",
  order_no: "P-0042",
  order_type: "dine_in",
  table_name: "12",
  pax: 4,
  server_name: "Amy",
  station_name: "Front counter",
  printed_at: "2026-11-04T19:42:00+08:00",
  job_id: "8f3a2c1d",
  round_no: 2,
  time_zone: "Asia/Singapore",
  locale: "en-SG",
};

const pickupHeader: TicketHeader = {
  outlet_name: "Sail Kopitiam Tanjong Pagar",
  brand_name: "Sail Kopitiam",
  order_no: "P-0043",
  order_type: "pickup",
  customer_ref: { name: "Ben Tan", mobile: "9123 4567" },
  server_name: "Amy",
  printed_at: "2026-11-04T19:45:00+08:00",
  job_id: "c0ffee01",
  ready_by: "2026-11-04T20:05:00+08:00",
  time_zone: "Asia/Singapore",
  locale: "en-SG",
};

const deliveryHeader: TicketHeader = {
  ...pickupHeader,
  order_no: "P-0044",
  order_type: "delivery",
  job_id: "d3110e01",
  delivery_address: "Blk 123 Tanjong Pagar Plaza #05-67, Singapore 081234",
  delivery_notes: "Leave at the door, call on arrival",
};

const kitchenTicket: KitchenTicket = {
  header: dineInHeader,
  kind: "kitchen",
  lines: [
    { quantity: 2, name: "Laksa", modifiers: ["Extra chilli", "No cockles"], notes: "less spicy please", seat_no: 1 },
    { quantity: 1, name: "Kopi C kosong", modifiers: [], seat_no: 2 },
    {
      quantity: 12,
      name: "Hainanese chicken rice set with extra steamed chicken and achar",
      modifiers: ["Large", "Chicken thigh instead of breast"],
      notes: "Allergy: peanuts. Serve with the mains",
    },
  ],
  copy_no: 1,
  copies: 2,
};

const voidTicket: KitchenTicket = {
  header: { ...dineInHeader, job_id: "v01d0001", round_no: undefined },
  kind: "void",
  lines: [{ quantity: 1, name: "Kopi C kosong", modifiers: [], seat_no: 2 }],
};

const reprintTicket: KitchenTicket = {
  header: deliveryHeader,
  kind: "reprint",
  lines: [{ quantity: 1, name: "Nasi lemak", modifiers: ["Add fried egg"], notes: "no peanuts" }],
  copy_no: 1,
  copies: 1,
};

const receiptExclusive: BillDocument = {
  header: { ...dineInHeader, job_id: "b1110001" },
  kind: "receipt",
  currency: "SGD",
  currency_exponent: 2,
  check_label: "Bill 2 of 3",
  lines: [
    { quantity: 2, name: "Laksa", unit_price: 1600, amount: 3300, modifiers: [{ name: "Extra chilli", price: 100 }], seat_no: 1 },
    { quantity: 1, name: "Kopi C kosong", unit_price: 180, amount: 180, modifiers: [{ name: "Less sweet", price: 0 }], seat_no: 2 },
    { quantity: 1, name: "Tiger beer tower 3L", unit_price: 4200, amount: 1400, modifiers: [], share: "1/3" },
  ],
  adjustments: [
    { name: "Member 10% off", amount: -488, kind: "discount" },
    { name: "Service charge 10%", amount: 439, kind: "fee" },
  ],
  totals: { subtotal: 4880, discount_total: -488, fee_total: 439, tax_total: 435, total: 5266, tax_mode: "exclusive", taxes: [{ name: "GST 9%", bps: 900, amount: 435 }] },
  payments: [{ tender: "Card", amount: 5266, reference: "A1B2" }],
  invoice_no: "INV-000123",
  footer_lines: ["Thank you for dining with us", "GST registered. Prices exclude GST where shown."],
  outlet_phone: "6123 4567",
  business_registration: { label: "UEN", value: "201234567A" },
  digital_receipt_url: "https://r.sail.example/8f3a2c1d",
};

const receiptInclusiveCash: BillDocument = {
  header: { ...dineInHeader, job_id: "b1110002" },
  kind: "receipt",
  currency: "SGD",
  currency_exponent: 2,
  check_label: "Bill 1",
  lines: [
    { quantity: 2, name: "Laksa", unit_price: 1600, amount: 3300, modifiers: [{ name: "Extra chilli", price: 100 }] },
    { quantity: 1, name: "Kopi C kosong", unit_price: 180, amount: 180, modifiers: [] },
    { quantity: 1, name: "Tiger beer tower 3L", unit_price: 1400, amount: 1400, modifiers: [] },
  ],
  adjustments: [{ name: "Service charge 10%", amount: 488, kind: "fee" }],
  totals: { subtotal: 4880, discount_total: 0, fee_total: 488, tax_total: 443, total: 5368, tax_mode: "inclusive", taxes: [{ name: "GST 9%", bps: 900, amount: 443 }] },
  payments: [{ tender: "Cash", amount: 5370, rounding_cents: 2, change: 630 }],
  footer_lines: ["Thank you for dining with us"],
};

const prebill: BillDocument = {
  ...receiptInclusiveCash,
  header: { ...dineInHeader, job_id: "b1110003" },
  kind: "prebill",
  payments: undefined,
  balance: 5368,
  footer_lines: ["This is not a receipt"],
};

const refundReceipt: BillDocument = {
  header: { ...dineInHeader, job_id: "b1110004", round_no: undefined },
  kind: "refund_receipt",
  currency: "SGD",
  currency_exponent: 2,
  check_label: "Bill 1",
  lines: [{ quantity: 1, name: "Laksa", unit_price: 1600, amount: -1600, modifiers: [] }],
  adjustments: [{ name: "Service charge 10%", amount: -160, kind: "fee" }],
  totals: { subtotal: -1600, discount_total: 0, fee_total: -160, tax_total: -158, total: -1918, tax_mode: "exclusive", taxes: [{ name: "GST 9%", bps: 900, amount: -158 }] },
  payments: [{ tender: "Card", amount: -1918, reference: "R-77" }],
  invoice_no: "INV-000120",
  credit_note_no: "CN-000045",
  original_check_no: "P-0041/1",
  original_date: "2026-11-03",
  refund_reason: "Late dish",
  outlet_phone: "6123 4567",
  business_registration: { label: "UEN", value: "201234567A" },
};

const serviceSlip: ServiceSlip = {
  header: { ...dineInHeader, job_id: "5e7v1ce1", round_no: undefined, station_name: undefined },
  request_type: "Call for bill",
  guest_name: "Ben",
};

const cjkTicket: KitchenTicket = {
  header: dineInHeader,
  kind: "kitchen",
  lines: [{ quantity: 1, name: "叻沙 Laksa", modifiers: ["加辣 Extra chilli"], seat_no: 1 }],
};

const INIT = Uint8Array.of(0x1b, 0x40);
const CJK_UTF8 = new TextEncoder().encode("叻沙");

function expectFrame(bytes: Uint8Array, cut: boolean) {
  expect(startsWithBytes(bytes, INIT)).toBe(true);
  expect(endsWithBytes(bytes, SEQUENCES.partialCut)).toBe(cut);
}

// ---------------------------------------------------------------------------
// Golden files

describe("templates (golden text at both widths)", () => {
  for (const width of WIDTHS) {
    const profile = PROFILES[width];
    const cols = COLUMNS[width];
    const fitsColumns = (text: string) => {
      for (const line of text.split("\n")) expect(displayWidth(line)).toBeLessThanOrEqual(cols);
    };

    describe(width, () => {
      it("kitchen ticket", () => {
        const out = renderKitchenTicket(kitchenTicket, profile);
        expect(out.text).toMatchSnapshot();
        expectFrame(out.bytes, true);
        fitsColumns(out.text);
        for (const needle of ["P-0042", "Dine-in", "Table 12, 4 pax", "Round 2", "Server: Amy", "7:42 pm", "Job 8f3a2c1d", "S1", "* LESS SPICY PLEASE", "+ Extra chilli", "Copy 1 of 2"]) {
          expect(out.text).toContain(needle);
        }
        expect(out.text).not.toContain("VOID");
      });

      it("void ticket", () => {
        const out = renderKitchenTicket(voidTicket, profile);
        expect(out.text).toMatchSnapshot();
        expectFrame(out.bytes, true);
        fitsColumns(out.text);
        expect(out.text).toContain("VOID");
        expect(out.text).toContain("Kopi C kosong");
      });

      it("reprint ticket (delivery)", () => {
        const out = renderKitchenTicket(reprintTicket, profile);
        expect(out.text).toMatchSnapshot();
        expectFrame(out.bytes, true);
        fitsColumns(out.text);
        for (const needle of ["REPRINT", "Delivery", "Ben Tan 9123 4567", "Ready by 8:05 pm", "Deliver to:", "Notes:"]) expect(out.text).toContain(needle);
      });

      it("receipt, GST exclusive, card", () => {
        const out = renderBill(receiptExclusive, profile);
        expect(out.text).toMatchSnapshot();
        expectFrame(out.bytes, true);
        fitsColumns(out.text);
        for (const needle of [
          "Receipt",
          "Bill 2 of 3",
          "Tel 6123 4567",
          "UEN 201234567A",
          "Invoice INV-000123",
          "Member 10% off",
          "−$4.88",
          "Service charge 10%",
          "GST 9%",
          "$52.66",
          "Card A1B2",
          "share 1/3",
          "S1",
          "Thank you for dining with us",
          "https://r.sail.example/8f3a2c1d",
        ]) {
          expect(out.text).toContain(needle);
        }
        expect(out.text).not.toContain("(included)");
        expect(out.text).not.toContain("Cash rounding");
      });

      it("receipt, GST inclusive, cash with rounding and change", () => {
        const out = renderBill(receiptInclusiveCash, profile);
        expect(out.text).toMatchSnapshot();
        expectFrame(out.bytes, true);
        fitsColumns(out.text);
        for (const needle of ["GST 9% (included)", "Cash rounding", "$0.02", "Change", "$6.30", "$53.70"]) expect(out.text).toContain(needle);
      });

      it("pre-bill", () => {
        const out = renderBill(prebill, profile);
        expect(out.text).toMatchSnapshot();
        expectFrame(out.bytes, true);
        fitsColumns(out.text);
        expect(out.text).toContain("Pre-bill");
        expect(out.text).toContain("Balance due");
        expect(out.text).not.toContain("Change");
      });

      it("refund receipt", () => {
        const out = renderBill(refundReceipt, profile);
        expect(out.text).toMatchSnapshot();
        expectFrame(out.bytes, true);
        fitsColumns(out.text);
        for (const needle of ["Refund receipt", "Refund of bill P-0041/1", "Bill date 3 Nov 2026", "Credit note CN-000045", "Reason: Late dish", "−$19.18", "Refund total", "Card R-77"]) {
          expect(out.text).toContain(needle);
        }
      });

      it("service slip", () => {
        const out = renderServiceSlip(serviceSlip, profile);
        expect(out.text).toMatchSnapshot();
        expectFrame(out.bytes, true);
        fitsColumns(out.text);
        for (const needle of ["Service request", "Call for bill", "Table 12", "Guest: Ben", "P-0042", "Job 5e7v1ce1"]) expect(out.text).toContain(needle);
      });
    });
  }

  it("omits the cut sequence when the profile says so, and beeps before cutting when asked", () => {
    const noCut = renderServiceSlip(serviceSlip, { width: "80mm", code_page_cjk: false, cut: false });
    expectFrame(noCut.bytes, false);
    const beep = renderServiceSlip(serviceSlip, { width: "80mm", code_page_cjk: false, cut: true, beep: true });
    expectFrame(beep.bytes, true);
    expect(containsBytes(beep.bytes, Uint8Array.of(0x1b, 0x42))).toBe(true);
    expect(containsBytes(noCut.bytes, Uint8Array.of(0x1b, 0x42))).toBe(false);
  });

  it("renderPrintJob dispatches on the template name", () => {
    const profile = PROFILES["80mm"];
    expect(renderPrintJob({ template: "kitchen_ticket", data: kitchenTicket }, profile).text).toBe(renderKitchenTicket(kitchenTicket, profile).text);
    expect(renderPrintJob({ template: "bill", data: prebill }, profile).text).toBe(renderBill(prebill, profile).text);
    expect(renderPrintJob({ template: "service_slip", data: serviceSlip }, profile).text).toBe(renderServiceSlip(serviceSlip, profile).text);
  });

  it("is deterministic", () => {
    const a = renderBill(receiptExclusive, PROFILES["80mm"]);
    const b = renderBill(receiptExclusive, PROFILES["80mm"]);
    expect(a.text).toBe(b.text);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });

  it("uses the true minus sign in text and hyphen-minus on the wire", () => {
    const out = renderBill(refundReceipt, PROFILES["80mm"]);
    expect(out.text).toContain("−$19.18");
    expect(containsBytes(out.bytes, new TextEncoder().encode("-$19.18"))).toBe(true);
    expect(containsBytes(out.bytes, new TextEncoder().encode("−"))).toBe(false);
  });

  it("prints a cash tip between the rounding and the change, so the cash rows add up to what was handed over", () => {
    const out = renderBill({ ...receiptInclusiveCash, payments: [{ tender: "Cash", amount: 5368, rounding_cents: 2, tip: 500, change: 130 }] }, PROFILES["80mm"]).text;
    const at = (label: string) => out.search(new RegExp(`^${label} `, "m"));
    expect(out).toMatch(/^Tip +\$5\.00$/m);
    expect(at("Cash rounding")).toBeLessThan(at("Tip"));
    expect(at("Tip")).toBeLessThan(at("Change"));
    expect(renderBill(receiptInclusiveCash, PROFILES["80mm"]).text).not.toMatch(/^Tip /m);
  });

  it("labels each tax row with its component name and formats money in the document's currency and locale", () => {
    const vat: BillDocument = {
      ...receiptInclusiveCash,
      header: { ...dineInHeader, time_zone: "Europe/Berlin", locale: "de-DE" },
      currency: "EUR",
      adjustments: [],
      totals: { subtotal: 4880, discount_total: 0, fee_total: 0, tax_total: 643, total: 4880, tax_mode: "inclusive", taxes: [{ name: "VAT 19%", bps: 1900, amount: 543 }, { name: "VAT 7%", bps: 700, amount: 100 }] },
      payments: [{ tender: "Karte", amount: 4880 }],
      business_registration: { label: "HRB", value: "12345" },
      tax_registration: { label: "USt-IdNr.", value: "DE123456789" },
    };
    const out = renderBill(vat, PROFILES["80mm"]).text;
    expect(out).toContain("VAT 19% (included)");
    expect(out).toContain("VAT 7% (included)");
    expect(out).toContain("5,43\u00a0€");
    expect(out).toContain("48,80\u00a0€");
    expect(out).toContain("USt-IdNr. DE123456789");
    expect(out).toContain("HRB 12345");
    expect(out).not.toContain("GST");
    const sales: BillDocument = { ...vat, currency: "USD", header: { ...vat.header, locale: "en-US", time_zone: "America/New_York" }, totals: { ...vat.totals, tax_mode: "exclusive", total: 5523, taxes: [{ name: "State sales tax", bps: 400, amount: 195 }, { name: "Local sales tax", bps: 450, amount: 220 }] } };
    const us = renderBill(sales, PROFILES["58mm"]).text;
    expect(us).toMatch(/State sales tax +\$1\.95/);
    expect(us).toMatch(/Local sales tax +\$2\.20/);
  });

  it("prints a time zone other than Singapore when the header says so", () => {
    expect(formatDateTime("2026-11-04T19:42:00+08:00", "Asia/Singapore", "en-SG")).toBe("4 Nov 2026, 7:42 pm");
    expect(formatDateTime("2026-11-04T19:42:00+08:00", "Asia/Kuala_Lumpur", "en-SG")).toBe("4 Nov 2026, 7:42 pm");
    expect(formatDateTime("2026-11-04T19:42:00+08:00", "UTC", "en-SG")).toBe("4 Nov 2026, 11:42 am");
    expect(formatDateTime("2026-11-04T19:42:00+08:00", "Europe/Berlin", "de-DE")).toBe("4. Nov. 2026, 12:42");
    expect(formatTime("2026-11-04T19:42:00+08:00", "America/New_York", "en-US")).toBe("6:42 AM");
  });
});

// ---------------------------------------------------------------------------
// CJK fallback

describe("CJK item names", () => {
  it("rasterises lines with CJK text when the printer has no CJK code page", () => {
    let calls: string[] = [];
    const out = renderKitchenTicket(
      cjkTicket,
      { width: "80mm", code_page_cjk: false, cut: true },
      {
        renderTextAsImage: (text, widthDots, style) => {
          calls.push(text);
          expect(widthDots).toBe(576);
          return renderTextAsImageDefault(text, widthDots, style);
        },
      },
    );
    expect(out.text).toContain("叻沙 Laksa");
    expect(calls.some((c) => c.includes("叻沙 Laksa"))).toBe(true);
    expect(calls.some((c) => c.includes("加辣 Extra chilli"))).toBe(true);
    expect(calls).toHaveLength(2); // only the two CJK lines; everything else goes as text
    expect(containsBytes(out.bytes, SEQUENCES.rasterHeader)).toBe(true);
    expect(containsBytes(out.bytes, CJK_UTF8)).toBe(false);
    expect(containsBytes(out.bytes, SEQUENCES.kanjiOn)).toBe(false);
    expectFrame(out.bytes, true);

    // The default renderer is used when no hook is given, and is deterministic.
    calls = [];
    const a = renderKitchenTicket(cjkTicket, PROFILES["80mm"]);
    const b = renderKitchenTicket(cjkTicket, PROFILES["80mm"]);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    expect(containsBytes(a.bytes, SEQUENCES.rasterHeader)).toBe(true);
  });

  it("sends CJK text in Kanji mode when the printer has the code page", () => {
    const out = renderKitchenTicket(cjkTicket, { width: "80mm", code_page_cjk: true, cut: true });
    expect(out.text).toContain("叻沙 Laksa");
    expect(containsBytes(out.bytes, SEQUENCES.rasterHeader)).toBe(false);
    expect(containsBytes(out.bytes, SEQUENCES.kanjiOn)).toBe(true);
    expect(containsBytes(out.bytes, SEQUENCES.kanjiOff)).toBe(true);
    expect(containsBytes(out.bytes, CJK_UTF8)).toBe(true);
  });

  it("lets the server inject the CJK byte encoder", () => {
    const marker = Uint8Array.of(0xaa, 0xbb, 0xcc, 0xdd);
    const out = renderKitchenTicket(cjkTicket, { width: "80mm", code_page_cjk: true, cut: true }, { encodeCjk: () => marker });
    expect(containsBytes(out.bytes, marker)).toBe(true);
    expect(containsBytes(out.bytes, CJK_UTF8)).toBe(false);
  });

  it("default raster: full width, one cell row high, wide chars take two cells, ASCII glyphs are drawn", () => {
    const bmp = renderTextAsImageDefault("叻 A", 576, { align: "left", width: 1, height: 1 });
    expect(bmp.width).toBe(576);
    expect(bmp.height).toBe(24);
    expect(bmp.data.length).toBe(72 * 24);
    const art = bitmapToAscii(bmp);
    const rows = art.split("\n");
    // Placeholder box: outline pixels at x=1 and x=22 on an inner row.
    expect(rows[12]![1]).toBe("#");
    expect(rows[12]![22]).toBe("#");
    // The "A" cell starts at x = 36 (after the 24-dot placeholder and a 12-dot space); its crossbar row is inked.
    const aCell = rows.map((r) => r.slice(36, 48));
    expect(aCell.some((r) => r.includes("#"))).toBe(true);
    expect(aCell[0]).toBe("............"); // top margin is clear
    // Nothing is drawn past the text.
    expect(rows.every((r) => !r.slice(48).includes("#"))).toBe(true);

    const big = renderTextAsImageDefault("叻", 384, { align: "center", width: 2, height: 2 });
    expect(big.height).toBe(48);
    expect(big.width).toBe(384);
    // Centred: 48 dots of glyph in 384 -> starts at 168.
    expect(bitmapToAscii(big).split("\n")[24]!.indexOf("#")).toBe(168 + 2);
  });

  it("glyph table covers printable ASCII and maps the minus sign", () => {
    expect(glyph5x7(0x41)).toEqual([0x7e, 0x11, 0x11, 0x11, 0x7e]); // A
    expect(glyph5x7(0x2212)).toEqual(glyph5x7(0x2d));
    expect(glyph5x7(0x4e00)).toEqual(glyph5x7(0x3f)); // unknown -> ?
    for (let cp = 0x20; cp <= 0x7e; cp++) expect(glyph5x7(cp)).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Layout helpers

describe("layout", () => {
  it("counts CJK characters as two columns", () => {
    expect(isWideChar("叻".codePointAt(0)!)).toBe(true);
    expect(isWideChar("A".codePointAt(0)!)).toBe(false);
    expect(displayWidth("叻沙 Laksa")).toBe(10);
    expect(displayWidth("Laksa")).toBe(5);
    expect(displayWidth("")).toBe(0);
  });

  it("rules fill the width", () => {
    expect(rule(48)).toBe("-".repeat(48));
    expect(rule(32, "=")).toBe("=".repeat(32));
  });

  it("centres text at 48 and 32 columns, and by physical width for double-width lines", () => {
    expect(center("Receipt", 48)).toBe(" ".repeat(20) + "Receipt");
    expect(center("Receipt", 32)).toBe(" ".repeat(12) + "Receipt");
    expect(center("VOID", 48, 2)).toBe(" ".repeat(20) + "VOID");
    expect(center("VOID", 32, 2)).toBe(" ".repeat(12) + "VOID");
    expect(center("A very long banner that cannot fit", 32, 2)).toBe("A very long bann");
  });

  it("wraps words, indents continuation lines and hard-breaks long tokens", () => {
    expect(wrap("Hainanese chicken rice set with extra steamed chicken and achar", 32, { indent: 3 })).toEqual([
      "Hainanese chicken rice set with",
      "   extra steamed chicken and",
      "   achar",
    ]);
    expect(wrap("abcdefghijklmnopqrstuvwxyz0123456789", 10)).toEqual(["abcdefghij", "klmnopqrst", "uvwxyz0123", "456789"]);
    expect(wrap("叻沙叻沙叻沙", 7)).toEqual(["叻沙叻", "沙叻沙"]);
    expect(wrap("", 10)).toEqual([""]);
    expect(wrap("line one\nline two", 20)).toEqual(["line one", "line two"]);
  });

  it("justifies a label and a value on one line, wrapping long labels", () => {
    expect(justify("Subtotal", "$34.80", 48)).toEqual(["Subtotal" + " ".repeat(34) + "$34.80"]);
    expect(justify("Subtotal", "$34.80", 32)).toEqual(["Subtotal" + " ".repeat(18) + "$34.80"]);
    const long = justify("Hainanese chicken rice set with extra steamed chicken", "$192.00", 32);
    expect(long).toEqual(["Hainanese chicken rice", "   set with extra", "   steamed chicken       $192.00"]);
    for (const l of long) expect(displayWidth(l)).toBeLessThanOrEqual(32);
    // A value wider than the line goes on its own line.
    expect(justify("Total", "$" + "9".repeat(24), 32)).toEqual(["Total", " ".repeat(7) + "$" + "9".repeat(24)]);
  });

  it("puts two short texts on one line and falls back to two when they collide", () => {
    expect(columns("P-0042", "Dine-in", 48)).toEqual(["P-0042" + " ".repeat(35) + "Dine-in"]);
    expect(columns("4 Nov 2026, 7:42 pm", "Job 8f3a2c1d-very-long-identifier", 32)).toEqual([
      "4 Nov 2026, 7:42 pm",
      "Job".padStart(32),
      "8f3a2c1d-very-long-identifier".padStart(32),
    ]);
    expect(columns("4 Nov 2026, 7:42 pm", "Job 8f3a2c1d", 32)).toEqual(["4 Nov 2026, 7:42 pm Job 8f3a2c1d"]);
    expect(columns("only left", "", 48)).toEqual(["only left"]);
  });

  it("money rows use the given currency and locale and the true minus sign", () => {
    const sgd = { currency: "SGD", locale: "en-SG" };
    expect(moneyRow("Member 10% off", -488, 48, sgd)).toEqual(["Member 10% off" + " ".repeat(28) + "−$4.88"]);
    expect(moneyRow("Total", 123456789, 32, sgd)).toEqual(["Total" + " ".repeat(14) + "$1,234,567.89"]);
    // The full-width yen sign takes two columns.
    expect(moneyRow("Total", 1600, 32, { currency: "JPY", locale: "ja-JP" })).toEqual(["Total" + " ".repeat(20) + "￥1,600"]);
  });

  it("item, modifier and note lines", () => {
    expect(qtyColumn(2)).toBe("2  ");
    expect(qtyColumn(12)).toBe("12 ");
    expect(itemLine(2, "Laksa", 48, "$32.00")).toEqual(["2  Laksa" + " ".repeat(34) + "$32.00"]);
    expect(itemLine(1, "Kopi C", 32)).toEqual(["1  Kopi C"]);
    expect(itemLine(12, "Hainanese chicken rice set with extra steamed chicken and achar", 32, "S1")).toEqual([
      "12 Hainanese chicken rice set",
      "   with extra steamed chicken",
      "   and achar                  S1",
    ]);
    expect(modifierLine("Extra chilli", 48)).toEqual(["   + Extra chilli"]);
    expect(modifierLine("Extra chilli", 48, { price: 100, fmt: { currency: "SGD", locale: "en-SG" } })).toEqual(["   + Extra chilli" + " ".repeat(26) + "$1.00"]);
    expect(noteLine("less spicy please", 48)).toEqual(["   * LESS SPICY PLEASE"]);
    expect(noteLine("a very long note that needs to wrap on narrow paper", 32)).toEqual([
      "   * A VERY LONG NOTE THAT NEEDS",
      "     TO WRAP ON NARROW PAPER",
    ]);
  });

  it("documentToText applies alignment by padding and skips feeds", () => {
    const text = documentToText(
      [
        { kind: "text", text: "Left" },
        { kind: "text", text: "Mid", align: "center" },
        { kind: "text", text: "End", align: "right" },
        { kind: "feed", lines: 3 },
      ],
      32,
    );
    expect(text).toBe("Left\n" + " ".repeat(14) + "Mid\n" + " ".repeat(29) + "End\n");
  });
});

// ---------------------------------------------------------------------------
// Encoder

describe("encoder", () => {
  it("init selects the code page", () => {
    expect([...new EscPosEncoder().init().toBytes()]).toEqual([0x1b, 0x40, 0x1b, 0x74, 16]);
    expect([...new EscPosEncoder({ codePage: 0 }).init().toBytes()]).toEqual([0x1b, 0x40, 0x1b, 0x74, 0]);
  });

  it("emits the documented command bytes", () => {
    expect([...new EscPosEncoder().bold(true).bold(false).toBytes()]).toEqual([0x1b, 0x45, 1, 0x1b, 0x45, 0]);
    expect([...new EscPosEncoder().size(1, 1).size(2, 1).size(1, 2).size(2, 2).toBytes()]).toEqual([
      0x1d, 0x21, 0x00, 0x1d, 0x21, 0x10, 0x1d, 0x21, 0x01, 0x1d, 0x21, 0x11,
    ]);
    expect([...new EscPosEncoder().align("left").align("center").align("right").toBytes()]).toEqual([0x1b, 0x61, 0, 0x1b, 0x61, 1, 0x1b, 0x61, 2]);
    expect([...new EscPosEncoder().feed(3).toBytes()]).toEqual([0x1b, 0x64, 3]);
    expect([...new EscPosEncoder().cut().toBytes()]).toEqual([0x1d, 0x56, 66, 0]);
    expect([...new EscPosEncoder().beep().toBytes()]).toEqual([0x1b, 0x42, 2, 2]);
    expect([...new EscPosEncoder().beep(99, 0).toBytes()]).toEqual([0x1b, 0x42, 9, 1]);
    expect([...new EscPosEncoder().line("Hi").toBytes()]).toEqual([0x48, 0x69, 0x0a]);
  });

  it("status request constants are DLE EOT n", () => {
    expect([...DLE_EOT_STATUS.printer]).toEqual([0x10, 0x04, 1]);
    expect([...DLE_EOT_STATUS.offline]).toEqual([0x10, 0x04, 2]);
    expect([...DLE_EOT_STATUS.error]).toEqual([0x10, 0x04, 3]);
    expect([...DLE_EOT_STATUS.paper]).toEqual([0x10, 0x04, 4]);
  });

  it("raster header carries bytes per row and height little-endian, then the bitmap", () => {
    const bmp = { width: 576, height: 300, data: new Uint8Array(72 * 300) };
    const bytes = new EscPosEncoder().raster(bmp).toBytes();
    expect([...bytes.subarray(0, 8)]).toEqual([0x1d, 0x76, 0x30, 0, 72, 0, 300 & 0xff, 300 >> 8]);
    expect(bytes.length).toBe(8 + 72 * 300);
    expect(() => new EscPosEncoder().raster({ width: 8, height: 2, data: new Uint8Array(1) })).toThrow(RangeError);
  });

  it("single-byte text: ASCII and Latin-1 pass, the minus sign becomes a hyphen, CJK is refused", () => {
    expect(canEncodeSingleByte("Kopi C $1.80")).toBe(true);
    expect(canEncodeSingleByte("café −$1.60")).toBe(true);
    expect([...encodeSingleByte("−$1")]).toEqual([0x2d, 0x24, 0x31]);
    expect([...encodeSingleByte("é")]).toEqual([0xe9]);
    expect(canEncodeSingleByte("叻沙")).toBe(false);
    expect(() => new EscPosEncoder().text("叻沙")).toThrow(RangeError);
    const cjk = new EscPosEncoder({ cjk: true }).text("叻沙").toBytes();
    expect([...cjk]).toEqual([0x1c, 0x26, ...CJK_UTF8, 0x1c, 0x2e]);
  });
});

// ---------------------------------------------------------------------------
// Schemas

describe("schemas", () => {
  it("accept the fixtures", () => {
    expect(KitchenTicketSchema.parse(kitchenTicket)).toEqual(kitchenTicket);
    expect(BillDocumentSchema.safeParse(receiptExclusive).success).toBe(true);
    expect(BillDocumentSchema.safeParse(refundReceipt).success).toBe(true);
    expect(ServiceSlipSchema.safeParse(serviceSlip).success).toBe(true);
    expect(PrintJobPayloadSchema.safeParse({ template: "bill", data: prebill }).success).toBe(true);
    expect(PrinterProfileSchema.safeParse({ width: "58mm", code_page_cjk: true, cut: false }).success).toBe(true);
  });

  it("reject bad data", () => {
    expect(PrinterProfileSchema.safeParse({ width: "76mm", code_page_cjk: false, cut: true }).success).toBe(false);
    expect(KitchenTicketSchema.safeParse({ ...kitchenTicket, header: { ...dineInHeader, printed_at: "yesterday" } }).success).toBe(false);
    expect(KitchenTicketSchema.safeParse({ ...kitchenTicket, lines: [] }).success).toBe(false);
    expect(BillDocumentSchema.safeParse({ ...receiptExclusive, totals: { ...receiptExclusive.totals, total: 52.66 } }).success).toBe(false);
    expect(PrintJobPayloadSchema.safeParse({ template: "label", data: {} }).success).toBe(false);
  });

  it("buildBillDocument keeps every line within the column width", () => {
    for (const width of WIDTHS) {
      const cols = COLUMNS[width];
      const doc = buildBillDocument(receiptExclusive, cols);
      for (const line of doc) if (line.kind === "text" && (line.align ?? "left") === "left") expect(displayWidth(line.text)).toBeLessThanOrEqual(cols);
    }
  });
});
