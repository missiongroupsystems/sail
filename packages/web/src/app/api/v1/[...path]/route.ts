import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { API_URL } from "@/lib/api.server";
import { DEFAULT_TIMEOUT_MS } from "@/lib/api";
import { SESSION_COOKIE } from "@/lib/cookies";

export const dynamic = "force-dynamic";

const FORWARD_REQUEST = ["content-type", "accept", "idempotency-key", "if-match", "x-override-id", "x-correlation-id"];
const FORWARD_RESPONSE = ["content-type", "etag", "idempotent-replayed", "x-request-id", "cache-control"];

/**
 * Same-origin proxy for client components: /api/v1/* -> ${API_URL}/v1/*.
 * Adds the bearer token from the session cookie and passes the body, query,
 * Idempotency-Key and status through untouched.
 */
async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await context.params;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) {
    return Response.json({ code: "unauthenticated", message: "Your session has ended", remedy: "Sign in again." }, { status: 401 });
  }

  const url = new URL(`${API_URL}/v1/${path.map(encodeURIComponent).join("/")}`);
  url.search = request.nextUrl.search;

  const headers = new Headers();
  for (const name of FORWARD_REQUEST) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("authorization", `Bearer ${token}`);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const body = hasBody ? await request.arrayBuffer() : undefined;

  let upstream: Response;
  try {
    upstream = await fetch(url, { method: request.method, headers, body, cache: "no-store", signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
  } catch {
    return Response.json(
      { code: "unavailable", message: "The register could not be reached", remedy: "Check that the API is running and try again." },
      { status: 503 },
    );
  }

  const out = new Headers();
  for (const name of FORWARD_RESPONSE) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export { proxy as GET, proxy as POST, proxy as PATCH, proxy as PUT, proxy as DELETE };
