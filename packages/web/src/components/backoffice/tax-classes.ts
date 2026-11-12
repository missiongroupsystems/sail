"use client";

import { useQuery } from "@tanstack/react-query";
import { req } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { TaxClass, TaxComponent } from "@/lib/api/types";
import { keys } from "@/lib/query";

/** Every tax class with its rates, archived ones included, so a product or fee on an archived class still shows its name. */
export function useTaxClasses(enabled = true) {
  return useQuery({
    queryKey: keys.taxClasses,
    queryFn: () => req(api.GET("/v1/tax-classes", { params: { query: { include_archived: "true" } } })).then((r) => r.data),
    enabled,
    staleTime: 60_000,
  });
}

/** "VAT 20%", "State sales tax + Local sales tax", or "Exempt" for no components. */
export function componentsText(components: TaxComponent[]): string {
  return components.length ? components.map((c) => c.name).join(" + ") : "Exempt";
}

/** The class's rate for every outlet and order type. */
export function defaultRate(c: TaxClass): TaxClass["rates"][number] | undefined {
  return c.rates.find((r) => r.outlet_id === null && r.order_type === null);
}

/** Select items for a tax class picker: active classes, plus `currentId` when it has since been archived. */
export function taxClassItems(classes: TaxClass[], currentId: string | null): { id: string; label: string; description: string }[] {
  return classes
    .filter((c) => !c.archived || c.id === currentId)
    .map((c) => ({ id: c.id, label: c.archived ? `${c.name} (archived)` : c.name, description: componentsText(defaultRate(c)?.components ?? []) }));
}
