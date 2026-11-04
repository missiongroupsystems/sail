import { formatCents, type Cents } from "../money.js";
import type { Align, SizeMultiplier } from "./encoder.js";
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
 * Word-wrap `text` into lines no wider than `width`. Continuation lines are
 * indented by `indent` columns; words longer than a line are broken hard,
 * which is also how unspaced CJK runs wrap.
 */
export function wrap(text: string, width: number, opts: { indent?: number } = {}): string[] {
  const indent = opts.indent ?? 0;
  if (width <= 0) return [text];
  const lines: string[] = [];
  const paragraphs = text.split(/\r?\n/);
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter((w) => w.length > 0);
    let current = "";
    let currentWidth = 0;
    let avail = width;
    const flush = () => {
      lines.push((lines.length === 0 ? "" : " ".repeat(indent)) + current);
      current = "";
      currentWidth = 0;
      avail = Math.max(1, width - indent);
    };
    if (lines.length > 0) avail = Math.max(1, width - indent);
    for (let word of words) {
      // Hard-break words that cannot fit on a line of their own.
      while (displayWidth(word) > avail) {
        if (current.length > 0) flush();
        let head = fit(word, avail);
        if (head.length === 0) head = String.fromCodePoint(word.codePointAt(0)!); // a wide char in a 1-column gap
        current = head;
        currentWidth = displayWidth(head);
        word = word.slice(head.length);
        flush();
      }
      const ww = displayWidth(word);
      if (current.length === 0) {
        current = word;
        currentWidth = ww;
      } else if (currentWidth + 1 + ww <= avail) {
        current += " " + word;
        currentWidth += 1 + ww;
      } else {
        flush();
        current = word;
        currentWidth = ww;
      }
    }
    if (current.length > 0 || words.length === 0) flush();
  }
  return lines;
}

/**
 * A left-justified label with a right-justified value on the same line,
 * `Laksa                    $16.00`. Long labels wrap (indented on
 * continuation lines) and the value sits on the last line. If even the last
 * line cannot hold the value, it goes on its own right-aligned line.
 */
export function justify(left: string, rightText: string, cols: number, opts: { indent?: number } = {}): string[] {
  const indent = opts.indent ?? ITEM_INDENT;
  const rw = displayWidth(rightText);
  if (rw >= cols) return [...wrap(left, cols, { indent }), right(rightText, cols)];
  const labelWidth = cols - rw - 1;
  const lines = wrap(left, Math.max(1, labelWidth), { indent });
  const last = lines.pop() ?? "";
  if (displayWidth(last) + 1 + rw <= cols) {
    lines.push(padRight(last, cols - rw) + rightText);
  } else {
    lines.push(last, right(rightText, cols));
  }
  return lines;
}

/**
 * Two short texts on one line, left and right (`P-0042             Dine-in`).
 * Falls back to two lines when they would collide.
 */
export function columns(left: string, rightText: string, cols: number): string[] {
  if (rightText.length === 0) return wrap(left, cols);
  if (left.length === 0) return [right(rightText, cols)];
  if (displayWidth(left) + 1 + displayWidth(rightText) <= cols) {
    return [padRight(left, cols - displayWidth(rightText)) + rightText];
  }
  return [...wrap(left, cols), right(rightText, cols)];
}

/** Money text for receipts: en-SG, true minus sign for negatives. */
export function money(cents: Cents): string {
  return formatCents(cents);
}

/** `Subtotal                                $34.80`. */
export function moneyRow(label: string, cents: Cents, cols: number, opts: { indent?: number } = {}): string[] {
  return justify(label, money(cents), cols, opts);
}

/** Percent label from basis points: 900 -> "9%", 850 -> "8.5%". */
export function percentLabel(bps: number): string {
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct.toFixed(0) : String(pct)}%`;
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
  const label = qtyColumn(quantity) + name;
  if (rightText.length === 0) return wrap(label, cols, { indent: ITEM_INDENT });
  return justify(label, rightText, cols, { indent: ITEM_INDENT });
}

/** Modifier under an item: `   + Extra chilli`, with a price on the right when non-zero. */
export function modifierLine(name: string, cols: number, price?: Cents): string[] {
  const label = " ".repeat(ITEM_INDENT) + "+ " + name;
  if (price === undefined || price === 0) return wrap(label, cols, { indent: ITEM_INDENT + 2 });
  return justify(label, money(price), cols, { indent: ITEM_INDENT + 2 });
}

/** Note under an item, upper-cased after a star: `   * LESS SPICY`. */
export function noteLine(note: string, cols: number): string[] {
  return wrap(" ".repeat(ITEM_INDENT) + "* " + note.toUpperCase(), cols, { indent: ITEM_INDENT + 2 });
}

/** Any detail under an item, indented one level. */
export function detailLine(text: string, cols: number): string[] {
  return wrap(" ".repeat(ITEM_INDENT) + text, cols, { indent: ITEM_INDENT });
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
