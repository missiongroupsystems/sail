import type { Align, Bitmap, SizeMultiplier } from "./encoder.js";
import { displayWidth, isWideChar } from "./layout.js";

/**
 * Raster fallback for text the printer's code page cannot carry.
 *
 * A real font rasteriser is out of scope for v0.9. The default renderer here
 * is deterministic and documented so that golden tests are stable and the
 * printed result is at least legible:
 *
 * - Every character occupies a cell the size of the printer's normal font:
 *   12 x 24 dots, doubled horizontally or vertically for large lines. Wide
 *   (CJK) characters take two cells, matching the column maths in layout.ts.
 * - Printable ASCII is drawn from a built-in 5 x 7 monospace glyph set scaled
 *   x2 and centred in its cell, so Latin text on a mixed line stays readable.
 * - CJK and other unknown characters are drawn as a placeholder: a boxed
 *   24 x 24 cell with a 4 x 4 grid of blocks whose pattern is derived from the
 *   code point, so different characters print differently and the same
 *   character always prints the same.
 *
 * The server can inject a real renderer through `RenderOptions.renderTextAsImage`
 * (templates.ts); it receives the same arguments and returns a Bitmap.
 */

export const CELL_WIDTH_DOTS = 12;
export const CELL_HEIGHT_DOTS = 24;

export type TextImageStyle = { align: Align; width: SizeMultiplier; height: SizeMultiplier };
export type RenderTextAsImage = (text: string, widthDots: number, style: TextImageStyle) => Bitmap;

export function createBitmap(width: number, height: number): Bitmap {
  return { width, height, data: new Uint8Array(Math.ceil(width / 8) * height) };
}

export function setPixel(bitmap: Bitmap, x: number, y: number): void {
  if (x < 0 || y < 0 || x >= bitmap.width || y >= bitmap.height) return;
  const bytesPerRow = Math.ceil(bitmap.width / 8);
  bitmap.data[y * bytesPerRow + (x >> 3)]! |= 0x80 >> (x & 7);
}

export function getPixel(bitmap: Bitmap, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= bitmap.width || y >= bitmap.height) return false;
  const bytesPerRow = Math.ceil(bitmap.width / 8);
  return (bitmap.data[y * bytesPerRow + (x >> 3)]! & (0x80 >> (x & 7))) !== 0;
}

function fillRect(bitmap: Bitmap, x: number, y: number, w: number, h: number): void {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) setPixel(bitmap, xx, yy);
}

/**
 * Classic 5 x 7 glyphs for U+0020..U+007E, column-major: five bytes per glyph,
 * bit 0 of each byte is the top row. Public-domain table used by many LCD drivers.
 */
const FONT_5X7 =
  "0000000000" + // space
  "00005f0000" + // !
  "0007000700" + // "
  "147f147f14" + // #
  "242a7f2a12" + // $
  "2313086462" + // %
  "3649552250" + // &
  "0005030000" + // '
  "001c224100" + // (
  "0041221c00" + // )
  "14083e0814" + // *
  "08083e0808" + // +
  "0050300000" + // ,
  "0808080808" + // -
  "0060600000" + // .
  "2010080402" + // /
  "3e5149453e" + // 0
  "00427f4000" + // 1
  "4261514946" + // 2
  "2141454b31" + // 3
  "1814127f10" + // 4
  "2745454539" + // 5
  "3c4a494930" + // 6
  "0171090503" + // 7
  "3649494936" + // 8
  "064949291e" + // 9
  "0036360000" + // :
  "0056360000" + // ;
  "0814224100" + // <
  "1414141414" + // =
  "0041221408" + // >
  "0201510906" + // ?
  "324979413e" + // @
  "7e1111117e" + // A
  "7f49494936" + // B
  "3e41414122" + // C
  "7f4141221c" + // D
  "7f49494941" + // E
  "7f09090901" + // F
  "3e4149497a" + // G
  "7f0808087f" + // H
  "00417f4100" + // I
  "2040413f01" + // J
  "7f08142241" + // K
  "7f40404040" + // L
  "7f020c027f" + // M
  "7f0408107f" + // N
  "3e4141413e" + // O
  "7f09090906" + // P
  "3e4151215e" + // Q
  "7f09192946" + // R
  "4649494931" + // S
  "01017f0101" + // T
  "3f4040403f" + // U
  "1f2040201f" + // V
  "3f4038403f" + // W
  "6314081463" + // X
  "0708700807" + // Y
  "6151494543" + // Z
  "007f414100" + // [
  "0204081020" + // backslash
  "0041417f00" + // ]
  "0402010204" + // ^
  "4040404040" + // _
  "0001020400" + // `
  "2054545478" + // a
  "7f48444438" + // b
  "3844444420" + // c
  "384444487f" + // d
  "3854545418" + // e
  "087e090102" + // f
  "0c5252523e" + // g
  "7f08040478" + // h
  "00447d4000" + // i
  "2040443d00" + // j
  "7f10284400" + // k
  "00417f4000" + // l
  "7c04180478" + // m
  "7c08040478" + // n
  "3844444438" + // o
  "7c14141408" + // p
  "081414187c" + // q
  "7c08040408" + // r
  "4854545420" + // s
  "043f444020" + // t
  "3c4040207c" + // u
  "1c2040201c" + // v
  "3c4030403c" + // w
  "4428102844" + // x
  "0c5050503c" + // y
  "4464544c44" + // z
  "0008364100" + // {
  "00007f0000" + // |
  "0041360800" + // }
  "08082a1c08"; //  ~

const GLYPH_COUNT = FONT_5X7.length / 10;

/** The five column bytes of a glyph, or the "?" glyph for anything the set lacks. */
export function glyph5x7(codePoint: number): number[] {
  let index = codePoint - 0x20;
  if (codePoint === 0x2212) index = 0x2d - 0x20; // true minus sign
  if (index < 0 || index >= GLYPH_COUNT) index = 0x3f - 0x20; // ?
  const hex = FONT_5X7.slice(index * 10, index * 10 + 10);
  const cols: number[] = [];
  for (let i = 0; i < 5; i++) cols.push(parseInt(hex.slice(i * 2, i * 2 + 2), 16));
  return cols;
}

function drawAsciiCell(bitmap: Bitmap, codePoint: number, x0: number, y0: number, sx: number, sy: number): void {
  const cols = glyph5x7(codePoint);
  // Glyph is 5 x 7, drawn at 2x (10 x 14) inside a 12 x 24 cell: 1 dot side margin, 5 dots top margin.
  const dotW = 2 * sx;
  const dotH = 2 * sy;
  const left = x0 + 1 * sx;
  const top = y0 + 5 * sy;
  for (let c = 0; c < 5; c++) {
    const bits = cols[c]!;
    for (let r = 0; r < 7; r++) {
      if (bits & (1 << r)) fillRect(bitmap, left + c * dotW, top + r * dotH, dotW, dotH);
    }
  }
}

/** Deterministic placeholder for a wide character: a box with a 4 x 4 block pattern keyed on the code point. */
function drawPlaceholderCell(bitmap: Bitmap, codePoint: number, x0: number, y0: number, sx: number, sy: number): void {
  const w = 2 * CELL_WIDTH_DOTS * sx;
  const h = CELL_HEIGHT_DOTS * sy;
  // Outline, one dot thick (scaled).
  fillRect(bitmap, x0 + sx, y0 + sy, w - 2 * sx, sy);
  fillRect(bitmap, x0 + sx, y0 + h - 2 * sy, w - 2 * sx, sy);
  fillRect(bitmap, x0 + sx, y0 + sy, sx, h - 2 * sy);
  fillRect(bitmap, x0 + w - 2 * sx, y0 + sy, sx, h - 2 * sy);
  // 4 x 4 grid of 4 x 4 dot blocks inside, pattern = 16 bits mixed from the code point.
  let bits = (codePoint ^ (codePoint >>> 7) ^ (codePoint >>> 13)) & 0xffff;
  if (bits === 0) bits = 0x5a5a;
  const blockW = 4 * sx;
  const blockH = 4 * sy;
  const gx = x0 + 4 * sx;
  const gy = y0 + 4 * sy;
  for (let i = 0; i < 16; i++) {
    if (bits & (1 << i)) fillRect(bitmap, gx + (i % 4) * blockW, gy + Math.floor(i / 4) * blockH, blockW, blockH);
  }
}

/**
 * Default `renderTextAsImage`: a full-width bitmap one text line tall, with
 * the text placed according to `style.align` (see module notes).
 */
export const renderTextAsImageDefault: RenderTextAsImage = (text, widthDots, style) => {
  const sx = style.width;
  const sy = style.height;
  const height = CELL_HEIGHT_DOTS * sy;
  const bitmap = createBitmap(widthDots, height);
  const textDots = displayWidth(text) * CELL_WIDTH_DOTS * sx;
  let x = 0;
  if (style.align === "center") x = Math.max(0, Math.floor((widthDots - textDots) / 2));
  else if (style.align === "right") x = Math.max(0, widthDots - textDots);
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (isWideChar(cp)) {
      drawPlaceholderCell(bitmap, cp, x, 0, sx, sy);
      x += 2 * CELL_WIDTH_DOTS * sx;
    } else {
      if (cp !== 0x20) drawAsciiCell(bitmap, cp, x, 0, sx, sy);
      x += CELL_WIDTH_DOTS * sx;
    }
    if (x >= widthDots) break;
  }
  return bitmap;
};

/** Render a bitmap as text art ("#" for black), for debugging and tests. */
export function bitmapToAscii(bitmap: Bitmap): string {
  const rows: string[] = [];
  for (let y = 0; y < bitmap.height; y++) {
    let row = "";
    for (let x = 0; x < bitmap.width; x++) row += getPixel(bitmap, x, y) ? "#" : ".";
    rows.push(row);
  }
  return rows.join("\n");
}
