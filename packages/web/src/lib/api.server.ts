import { cookies, headers } from "next/headers";
import { cache } from "react";
import { forbidden, redirect } from "next/navigation";
import { ApiError, createApi, req, type ApiClient } from "./api";
import { followLink, LINK_OUTLET_HEADER, parseScope, parseTheme, resolveScope, SCOPE_COOKIE, SESSION_COOKIE, THEME_COOKIE, type Scope, type Theme } from "./cookies";
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

/** The brands and outlets the signed-in person can see, read once for a request: the frame and the page share them. */
export const scopeLists = cache(async () => {
  const api = createApi({ baseUrl: API_URL, token: await getSessionToken() });
  const [brands, outlets, me] = await Promise.all([req(api.GET("/v1/brands")), req(api.GET("/v1/outlets")), req(api.GET("/v1/me"))]);
  // Not limited to some outlets: every outlet of the brands listed is in the list, so a brand with none has none.
  return { brands: brands.data, outlets: outlets.data, seesEveryOutlet: me.data.outlet_scope === "*" };
});

/**
 * The scope the page works in: always one brand, and one of its outlets or all of them (see `resolveScope`). What the
 * browser remembered is checked against the register, so an archived brand or another brand's outlet never sticks.
 */
export async function getScope(): Promise<Scope> {
  return (await linkedScope()).scope;
}

/** The scope, and whether a link's `?outlet=` moved it to another brand (`followLink`): the frame then remembers it. */
export const linkedScope = cache(async (): Promise<{ scope: Scope; followed: boolean }> => {
  const [jar, sent] = await Promise.all([cookies(), headers()]);
  const remembered = parseScope(jar.get(SCOPE_COOKIE)?.value);
  try {
    const { brands, outlets, seesEveryOutlet } = await scopeLists();
    const scope = resolveScope(remembered, brands, outlets, seesEveryOutlet);
    const linked = followLink(scope, sent.get(LINK_OUTLET_HEADER), brands, outlets);
    return { scope: linked, followed: linked !== scope };
  } catch {
    // Not signed in, or the register is away: the page's own calls say so.
    return { scope: remembered, followed: false };
  }
});

/** The outlets of the brand in scope: what an outlet picker offers and what "All outlets" covers on a page. */
export async function scopedOutlets() {
  const [{ outlets }, scope] = await Promise.all([scopeLists(), getScope()]);
  return scope.brandId ? outlets.filter((o) => o.brand_id === scope.brandId) : outlets;
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
