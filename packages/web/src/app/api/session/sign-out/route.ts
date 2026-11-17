import { cookies } from "next/headers";
import { createApi } from "@/lib/api";
import { API_URL } from "@/lib/api.server";
import { SESSION_COOKIE } from "@/lib/cookies";

export const dynamic = "force-dynamic";

/**
 * POST (a plain form) -> ends the register's session, clears the cookie and lands on /login. The rail's Sign out is
 * this form, so a press before the page has hydrated still signs out (round 8 check 8); once hydrated, the page signs
 * out itself through DELETE /api/session. Only this site's own pages may post it.
 */
export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  const site = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !site || new URL(origin).host !== site) return Response.json({ code: "forbidden", message: "Sign out from the back office itself" }, { status: 403 });
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    // Best effort, as DELETE /api/session: the cookie goes either way, and an already-ended session is fine.
    await createApi({ baseUrl: API_URL, token })
      .POST("/v1/auth/sign-out", { body: {} })
      .catch(() => null);
  }
  jar.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 0 });
  return new Response(null, { status: 303, headers: { location: "/login" } });
}
