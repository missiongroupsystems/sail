import extensions from "@sail/extensions";

/** The product's name: Sail's, unless a downstream build names its own (extensions/types.ts). */
export const PRODUCT_NAME = extensions.brand?.name ?? "Sail";

/** The downstream product's mark, null when it names none; undefined in stock Sail, which keeps the sail. */
export const PRODUCT_MARK = extensions.brand ? (extensions.brand.mark ?? null) : undefined;
