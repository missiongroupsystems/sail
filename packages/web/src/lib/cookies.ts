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
 * person's reach) the merchant's only brand, or its first by name. A brand is in reach when it is live and owns at
 * least one of the outlets this person can see; a merchant with no outlet yet falls back to its live brands. The
 * outlet is one of that brand's, or none, which reads "All outlets of <brand>". `brandId` is null only for a merchant
 * with no brand at all.
 */
export function resolveScope(remembered: Scope, brands: { id: string; name: string; archived?: boolean }[], outlets: { id: string; brand_id: string; archived?: boolean }[]): Scope {
  const live = brands.filter((b) => !b.archived).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const owning = new Set(outlets.map((o) => o.brand_id));
  const reach = outlets.length ? live.filter((b) => owning.has(b.id)) : live;
  const brand = reach.find((b) => b.id === remembered.brandId) ?? reach[0] ?? null;
  if (!brand) return EMPTY_SCOPE;
  const outlet = outlets.find((o) => o.id === remembered.outletId && o.brand_id === brand.id && !o.archived) ?? null;
  return { brandId: brand.id, outletId: outlet?.id ?? null };
}

/** Twelve hours: the lifetime of a back-office session from the register. External-provider tokens are shorter; a 401 sends the user back to sign in. */
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
export const PREFS_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/** A request header the middleware sets to the page's path (read by the refusal page). */
export const PATH_HEADER = "x-sail-path";
/** A request header the middleware sets to a link's `?outlet=` (read by `getScope`). */
export const LINK_OUTLET_HEADER = "x-sail-link-outlet";

/**
 * A link that names an outlet of a brand other than the one in scope (a shared report, say) takes the scope to that
 * outlet and its brand, when the person can see the outlet and its brand is live. Otherwise the scope stands and the
 * link's outlet is ignored. An outlet of the brand already in scope is left to the page, as before.
 */
export function followLink(scope: Scope, linkOutletId: string | null, brands: { id: string; archived?: boolean }[], outlets: { id: string; brand_id: string; archived?: boolean }[]): Scope {
  const outlet = outlets.find((o) => o.id === linkOutletId && !o.archived);
  if (!outlet || outlet.brand_id === scope.brandId || !brands.some((b) => b.id === outlet.brand_id && !b.archived)) return scope;
  return { brandId: outlet.brand_id, outletId: outlet.id };
}
