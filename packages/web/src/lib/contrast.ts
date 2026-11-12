/**
 * WCAG 2.x contrast for brand accents: an accent that fails 4.5:1 for
 * text on its button gets a derived darker or lighter variant, shown before saving.
 */

export type Rgb = { r: number; g: number; b: number };

export const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function hexToRgb(hex: string): Rgb | null {
  if (!HEX_RE.test(hex)) return null;
  return { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(rgb: Rgb): number {
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h, s, l };
}

function hslToRgb({ h, s, l }: { h: number; s: number; l: number }): Rgb {
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 };
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return { r: hue(p, q, h + 1 / 3) * 255, g: hue(p, q, h) * 255, b: hue(p, q, h - 1 / 3) * 255 };
}

export const WHITE: Rgb = { r: 255, g: 255, b: 255 };
/** `ink` by day. */
export const INK: Rgb = { r: 0x1c, g: 0x1d, b: 0x1f };
export const MIN_TEXT_CONTRAST = 4.5;

export type AccentCheck = {
  /** The accent as entered. */
  hex: string;
  /** Best achievable contrast with white or ink text on the accent. */
  ratio: number;
  /** Which text colour the button would use. */
  textOn: "white" | "ink";
  passes: boolean;
  /** When it fails: the nearest darker or lighter variant that passes, and the text colour it needs. */
  suggestion: { hex: string; ratio: number; textOn: "white" | "ink"; direction: "darker" | "lighter" } | null;
};

function walk(hsl: { h: number; s: number; l: number }, step: number, text: Rgb): { hex: string; ratio: number; steps: number } | null {
  let l = hsl.l;
  for (let steps = 1; steps <= 50; steps++) {
    l += step;
    if (l < 0 || l > 1) return null;
    const rgb = hslToRgb({ ...hsl, l });
    const ratio = contrastRatio(rgb, text);
    if (ratio >= MIN_TEXT_CONTRAST) return { hex: rgbToHex(rgb), ratio, steps };
  }
  return null;
}

/** Checks an accent for 4.5:1 text contrast on a button and derives a passing variant when it fails. */
export function checkAccent(hex: string): AccentCheck | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const onWhite = contrastRatio(rgb, WHITE);
  const onInk = contrastRatio(rgb, INK);
  const textOn = onWhite >= onInk ? "white" : "ink";
  const ratio = Math.max(onWhite, onInk);
  if (ratio >= MIN_TEXT_CONTRAST) return { hex: hex.toUpperCase(), ratio, textOn, passes: true, suggestion: null };

  const hsl = rgbToHsl(rgb);
  const darker = walk(hsl, -0.02, WHITE);
  const lighter = walk(hsl, 0.02, INK);
  let suggestion: AccentCheck["suggestion"] = null;
  if (darker && (!lighter || darker.steps <= lighter.steps)) suggestion = { hex: darker.hex, ratio: darker.ratio, textOn: "white", direction: "darker" };
  else if (lighter) suggestion = { hex: lighter.hex, ratio: lighter.ratio, textOn: "ink", direction: "lighter" };
  return { hex: hex.toUpperCase(), ratio, textOn, passes: false, suggestion };
}

export function formatRatio(ratio: number): string {
  return `${(Math.floor(ratio * 10) / 10).toFixed(1)}:1`;
}
