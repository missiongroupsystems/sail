import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ApiError, createApi, type ApiClient } from "./api";
import { parseScope, parseTheme, SCOPE_COOKIE, SESSION_COOKIE, THEME_COOKIE, type Scope, type Theme } from "./cookies";

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

/** Runs a server-side call; an expired or revoked session goes back to sign in instead of erroring. */
export async function orSignIn<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (e) {
    if (e instanceof ApiError && e.isUnauthenticated) redirect("/login?expired=1");
    throw e;
  }
}
