import { gunzipSync } from "node:zlib";
import { CELL_HEIGHT_DOTS, CELL_WIDTH_DOTS, createBitmap, isWideChar, setPixel, type RenderTextAsImage } from "@sail/shared";
import { ARABIC_FORMS, GLYPHS_GZ_BASE64, LAM_ALEF } from "./print-font.generated.js";

/**
 * The renderer for receipt and ticket lines the printer's code page cannot carry (anything outside Latin-1 on a
 * printer without a CJK code page): GNU Unifont glyphs, scaled into the printer's character cells, so Japanese,
 * Chinese, Korean, Greek, Cyrillic, accented Latin and Arabic print as text instead of placeholder boxes.
 *
 * - Text is NFC-normalised first, so a letter and its combining accent print as one precomposed glyph.
 * - Every character fills the cells the layout gave it (layout.ts: two for wide characters, one otherwise), so the
 *   columns of a raster line match the text preview.
 * - Arabic letters take their joining forms (isolated, initial, medial, final, and the lam-alef ligatures), vowel
 *   marks are dropped, and each run of Arabic or Hebrew is written right to left inside the line, which itself stays
 *   left to right like the rest of the ticket. Numbers inside such a run keep their order.
 * - Scripts that need marks stacked on a base letter (Thai, Devanagari and other Indic scripts) are not supported:
 *   their marks print as separate characters. Characters without a glyph print as U+FFFD.
 */

type Glyph = { width: 8 | 16; rows: Uint8Array };
let glyphs: Map<number, Glyph> | null = null;

function font(): Map<number, Glyph> {
  if (glyphs) return glyphs;
  glyphs = new Map();
  for (const line of gunzipSync(Buffer.from(GLYPHS_GZ_BASE64, "base64")).toString("utf8").split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const hex = line.slice(colon + 1);
    glyphs.set(parseInt(line.slice(0, colon), 16), { width: hex.length === 64 ? 16 : 8, rows: Uint8Array.from(Buffer.from(hex, "hex")) });
  }
  return glyphs;
}

function glyphPixel(g: Glyph, x: number, y: number): boolean {
  const bytesPerRow = g.width / 8;
  return (g.rows[y * bytesPerRow + (x >> 3)]! & (0x80 >> (x & 7))) !== 0;
}

const isArabic = (cp: number) => (cp >= 0x600 && cp <= 0x6ff) || (cp >= 0xfb50 && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff);
const isRtl = (cp: number) => (cp >= 0x590 && cp <= 0x5ff) || isArabic(cp);
/** Vowel and other combining marks of Arabic and Hebrew: dropped, as the layout has no room above or below a letter. */
const isRtlMark = (cp: number) => (cp >= 0x591 && cp <= 0x5c7) || (cp >= 0x610 && cp <= 0x61a) || (cp >= 0x64b && cp <= 0x65f) || cp === 0x670 || (cp >= 0x6d6 && cp <= 0x6ed);
const joinsNext = (cp: number) => { const f = ARABIC_FORMS[cp]; return !!f && (f[2] !== 0 || f[3] !== 0); };
const joinsPrev = (cp: number) => { const f = ARABIC_FORMS[cp]; return !!f && f[1] !== 0; };

/** Arabic letters in their contextual forms, in logical order. */
export function shapeArabic(cps: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i]!;
    const prev = cps[i - 1];
    const next = cps[i + 1];
    const afterJoin = prev !== undefined && joinsNext(prev) && joinsPrev(cp);
    const lig = cp === 0x644 && next !== undefined ? LAM_ALEF[next] : undefined;
    if (lig) {
      out.push(afterJoin && lig[1] ? lig[1] : lig[0]);
      i++;
      continue;
    }
    const f = ARABIC_FORMS[cp];
    if (!f) {
      out.push(cp);
      continue;
    }
    const beforeJoin = next !== undefined && joinsNext(cp) && joinsPrev(next);
    const pick = afterJoin && beforeJoin ? f[3] || f[1] : afterJoin ? f[1] : beforeJoin ? f[2] : 0;
    out.push(pick || f[0] || cp);
  }
  return out;
}

/** The line in drawing order: each right-to-left run reversed in place, with the digits inside it kept in order. */
export function visualOrder(cps: number[]): number[] {
  const out: number[] = [];
  let i = 0;
  const neutral = (cp: number) => cp === 0x20 || (cp >= 0x30 && cp <= 0x39) || cp === 0x2e || cp === 0x2c;
  while (i < cps.length) {
    if (!isRtl(cps[i]!)) {
      out.push(cps[i++]!);
      continue;
    }
    // The run: right-to-left letters and the spaces and numbers between them, ending at the last such letter.
    let end = i;
    for (let j = i; j < cps.length && (isRtl(cps[j]!) || neutral(cps[j]!)); j++) if (isRtl(cps[j]!)) end = j;
    const run = cps.slice(i, end + 1);
    const tokens: number[][] = [];
    for (const cp of run) {
      const digit = cp >= 0x30 && cp <= 0x39;
      const last = tokens.at(-1);
      if (digit && last && last[0]! >= 0x30 && last[0]! <= 0x39) last.push(cp);
      else tokens.push([cp]);
    }
    for (const t of tokens.reverse()) out.push(...t);
    i = end + 1;
  }
  return out;
}

export const renderTextAsImageUnifont: RenderTextAsImage = (text, widthDots, style) => {
  const sx = style.width;
  const sy = style.height;
  const height = CELL_HEIGHT_DOTS * sy;
  const bitmap = createBitmap(widthDots, height);
  const logical = [...text.normalize("NFC")].map((c) => c.codePointAt(0)!);
  const cells = (cp: number) => (isWideChar(cp) ? 2 : 1);
  // Shaping and reordering never widen the text, so alignment works on the text as the layout measured it.
  const textDots = logical.reduce((n, cp) => n + (isRtlMark(cp) ? 0 : cells(cp)), 0) * CELL_WIDTH_DOTS * sx;
  const drawn = visualOrder(shapeArabic(logical.filter((cp) => !isRtlMark(cp))));
  let x = style.align === "center" ? Math.max(0, Math.floor((widthDots - textDots) / 2)) : style.align === "right" ? Math.max(0, widthDots - textDots) : 0;
  const f = font();
  for (const cp of drawn) {
    const w = cells(cp) * CELL_WIDTH_DOTS * sx;
    if (cp !== 0x20) {
      const g = f.get(cp) ?? f.get(0xfffd)!;
      // Nearest-neighbour scaling of the 16-dot-tall glyph into the cell (24 dots per text line, more for large text).
      for (let ty = 0; ty < height; ty++) {
        const gy = Math.floor((ty * 16) / height);
        for (let tx = 0; tx < w; tx++) if (glyphPixel(g, Math.floor((tx * g.width) / w), gy)) setPixel(bitmap, x + tx, ty);
      }
    }
    x += w;
    if (x >= widthDots) break;
  }
  return bitmap;
};
