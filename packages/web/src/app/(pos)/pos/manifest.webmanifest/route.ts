export const dynamic = "force-static";

/** Web app manifest (design 11.3): standalone, landscape, scoped to /pos so the swipe-back gesture cannot leave the POS. */
export function GET(): Response {
  const manifest = {
    name: "Sail POS",
    short_name: "Sail",
    description: "Sail point of sale",
    id: "/pos",
    start_url: "/pos",
    scope: "/pos",
    display: "standalone",
    orientation: "landscape",
    background_color: "#121315",
    theme_color: "#121315",
    icons: [{ src: "/pos/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
  return new Response(JSON.stringify(manifest), { headers: { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "public, max-age=3600" } });
}
