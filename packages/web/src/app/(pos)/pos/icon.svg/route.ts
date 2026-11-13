export const dynamic = "force-static";

/** The home-screen icon: the three-point sail on charcoal. */
export function GET(): Response {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#0f1311"/><path d="M118 392 236.5 149.6V392Z" fill="#e9ece9"/><path d="M275.5 149.6 394 392H275.5Z" fill="#e9ece9"/></svg>`;
  return new Response(svg, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
}
