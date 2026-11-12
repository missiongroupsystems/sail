import { formatMoney, type Cents, type MoneyFormat } from "../money.js";
import { canEncodeSingleByte, type Align, type SizeMultiplier } from "./encoder.js";
import type { PaperWidth } from "./types.js";

/**
 * Pure text layout for receipt paper. Everything here works in character
 * columns at the printer's normal font: 48 columns on 80 mm paper, 32 on
 * 58 mm. Wide (CJK) characters count as two columns, as they do on the
 * printer. No control bytes, no printer knowledge; the same functions drive
 * the plain-text preview and the byte stream.
 */

export const COLUMNS: Record<PaperWidth, number> = { "80mm": 48, "58mm": 32 };
/** Printable dots per line at 203 dpi, used for raster lines. 12 dots per column. */
export const DOTS_PER_LINE: Record<PaperWidth, number> = { "80mm": 576, "58mm": 384 };

/** Indent for modifiers, notes and seat chips under an item line. */
export const ITEM_INDENT = 3;
/** Narrowest label a value may share a line with before the value drops to its own line. */
const MIN_LABEL_WIDTH = 8;

// ---------------------------------------------------------------------------
// Width-aware string primitives

/** True for characters that occupy two columns on a thermal printer (CJK, fullwidth forms). */
export function isWideChar(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** True when any character needs a CJK code page. */
export function hasWideChars(text: string): boolean {
  for (const ch of text) if (isWideChar(ch.codePointAt(0)!)) return true;
  return false;
}

/** Display width in columns (wide characters count 2). */
export function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += isWideChar(ch.codePointAt(0)!) ? 2 : 1;
  return w;
}

export function padRight(text: string, width: number): string {
  const w = displayWidth(text);
  return w >= width ? text : text + " ".repeat(width - w);
}

export function padLeft(text: string, width: number): string {
  const w = displayWidth(text);
  return w >= width ? text : " ".repeat(width - w) + text;
}

/** Cut `text` so that it fits in `width` columns (no ellipsis; receipts have no room for one). */
export function fit(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  let out = "";
  let w = 0;
  for (const ch of text) {
    const cw = isWideChar(ch.codePointAt(0)!) ? 2 : 1;
    if (w + cw > width) break;
    out += ch;
    w += cw;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lines

export function rule(cols: number, ch = "-"): string {
  return ch.repeat(Math.max(0, Math.floor(cols / displayWidth(ch))));
}

/** Centre `text` in `cols` columns; `charWidth` is 2 for double-width lines. Trailing spaces are not added. */
export function center(text: string, cols: number, charWidth: SizeMultiplier = 1): string {
  const t = fit(text, Math.floor(cols / charWidth));
  const pad = Math.max(0, Math.floor((cols - displayWidth(t) * charWidth) / 2));
  return " ".repeat(pad) + t;
}

/** Right-align `text` in `cols` columns. */
export function right(text: string, cols: number, charWidth: SizeMultiplier = 1): string {
  const t = fit(text, Math.floor(cols / charWidth));
  return " ".repeat(Math.max(0, cols - displayWidth(t) * charWidth)) + t;
}

/**
 * Word-wrap `text` into unprefixed lines: the first no wider than
 * `firstWidth`, the rest no wider than `restWidth`. Whitespace is normalised
 * (callers add prefixes and indents afterwards). Words longer than a line are
 * broken hard, which is also how unspaced CJK runs wrap. Newlines in the text
 * force a break.
 */
export function wrapWidths(text: string, firstWidth: number, restWidth: number): string[] {
  const lines: string[] = [];
  const widthFor = () => Math.max(1, lines.length === 0 ? firstWidth : restWidth);
  for (const paragraph of text.split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter((w) => w.length > 0);
    let current = "";
    let currentWidth = 0;
    const flush = () => {
      lines.push(current);
      current = "";
      currentWidth = 0;
    };
    for (let word of words) {
      while (word.length > 0) {
        const avail = widthFor();
        const ww = displayWidth(word);
        if (current.length === 0) {
          if (ww <= avail) {
            current = word;
            currentWidth = ww;
            word = "";
          } else {
            // Hard-break a word that cannot fit on a line of its own.
            let head = fit(word, avail);
            if (head.length === 0) head = String.fromCodePoint(word.codePointAt(0)!); // a wide char in a 1-column gap
            lines.push(head);
            word = word.slice(head.length);
          }
        } else if (currentWidth + 1 + ww <= avail) {
          current += " " + word;
          currentWidth += 1 + ww;
          word = "";
        } else {
          flush(); // the word starts the next line
        }
      }
    }
    if (current.length > 0 || words.length === 0) flush();
  }
  return lines;
}

/**
 * Word-wrap `text` into lines no wider than `width`, indenting continuation
 * lines by `indent` columns.
 */
export function wrap(text: string, width: number, opts: { indent?: number } = {}): string[] {
  const indent = opts.indent ?? 0;
  return wrapWidths(text, width, width - indent).map((l, i) => (i === 0 ? l : " ".repeat(indent) + l));
}

/**
 * The general receipt block: a `body` wrapped under a first-line prefix (the
 * quantity column, `+ `, `* `) with continuation lines under `contPrefix`,
 * and an optional right-hand value (`$16.00`, a seat chip) on the last line.
 * The value column is kept clear on every line so amounts line up.
 */
export function block(firstPrefix: string, contPrefix: string, body: string, cols: number, rightText = ""): string[] {
  const fw = displayWidth(firstPrefix);
  const cw = displayWidth(contPrefix);
  const rw = displayWidth(rightText);
  const reserve = rightText.length > 0 ? rw + 1 : 0;
  const firstAvail = cols - fw - reserve;
  const restAvail = cols - cw - reserve;
  if (rightText.length > 0 && (firstAvail < MIN_LABEL_WIDTH || restAvail < MIN_LABEL_WIDTH)) {
    // The value is too wide to share a line with a readable label: give it its own.
    return [...block(firstPrefix, contPrefix, body, cols), right(rightText, cols)];
  }
  const lines = wrapWidths(body, firstAvail, restAvail).map((l, i) => (i === 0 ? firstPrefix : contPrefix) + l);
  if (rightText.length === 0) return lines;
  const last = lines.pop() ?? "";
  lines.push(padRight(last, cols - rw) + rightText);
  return lines;
}

/**
 * A left-justified label with a right-justified value on the same line,
 * `Soup                     $16.00`. Long labels wrap (indented on
 * continuation lines) and the value sits on the last line.
 */
export function justify(left: string, rightText: string, cols: number, opts: { indent?: number } = {}): string[] {
  return block("", " ".repeat(opts.indent ?? ITEM_INDENT), left, cols, rightText);
}

/**
 * Two short texts on one line, left and right (`P-0042             Dine-in`).
 * Falls back to separate lines when they would collide.
 */
export function columns(left: string, rightText: string, cols: number): string[] {
  if (rightText.length === 0) return wrap(left, cols);
  if (left.length === 0) return wrap(rightText, cols).map((l) => right(l, cols));
  if (displayWidth(left) + 1 + displayWidth(rightText) <= cols) {
    return [padRight(left, cols - displayWidth(rightText)) + rightText];
  }
  return [...wrap(left, cols), ...wrap(rightText, cols).map((l) => right(l, cols))];
}

/**
 * Money text for receipts in the merchant's currency and locale, true minus sign for negatives, always in Latin digits
 * and in characters the printer's code page carries: a symbol outside it (₹, ฿, د.ك.) gives way to the ISO code
 * ("2.125 KWD"), as on the PDFs, so an amount never goes out as a raster image or in Kanji mode.
 */
export function money(cents: Cents, fmt: MoneyFormat): string {
  const latin = { currency: fmt.currency, locale: new Intl.Locale(fmt.locale, { numberingSystem: "latn" }).toString() };
  const plain = (s: string) => s.replace(/[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/g, "").replace(/[\u2009\u202f]/g, " ").replace(/\uffe5/g, "¥").trim();
  const s = plain(formatMoney(cents, latin));
  return canEncodeSingleByte(s) ? s : plain(formatMoney(cents, latin, { currencyDisplay: "code" }));
}

/** `Subtotal                                $34.80`. */
export function moneyRow(label: string, cents: Cents, cols: number, fmt: MoneyFormat, opts: { indent?: number } = {}): string[] {
  return justify(label, money(cents, fmt), cols, opts);
}

/** Seat chip, `S1`. */
export function seatChip(seatNo: number): string {
  return `S${seatNo}`;
}

/** Quantity column: `2  `, `12 `, `120`. Always ITEM_INDENT wide so names line up. */
export function qtyColumn(quantity: number): string {
  return padRight(String(quantity), ITEM_INDENT);
}

/**
 * Item line: quantity, name (wrapped and indented under itself) and an
 * optional right-hand value (an amount on bills, a seat chip on kitchen tickets).
 */
export function itemLine(quantity: number, name: string, cols: number, rightText = ""): string[] {
  return block(qtyColumn(quantity), " ".repeat(ITEM_INDENT), name, cols, rightText);
}

const INDENT = " ".repeat(ITEM_INDENT);
const INDENT_UNDER_MARKER = " ".repeat(ITEM_INDENT + 2);

/** Modifier under an item: `   + Extra chilli`, with a price on the right when non-zero. */
export function modifierLine(name: string, cols: number, priced?: { price: Cents; fmt: MoneyFormat }): string[] {
  return block(INDENT + "+ ", INDENT_UNDER_MARKER, name, cols, priced === undefined || priced.price === 0 ? "" : money(priced.price, priced.fmt));
}

/** Note under an item, upper-cased after a star: `   * LESS SPICY`. */
export function noteLine(note: string, cols: number): string[] {
  return block(INDENT + "* ", INDENT_UNDER_MARKER, note.toUpperCase(), cols);
}

/** Any detail under an item, indented one level. */
export function detailLine(text: string, cols: number): string[] {
  return block(INDENT, INDENT, text, cols);
}

// ---------------------------------------------------------------------------
// Styled document model shared by the text preview and the byte stream

export interface TextLine {
  kind: "text";
  text: string;
  align?: Align;
  bold?: boolean;
  width?: SizeMultiplier;
  height?: SizeMultiplier;
}
export interface FeedLine {
  kind: "feed";
  lines: number;
}
export type DocLine = TextLine | FeedLine;

export function text(text: string, style: Omit<TextLine, "kind" | "text"> = {}): TextLine {
  return { kind: "text", text, ...style };
}
export function feed(lines = 1): FeedLine {
  return { kind: "feed", lines };
}

/** Large (double height) line, used for item names and references on kitchen tickets. */
export function large(textValue: string, style: Omit<TextLine, "kind" | "text" | "height"> = {}): TextLine {
  return text(textValue, { height: 2, ...style });
}

/**
 * Kitchen item block: a large item line with the seat chip on the right,
 * modifiers indented one level, then notes in upper case after a star.
 */
export function kitchenItemBlock(
  line: { quantity: number; name: string; modifiers: readonly string[]; notes?: string; seat_no?: number },
  cols: number,
): DocLine[] {
  const out: DocLine[] = [];
  const chip = line.seat_no !== undefined ? seatChip(line.seat_no) : "";
  for (const t of itemLine(line.quantity, line.name, cols, chip)) out.push(large(t, { bold: true }));
  for (const m of line.modifiers) for (const t of modifierLine(m, cols)) out.push(text(t));
  if (line.notes && line.notes.trim().length > 0) for (const t of noteLine(line.notes.trim(), cols)) out.push(text(t, { bold: true }));
  return out;
}

/**
 * Plain-text rendering of a document: the same layout as the printer, with
 * alignment applied by padding and without control bytes. Double-width lines
 * are positioned by their physical width so the preview shows where they start.
 */
export function documentToText(doc: readonly DocLine[], cols: number): string {
  const out: string[] = [];
  for (const line of doc) {
    if (line.kind === "feed") continue;
    const cw = line.width ?? 1;
    const align = line.align ?? "left";
    if (align === "center") out.push(center(line.text, cols, cw));
    else if (align === "right") out.push(right(line.text, cols, cw));
    else out.push(line.text);
  }
  return out.map((l) => l.replace(/\s+$/, "")).join("\n") + "\n";
}
