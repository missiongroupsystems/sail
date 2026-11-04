/** Cookie names shared by the route handlers, the middleware and the server helpers. */
export const SESSION_COOKIE = "sail_session";
export const THEME_COOKIE = "sail_theme";
export const SCOPE_COOKIE = "sail_scope";

export type Theme = "day" | "service";
export type Scope = { brandId: string | null; outletId: string | null };

export const EMPTY_SCOPE: Scope = { brandId: null, outletId: null };

export function parseTheme(value: string | undefined): Theme {
  return value === "service" ? "service" : "day";
}

export function parseScope(value: string | undefined): Scope {
  if (!value) return EMPTY_SCOPE;
  try {
    const parsed = JSON.parse(value) as Partial<Record<keyof Scope, unknown>>;
    return {
      brandId: typeof parsed.brandId === "string" ? parsed.brandId : null,
      outletId: typeof parsed.outletId === "string" ? parsed.outletId : null,
    };
  } catch {
    return EMPTY_SCOPE;
  }
}

/** Twelve hours: the lifetime of a development token. Supabase tokens are shorter; a 401 sends the user back to sign in. */
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
export const PREFS_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
