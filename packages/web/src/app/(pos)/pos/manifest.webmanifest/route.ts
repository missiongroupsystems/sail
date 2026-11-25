import { INITIAL_ICON_PATH, PRODUCT_ICON, PRODUCT_NAME } from "@/lib/brand";

export const dynamic = "force-static";

/** Web app manifest: standalone, landscape, scoped to /pos so the swipe-back gesture cannot leave the POS. */
export function GET(): Response {
  const manifest = {
    name: `${PRODUCT_NAME} POS`,
    short_name: PRODUCT_NAME,
    description: `${PRODUCT_NAME} point of sale`,
    id: "/pos",
    start_url: "/pos",
    scope: "/pos",
    display: "standalone",
    orientation: "landscape",
    background_color: "#0f1311",
    theme_color: "#0f1311",
    // A downstream brand's own icon is of a type only it knows, so it names none; the browser reads it from the file.
    icons: [PRODUCT_ICON === undefined || PRODUCT_ICON === INITIAL_ICON_PATH ? { src: PRODUCT_ICON ?? "/pos/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" } : { src: PRODUCT_ICON, sizes: "any", purpose: "any" }],
  };
  return new Response(JSON.stringify(manifest), { headers: { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "public, max-age=3600" } });
}
