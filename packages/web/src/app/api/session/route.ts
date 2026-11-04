import { cookies } from "next/headers";
import { z } from "zod";
import { ApiError, createApi, req } from "@/lib/api";
import { API_URL } from "@/lib/api.server";
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from "@/lib/cookies";

export const dynamic = "force-dynamic";

const SignIn = z.discriminatedUnion("kind", [
  /** Development sign-in: the API mints a token for a staff email (never in production). */
  z.object({ kind: z.literal("dev"), email: z.email() }),
  /** Supabase sign-in happened in the browser; this is the access token to use against the API. */
  z.object({ kind: z.literal("token"), token: z.string().min(1) }),
]);

function errorResponse(e: unknown): Response {
  if (e instanceof ApiError) {
    return Response.json({ code: e.code, message: e.message, remedy: e.remedy, details: e.details }, { status: e.status || 503 });
  }
  return Response.json({ code: "internal", message: "Sign-in failed", remedy: "Try again." }, { status: 500 });
}

/** POST { kind: "dev", email } | { kind: "token", token } -> sets the httpOnly session cookie. */
export async function POST(request: Request): Promise<Response> {
  const parsed = SignIn.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ code: "validation", message: "Enter an email address", remedy: "Use the email on your staff record." }, { status: 400 });
  }

  try {
    let token: string;
    if (parsed.data.kind === "dev") {
      const anonymous = createApi({ baseUrl: API_URL });
      const minted = await req(anonymous.POST("/v1/auth/dev-token", { body: { email: parsed.data.email } }));
      token = minted.token;
    } else {
      token = parsed.data.token;
    }

    // The register decides whether this token belongs to an active staff member.
    const me = await req(createApi({ baseUrl: API_URL, token }).GET("/v1/me"));

    const jar = await cookies();
    jar.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
    return Response.json({ ok: true, name: me.data.name, role: me.data.role });
  } catch (e) {
    return errorResponse(e);
  }
}

/** DELETE -> clears the session cookie. */
export async function DELETE(): Promise<Response> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 0 });
  return Response.json({ ok: true });
}
