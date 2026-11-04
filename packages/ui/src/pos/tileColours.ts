/** The 12 curated tile colours (design 7.3). The layout editor and the importer only ever produce these. */
export const TILE_COLOURS = ["slate", "stone", "brass", "amber", "olive", "sage", "teal", "sky", "indigo", "plum", "rose", "brick"] as const;
export type TileColour = (typeof TILE_COLOURS)[number];

/** CSS value for a tile's 6pt band. Unknown names fall back to stone so an old layout never breaks. */
export function tileBand(colour: string | null | undefined): string {
  const name = (TILE_COLOURS as readonly string[]).includes(colour ?? "") ? colour : "stone";
  return `var(--tile-${name})`;
}
