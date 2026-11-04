import type { CSSProperties } from "react";
import { displayFontVariable } from "./display-fonts";
import type { Brand } from "./types";

/**
 * Brand theming (design 9): the accent, the display font and the logo arrive
 * with the channel link's menu and become custom properties on the element
 * that carries `data-brand`. Controls keep Sail's shape; only these change.
 */
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

type Rgb = { r: number; g: number; b: number };
function hexToRgb(hex: string): Rgb | null {
  if (!HEX_RE.test(hex)) return null;
  return { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) };
}
function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const INK: Rgb = { r: 0x1c, g: 0x1d, b: 0x1f };

/** White or ink text on the accent, whichever reads better (the back office checks 4.5:1 when the brand is saved). */
export function onAccent(hex: string): "#ffffff" | "#1c1d1f" {
  const rgb = hexToRgb(hex);
  if (!rgb) return "#ffffff";
  return contrast(rgb, WHITE) >= contrast(rgb, INK) ? "#ffffff" : "#1c1d1f";
}

/** Inline custom properties for the brand; tokens without a brand value fall back to the guest defaults. */
export function brandStyle(brand: Pick<Brand, "accent_color" | "display_font"> | null | undefined): CSSProperties {
  const style: Record<string, string> = {};
  const accent = brand?.accent_color;
  if (accent && HEX_RE.test(accent)) {
    style["--brand-accent"] = accent;
    style["--on-brand-accent"] = onAccent(accent);
  }
  const fontVar = displayFontVariable(brand?.display_font);
  if (fontVar) style["--brand-display-font"] = `var(${fontVar}), var(--font-sans)`;
  return style as CSSProperties;
}
