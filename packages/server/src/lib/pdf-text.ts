import fontkit from "@pdf-lib/fontkit";
import type { PDFDocument, PDFFont } from "pdf-lib";
import { formatMoney, type MoneyFormat } from "@sail/shared";
import { INSTRUMENT_SANS_REGULAR, INSTRUMENT_SANS_SEMIBOLD } from "./pdf-fonts.generated.js";

/**
 * PDFs embed the product's own typeface, Instrument Sans (SIL OFL 1.1, assets/fonts), subset to the glyphs each
 * document uses, so every viewer draws the same glyphs at the advances the columns were measured with: no viewer's
 * stand-in font can push the euro sign into the first digit (review 3, R3). Scripts the font does not cover (Arabic,
 * CJK) print as "?" for now; amounts fall back to the currency's ISO code instead.
 */
const REGULAR = Buffer.from(INSTRUMENT_SANS_REGULAR, "base64");
const SEMIBOLD = Buffer.from(INSTRUMENT_SANS_SEMIBOLD, "base64");
const coverage = fontkit.create(REGULAR) as unknown as { hasGlyphForCodePoint(cp: number): boolean };

/** Text the embedded font can draw: look-alikes for the few characters it lacks, bidi marks dropped, else "?". */
export function pdfText(s: string): string {
  let out = "";
  for (const ch of s.replace(/[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/g, "").replace(/[\u2009\u202f]/g, "\u00a0").replace(/\uffe5/g, "\u00a5")) {
    const cp = ch.codePointAt(0)!;
    out += cp === 0x0a || coverage.hasGlyphForCodePoint(cp) ? ch : "?";
  }
  return out;
}

export type PdfFonts = { font: PDFFont; bold: PDFFont };

/** Embed the regular and semibold faces, subset; fixed names keep a document's bytes the same on every render. */
export async function embedPdfFonts(pdf: PDFDocument): Promise<PdfFonts> {
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(REGULAR, { subset: true, customName: "SAILAA+InstrumentSans-Regular" });
  const bold = await pdf.embedFont(SEMIBOLD, { subset: true, customName: "SAILAB+InstrumentSans-SemiBold" });
  return { font, bold };
}

/** The locale with Latin digits, so amounts and dates on a PDF are readable whatever the locale's own digits are. */
export function latinDigits(locale: string): string {
  return new Intl.Locale(locale, { numberingSystem: "latn" }).toString();
}

/** Amounts as a PDF can draw them: Latin digits, and the currency's ISO code where the font has no symbol for it ("KWD 2.125"). */
export function pdfMoney(money: MoneyFormat): (amount: number) => string {
  const fmt = { currency: money.currency, locale: latinDigits(money.locale) };
  return (amount) => {
    const s = pdfText(formatMoney(amount, fmt));
    return s.includes("?") ? pdfText(formatMoney(amount, fmt, { currencyDisplay: "code" })) : s;
  };
}

/** A date and time as a PDF can draw it: the locale's own style with Latin digits, else "2026-01-01 00:00" in the zone. */
export function pdfDateTime(iso: string, locale: string, timeZone: string): string {
  const d = new Date(iso);
  const s = pdfText(d.toLocaleString(latinDigits(locale), { timeZone, dateStyle: "medium", timeStyle: "short" }));
  if (!s.includes("?")) return s;
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** Save a PDF: the embedded fonts are subset and written with their own widths. */
export async function savePdf(pdf: PDFDocument): Promise<Uint8Array> {
  return pdf.save({ useObjectStreams: false });
}
