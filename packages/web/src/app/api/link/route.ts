import { z } from "zod";
import { ApiError, createApi, req } from "@/lib/api";
import { API_URL } from "@/lib/api.server";

export const dynamic = "force-dynamic";

const Body = z.object({ token: z.string().min(1).max(200) });

/**
 * POST { token } -> whose password an invitation or reset link sets (name and email), without using the link. The
 * set-password page is opened signed out, so it cannot go through the signed-in proxy (F-N4).
 */
export async function POST(request: Request): Promise<Response> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) return Response.json({ code: "validation", message: "Send the link as JSON" }, { status: 415 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ code: "validation", message: "This page needs the link an Admin gave you" }, { status: 400 });
  try {
    const res = await req(createApi({ baseUrl: API_URL }).POST("/v1/auth/links/inspect", { body: { token: parsed.data.token } }));
    return Response.json({ data: res.data }, { status: 200 });
  } catch (e) {
    if (e instanceof ApiError) return Response.json({ code: e.code, message: e.message, remedy: e.remedy }, { status: e.status || 502 });
    throw e;
  }
}
