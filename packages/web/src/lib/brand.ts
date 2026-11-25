import extensions from "@sail/extensions";

/** The product's name: Sail's, unless a downstream build names its own (extensions/types.ts). */
export const PRODUCT_NAME = extensions.brand?.name ?? "Sail";

/** The downstream product's mark, null when it names none; undefined in stock Sail, which keeps the sail. */
export const PRODUCT_MARK = extensions.brand ? (extensions.brand.mark ?? null) : undefined;

/** Where the generated initial is served (app/brand-icon.svg) when a brand names no icon of its own. */
export const INITIAL_ICON_PATH = "/brand-icon.svg";

/**
 * The downstream product's icon for the browser tab, the home screen and the POS app: its own, or its initial; undefined
 * in stock Sail, which keeps the sail icons.
 */
export const PRODUCT_ICON = extensions.brand ? (extensions.brand.icon ?? INITIAL_ICON_PATH) : undefined;

/** A neutral icon with the name's first letter, as the collapsed rail shows a brand without a mark. */
export function initialIcon(name: string): string {
  const letter = (Array.from(name.trim())[0] ?? "?").toUpperCase().replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#0d0d0d"/><text x="256" y="256" dy="0.35em" text-anchor="middle" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="300" font-weight="600" fill="#ffffff">${letter}</text></svg>`;
}
