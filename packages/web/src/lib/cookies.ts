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

/**
 * The scope a page works in, from what the browser remembered and what the register has now.
 * There is always one brand: the remembered one, or (nothing remembered, or a brand since archived or out of this
 * person's reach) the merchant's only brand, or its first by name. The outlet is one of that brand's, or none, which
 * reads "All outlets of <brand>". `brandId` is null only for a merchant with no brand at all.
 */
export function resolveScope(remembered: Scope, brands: { id: string; name: string; archived?: boolean }[], outlets: { id: string; brand_id: string; archived?: boolean }[]): Scope {
  const live = brands.filter((b) => !b.archived).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const brand = live.find((b) => b.id === remembered.brandId) ?? live[0] ?? null;
  if (!brand) return EMPTY_SCOPE;
  const outlet = outlets.find((o) => o.id === remembered.outletId && o.brand_id === brand.id && !o.archived) ?? null;
  return { brandId: brand.id, outletId: outlet?.id ?? null };
}

/** Twelve hours: the lifetime of a back-office session from the register. External-provider tokens are shorter; a 401 sends the user back to sign in. */
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
export const PREFS_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/** A request header the middleware sets to the page's path (read by the refusal page). */
export const PATH_HEADER = "x-sail-path";
