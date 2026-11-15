import { accentText, onAccent } from "@sail/ui";
import type { CSSProperties } from "react";
import { displayFontVariable } from "./display-fonts";
import type { Brand } from "./types";

/**
 * Brand theming: the accent, the display font and the logo arrive
 * with the channel link's menu and become custom properties on the element
 * that carries `data-brand`. Controls keep Sail's shape; only these change.
 */
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Inline custom properties for the brand; tokens without a brand value fall back to the guest defaults. */
export function brandStyle(brand: Pick<Brand, "accent_color" | "display_font"> | null | undefined): CSSProperties {
  const style: Record<string, string> = {};
  const accent = brand?.accent_color;
  if (accent && HEX_RE.test(accent)) {
    style["--brand-accent"] = accent;
    style["--on-brand-accent"] = onAccent(accent);
    style["--brand-accent-text"] = accentText(accent);
  }
  const fontVar = displayFontVariable(brand?.display_font);
  if (fontVar) style["--brand-display-font"] = `var(${fontVar}), var(--font-sans)`;
  return style as CSSProperties;
}
