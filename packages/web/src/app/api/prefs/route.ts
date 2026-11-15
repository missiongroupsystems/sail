import { cookies } from "next/headers";
import { z } from "zod";
import { PREFS_MAX_AGE_SECONDS, SCOPE_COOKIE, THEME_COOKIE } from "@/lib/cookies";

export const dynamic = "force-dynamic";

const Prefs = z.object({
  theme: z.enum(["day", "service"]).optional(),
  scope: z.object({ brandId: z.string().nullable(), outletId: z.string().nullable() }).optional(),
});

/** POST { theme?, scope? } -> remembers the Day/Service theme and the Brand ▸ Outlet scope for this browser. */
export async function POST(request: Request): Promise<Response> {
  const parsed = Prefs.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ code: "validation", message: "Unrecognised preference" }, { status: 400 });

  const jar = await cookies();
  const base = { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: PREFS_MAX_AGE_SECONDS };
  if (parsed.data.theme) jar.set(THEME_COOKIE, parsed.data.theme, base);
  if (parsed.data.scope) jar.set(SCOPE_COOKIE, JSON.stringify(parsed.data.scope), base);
  return Response.json({ ok: true });
}
