/**
 * The curated display faces a brand may choose for the guest app (design 9):
 * every one is open-licence, self-hosted through next/font and checked for
 * legibility at heading sizes. `lib/fonts.ts` loads them; this module is the
 * plain list so client code can map a brand's `display_font` to its variable.
 */
export const DISPLAY_FONTS = [
  { name: "Fraunces", variable: "--font-display-fraunces" },
  { name: "Playfair Display", variable: "--font-display-playfair" },
  { name: "DM Serif Display", variable: "--font-display-dm-serif" },
  { name: "Lora", variable: "--font-display-lora" },
  { name: "Cormorant Garamond", variable: "--font-display-cormorant" },
  { name: "Libre Baskerville", variable: "--font-display-libre-baskerville" },
  { name: "Space Grotesk", variable: "--font-display-space-grotesk" },
  { name: "Outfit", variable: "--font-display-outfit" },
  { name: "Bricolage Grotesque", variable: "--font-display-bricolage" },
  { name: "Josefin Sans", variable: "--font-display-josefin" },
  { name: "Manrope", variable: "--font-display-manrope" },
  { name: "Sora", variable: "--font-display-sora" },
] as const;

export type DisplayFontName = (typeof DISPLAY_FONTS)[number]["name"];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The CSS variable for a brand's display font, or null when it is not on the curated list (the UI family is used). */
export function displayFontVariable(name: string | null | undefined): string | null {
  if (!name) return null;
  const n = norm(name);
  return DISPLAY_FONTS.find((f) => norm(f.name) === n)?.variable ?? null;
}
