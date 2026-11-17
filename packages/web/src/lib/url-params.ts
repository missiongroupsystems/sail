/** Server-side reading of a page's address state (see `useUrlState`). */
export type PageSearchParams = Promise<Record<string, string | string[] | undefined>>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** One query value as a string, or null. */
export function param(params: Record<string, string | string[] | undefined>, name: string): string | null {
  const v = params[name];
  return typeof v === "string" && v ? v : null;
}

/** A YYYY-MM-DD query value, or null. */
export function dateParam(params: Record<string, string | string[] | undefined>, name: string): string | null {
  const v = param(params, name);
  return v && DATE.test(v) ? v : null;
}

/** The report's outlet: the scoped outlet first, then `?outlet=` when it is one of the merchant's, then the first. */
export function reportOutlet(outlets: { id: string }[], scopedOutletId: string | null, params: Record<string, string | string[] | undefined>): string | null {
  const asked = param(params, "outlet");
  return outlets.find((o) => o.id === scopedOutletId)?.id ?? outlets.find((o) => o.id === asked)?.id ?? outlets[0]?.id ?? null;
}
