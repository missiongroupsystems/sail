export const dynamic = "force-static";

/** The home-screen icon: the three-point sail on charcoal. */
export function GET(): Response {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#121315"/><path d="M118 392 256 88l138 304Z" fill="#ece8e1"/><path d="M256 88v304" stroke="#121315" stroke-width="22"/></svg>`;
  return new Response(svg, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
}
