/**
 * A small ESC/POS byte builder.
 *
 * Only the commands the templates need are here. Every method appends to an
 * internal buffer and returns `this`, and `toBytes()` yields the job as a
 * Uint8Array that the relay writes to the printer on TCP port 9100 unchanged.
 *
 * Text encoding
 * - Plain text goes out in a single-byte code page (ESC t n, default 16 =
 *   WPC1252, which is Latin-1 for U+00A0..U+00FF). The true minus sign U+2212
 *   that the copy rules require has no single-byte code point, so it is sent
 *   as the ASCII hyphen-minus; the plain-text preview keeps the real sign.
 * - Text containing characters outside that range (CJK item names, say) is
 *   sent in Kanji mode (FS & ... FS .) when the encoder is created with
 *   `cjk: true`, using the injectable `encodeCjk` function. The default is
 *   UTF-8, which suits printers configured for a UTF-8 multibyte code page;
 *   the server should inject a GBK or Big5 encoder for printers that want
 *   those. With `cjk: false`, `text()` throws for such strings and the caller
 *   rasterises the line instead (see templates.ts and raster.ts).
 */

export const NUL = 0x00;
export const LF = 0x0a;
export const DLE = 0x10;
export const EOT = 0x04;
export const ESC = 0x1b;
export const FS = 0x1c;
export const GS = 0x1d;

/** Default single-byte code page: 16 = WPC1252 on most ESC/POS printers. */
export const DEFAULT_CODE_PAGE = 16;

export type Align = "left" | "center" | "right";
export type SizeMultiplier = 1 | 2;

/** 1-bit bitmap, row-major, MSB first, 1 = black. Each row is `ceil(width / 8)` bytes. */
export interface Bitmap {
  width: number;
  height: number;
  data: Uint8Array;
}

export type CjkEncoder = (text: string) => Uint8Array;

export interface EncoderOptions {
  /** Allow Kanji-mode text for strings the single-byte code page cannot carry. */
  cjk?: boolean;
  /** Byte encoder used in Kanji mode. Defaults to UTF-8. */
  encodeCjk?: CjkEncoder;
  /** ESC t code page selected by `init()`. Defaults to 16 (WPC1252). */
  codePage?: number;
}

/** Real-time status requests (DLE EOT n). The relay sends one and reads a single status byte back. */
export const DLE_EOT_STATUS = {
  printer: Uint8Array.of(DLE, EOT, 1),
  offline: Uint8Array.of(DLE, EOT, 2),
  error: Uint8Array.of(DLE, EOT, 3),
  paper: Uint8Array.of(DLE, EOT, 4),
} as const;

const ALIGN_CODE: Record<Align, number> = { left: 0, center: 1, right: 2 };

const utf8 = new TextEncoder();
export const encodeUtf8: CjkEncoder = (text) => utf8.encode(text);

/** WPC1252's characters in 0x80–0x9F (the euro sign, typographic quotes and dashes), which Latin-1 leaves as controls. */
const WPC1252_HIGH: ReadonlyMap<number, number> = new Map(
  [..."€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ"].map((ch, i) => [ch.codePointAt(0)!, 0x80 + i] as const).filter(([cp]) => cp > 0x9f),
);

/** Map one code point to its single-byte value in WPC1252 (the default code page), or -1 when it has none. */
export function singleByteFor(codePoint: number): number {
  if (codePoint >= 0x20 && codePoint < 0x7f) return codePoint;
  if (codePoint === 0x2212) return 0x2d; // true minus sign -> hyphen-minus
  if (codePoint >= 0xa0 && codePoint <= 0xff) return codePoint;
  return WPC1252_HIGH.get(codePoint) ?? -1;
}

export function canEncodeSingleByte(text: string): boolean {
  for (const ch of text) {
    if (singleByteFor(ch.codePointAt(0)!) < 0) return false;
  }
  return true;
}

export function encodeSingleByte(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const b = singleByteFor(ch.codePointAt(0)!);
    if (b < 0) throw new RangeError(`"${ch}" has no single-byte code point`);
    out.push(b);
  }
  return Uint8Array.from(out);
}

export class EscPosEncoder {
  private readonly chunks: Uint8Array[] = [];
  private readonly cjk: boolean;
  private readonly encodeCjk: CjkEncoder;
  private readonly codePageNo: number;

  constructor(options: EncoderOptions = {}) {
    this.cjk = options.cjk ?? false;
    this.encodeCjk = options.encodeCjk ?? encodeUtf8;
    this.codePageNo = options.codePage ?? DEFAULT_CODE_PAGE;
  }

  raw(bytes: ArrayLike<number>): this {
    this.chunks.push(Uint8Array.from(bytes));
    return this;
  }

  /** ESC @ then ESC t n: reset the printer and select the single-byte code page. */
  init(): this {
    this.raw([ESC, 0x40]);
    return this.codePage(this.codePageNo);
  }

  /** ESC t n: select character code table. */
  codePage(n: number): this {
    return this.raw([ESC, 0x74, n & 0xff]);
  }

  /** Append text without a line feed. Throws when the text cannot be encoded (see module notes). */
  text(s: string): this {
    if (s.length === 0) return this;
    if (canEncodeSingleByte(s)) return this.raw(encodeSingleByte(s));
    if (!this.cjk) throw new RangeError("text needs a CJK code page; rasterise it instead");
    this.raw([FS, 0x26]);
    this.raw(this.encodeCjk(s));
    return this.raw([FS, 0x2e]);
  }

  /** Append text followed by LF. */
  line(s = ""): this {
    this.text(s);
    return this.raw([LF]);
  }

  /** ESC E n: emphasis on or off. */
  bold(on: boolean): this {
    return this.raw([ESC, 0x45, on ? 1 : 0]);
  }

  /** GS ! n: character width and height multipliers (1 or 2). */
  size(width: SizeMultiplier, height: SizeMultiplier): this {
    return this.raw([GS, 0x21, ((width - 1) << 4) | (height - 1)]);
  }

  /** ESC a n: justification. */
  align(a: Align): this {
    return this.raw([ESC, 0x61, ALIGN_CODE[a]]);
  }

  /** ESC d n: print and feed n lines. */
  feed(lines = 1): this {
    if (lines <= 0) return this;
    return this.raw([ESC, 0x64, Math.min(255, lines)]);
  }

  /** GS V 66 0: feed to the cutting position and partial cut. */
  cut(): this {
    return this.raw([GS, 0x56, 66, 0]);
  }

  /** ESC B n t: buzzer, n times for t x 100 ms. Not part of every printer's command set. */
  beep(times = 2, duration = 2): this {
    return this.raw([ESC, 0x42, clamp(times, 1, 9), clamp(duration, 1, 9)]);
  }

  /** GS v 0 m xL xH yL yH d1..dk: print a raster bit image at normal density. */
  raster(bitmap: Bitmap): this {
    const bytesPerRow = Math.ceil(bitmap.width / 8);
    if (bitmap.data.length !== bytesPerRow * bitmap.height) {
      throw new RangeError(`bitmap data has ${bitmap.data.length} bytes; expected ${bytesPerRow * bitmap.height}`);
    }
    if (bytesPerRow > 0xffff || bitmap.height > 0xffff) throw new RangeError("bitmap too large for GS v 0");
    this.raw([GS, 0x76, 0x30, 0, bytesPerRow & 0xff, bytesPerRow >> 8, bitmap.height & 0xff, bitmap.height >> 8]);
    this.chunks.push(bitmap.data);
    return this;
  }

  toBytes(): Uint8Array {
    let total = 0;
    for (const c of this.chunks) total += c.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

/** Well-known byte sequences, handy for tests and for the relay. */
export const SEQUENCES = {
  init: Uint8Array.of(ESC, 0x40),
  partialCut: Uint8Array.of(GS, 0x56, 66, 0),
  rasterHeader: Uint8Array.of(GS, 0x76, 0x30),
  kanjiOn: Uint8Array.of(FS, 0x26),
  kanjiOff: Uint8Array.of(FS, 0x2e),
} as const;

export function startsWithBytes(haystack: Uint8Array, prefix: Uint8Array): boolean {
  if (haystack.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (haystack[i] !== prefix[i]) return false;
  return true;
}

export function endsWithBytes(haystack: Uint8Array, suffix: Uint8Array): boolean {
  if (haystack.length < suffix.length) return false;
  const start = haystack.length - suffix.length;
  for (let i = 0; i < suffix.length; i++) if (haystack[start + i] !== suffix[i]) return false;
  return true;
}

export function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return true;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}
