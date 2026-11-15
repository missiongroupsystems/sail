/** WCAG 2.x contrast, for the token tests and for text on a brand's accent. */

export type Rgb = { r: number; g: number; b: number };

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function hexToRgb(hex: string): Rgb | null {
  if (!HEX_RE.test(hex)) return null;
  return { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) };
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const INK: Rgb = { r: 0x0d, g: 0x0d, b: 0x0d };

/**
 * The text colour for a label on a brand's accent: white or ink, whichever reads better, and black when neither
 * reaches 4.5:1. Black always does then: an accent too light for white text is at least 4.6:1 against black.
 * An invalid hex gets white, as the default accent is dark.
 */
export function onAccent(hex: string): "#ffffff" | "#0d0d0d" | "#000000" {
  const rgb = hexToRgb(hex);
  if (!rgb) return "#ffffff";
  const white = contrastRatio(rgb, WHITE);
  const ink = contrastRatio(rgb, INK);
  if (Math.max(white, ink) >= 4.5) return white >= ink ? "#ffffff" : "#0d0d0d";
  return "#000000";
}

/**
 * The accent as text on the guest sheet (white): the accent itself when it reaches 4.5:1 there, otherwise the
 * accent mixed toward black in small steps until it does. Black is 21:1 on white, so the walk always ends.
 * An invalid hex gets the default deep green.
 */
export function accentText(hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return "#173527";
  for (let k = 0; k <= 100; k += 2) {
    const t = 1 - k / 100;
    const c = { r: Math.round(rgb.r * t), g: Math.round(rgb.g * t), b: Math.round(rgb.b * t) };
    if (contrastRatio(c, WHITE) >= 4.5) return `#${[c.r, c.g, c.b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  }
  return "#000000";
}
