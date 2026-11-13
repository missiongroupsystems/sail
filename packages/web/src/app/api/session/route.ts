import { cookies } from "next/headers";
import { z } from "zod";
import { REGION_PRESET_KEYS } from "@sail/shared";
import { ApiError, createApi, req } from "@/lib/api";
import { API_URL } from "@/lib/api.server";
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from "@/lib/cookies";

export const dynamic = "force-dynamic";

const SignIn = z.discriminatedUnion("kind", [
  /** Email and password, checked by the register (the local identity provider). */
  z.object({ kind: z.literal("password"), email: z.string().min(1), password: z.string().min(1) }),
  /** First-run setup: the register creates the merchant and its first Admin, and signs them in. */
  z.object({
    kind: z.literal("setup"),
    business_name: z.string(),
    preset: z.enum(REGION_PRESET_KEYS),
    time_zone: z.string(),
    currency: z.string().optional(),
    locale: z.string().optional(),
    outlet_name: z.string(),
    admin: z.object({ name: z.string(), email: z.string(), password: z.string() }),
  }),
  /** An invitation or reset link: the token from the link and the new password. */
  z.object({ kind: z.literal("link"), token: z.string().min(1), password: z.string() }),
  /** Sign-in through the external identity provider happened in the browser; this is its access token. */
  z.object({ kind: z.literal("token"), token: z.string().min(1) }),
]);

function errorResponse(e: unknown): Response {
  if (e instanceof ApiError) {
    return Response.json({ code: e.code, message: e.message, remedy: e.remedy, details: e.details }, { status: e.status || 503 });
  }
  return Response.json({ code: "internal", message: "Sign-in failed", remedy: "Try again." }, { status: 500 });
}

/** POST { kind: "password" | "setup" | "link" | "token", ... } -> sets the httpOnly session cookie. */
export async function POST(request: Request): Promise<Response> {
  // A cross-site form can post text/plain without a preflight; only same-origin script sends JSON. Stops login CSRF.
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return Response.json({ code: "validation", message: "Send the sign-in as JSON" }, { status: 415 });
  }
  const parsed = SignIn.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ code: "validation", message: "Fill in every field", remedy: "Check the form and try again." }, { status: 400 });
  }

  // The register locks out an address after repeated failures, so it needs the browser's address, not this server's.
  const forwarded = request.headers.get("x-forwarded-for");
  const anonymous = createApi({ baseUrl: API_URL, headers: forwarded ? { "x-forwarded-for": forwarded } : undefined });
  try {
    let token: string;
    const body = parsed.data;
    if (body.kind === "password") {
      token = (await req(anonymous.POST("/v1/auth/sign-in", { body: { email: body.email, password: body.password } }))).data.token;
    } else if (body.kind === "setup") {
      const { kind: _kind, ...setup } = body;
      const done = await req(anonymous.POST("/v1/setup", { body: setup }));
      if (!done.data.session) return Response.json({ ok: true, signed_in: false });
      token = done.data.session.token;
    } else if (body.kind === "link") {
      token = (await req(anonymous.POST("/v1/auth/links/accept", { body: { token: body.token, password: body.password } }))).data.token;
      // A link opened in a browser someone is signed in to: that person's session ends on the register, not only here.
      const previous = (await cookies()).get(SESSION_COOKIE)?.value;
      if (previous && previous !== token) await createApi({ baseUrl: API_URL, token: previous }).POST("/v1/auth/sign-out", { body: {} }).catch(() => null);
    } else {
      token = body.token;
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
    return Response.json({ ok: true, signed_in: true, name: me.data.name, role: me.data.role });
  } catch (e) {
    return errorResponse(e);
  }
}

/** DELETE -> ends the register's session and clears the cookie. */
export async function DELETE(): Promise<Response> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    // Best effort: the cookie goes either way, and an already-ended session is fine.
    await createApi({ baseUrl: API_URL, token })
      .POST("/v1/auth/sign-out", { body: {} })
      .catch(() => null);
  }
  jar.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 0 });
  return Response.json({ ok: true });
}
