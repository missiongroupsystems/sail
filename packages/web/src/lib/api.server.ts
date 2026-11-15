import { cookies } from "next/headers";
import { forbidden, redirect } from "next/navigation";
import { ApiError, createApi, req, type ApiClient } from "./api";
import { parseScope, parseTheme, SCOPE_COOKIE, SESSION_COOKIE, THEME_COOKIE, type Scope, type Theme } from "./cookies";
import { roleAtLeast, type Role } from "@sail/shared";

/** Server side only: the register's address. The browser goes through /api/v1 instead. */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080").replace(/\/+$/, "");

export async function getSessionToken(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(SESSION_COOKIE)?.value ?? null;
}

export async function getTheme(): Promise<Theme> {
  const jar = await cookies();
  return parseTheme(jar.get(THEME_COOKIE)?.value);
}

export async function getScope(): Promise<Scope> {
  const jar = await cookies();
  return parseScope(jar.get(SCOPE_COOKIE)?.value);
}

/** An API client for server components and route handlers, carrying the session cookie's token. */
export async function serverApi(): Promise<ApiClient> {
  return createApi({ baseUrl: API_URL, token: await getSessionToken() });
}

/** Like `serverApi`, but sends the visitor to sign in when there is no session. */
export async function requireApi(): Promise<ApiClient> {
  const token = await getSessionToken();
  if (!token) redirect("/login");
  return createApi({ baseUrl: API_URL, token });
}

/** The business date the register dates new orders on at this outlet, for a page's first render: never the server's or the browser's clock. */
export async function registerToday(api: ApiClient, outletId: string | null): Promise<string | null> {
  if (!outletId) return null;
  const floor = await orSignIn(req(api.GET("/v1/outlets/{id}/floor", { params: { path: { id: outletId } } })));
  return (floor.data as unknown as { business_date: string }).business_date;
}

/**
 * Runs a server-side call; an expired or revoked session goes back to sign in instead of erroring, and a page the
 * person's role may not read shows the refusal (forbidden.tsx) instead of an error page.
 */
export async function orSignIn<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (e) {
    if (e instanceof ApiError && e.isUnauthenticated) redirect("/login?expired=1");
    if (e instanceof ApiError && e.code === "permission_denied") forbidden();
    throw e;
  }
}

/**
 * A page the signed-in role may not read at all: show the same refusal page (forbidden.tsx) the register's 403 gives,
 * before any part of the page loads and fails on its own.
 */
export async function requireRole(min: Role): Promise<void> {
  const api = await requireApi();
  const me = await orSignIn(req(api.GET("/v1/me")));
  if (!roleAtLeast(me.data.role as Role, min)) forbidden();
}
