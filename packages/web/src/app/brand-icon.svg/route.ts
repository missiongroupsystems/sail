import { INITIAL_ICON_PATH, initialIcon, PRODUCT_ICON, PRODUCT_NAME } from "@/lib/brand";

export const dynamic = "force-static";

/** The icon of a downstream brand that names none of its own: its initial (lib/brand.ts). Stock Sail serves nothing here. */
export function GET(): Response {
  if (PRODUCT_ICON !== INITIAL_ICON_PATH) return new Response(null, { status: 404 });
  return new Response(initialIcon(PRODUCT_NAME), { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=3600" } });
}
