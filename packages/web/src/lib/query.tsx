"use client";

import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ApiError } from "./api";

/**
 * The session ended while the page was open (the register answers 401): go to sign-in with the page to come back to,
 * instead of showing a table's "No products match" as if the data were empty (live-test E-L6).
 */
function toSignIn(error: unknown) {
  if (!(error instanceof ApiError) || error.status !== 401 || typeof window === "undefined") return;
  if (window.location.pathname.startsWith("/login")) return;
  const next = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/login?expired=1&next=${encodeURIComponent(next)}`);
}

function makeClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({ onError: toSignIn }),
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        refetchOnWindowFocus: true,
        // Client errors (4xx) will not fix themselves; try twice on anything else.
        retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
      },
      mutations: { retry: false },
    },
  });
}

export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(makeClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** Query keys, by resource. Invalidate by prefix after a mutation. */
export const keys = {
  merchant: ["merchant"] as const,
  brands: (includeArchived: boolean) => ["brands", { includeArchived }] as const,
  outlets: (includeArchived: boolean) => ["outlets", { includeArchived }] as const,
  stations: (outletId: string) => ["stations", outletId] as const,
  staff: (includeInactive: boolean) => ["staff", { includeInactive }] as const,
  audit: (filters: Record<string, string | undefined>) => ["audit", filters] as const,
  // v0.3 back office
  categories: ["categories"] as const,
  products: (filters: Record<string, string | number | undefined>) => ["products", filters] as const,
  product: (id: string) => ["product", id] as const,
  modifierGroups: ["modifier-groups"] as const,
  menus: (brandId: string | null) => ["menus", { brandId }] as const,
  menu: (id: string) => ["menu", id] as const,
  availability: ["availability-rules"] as const,
  stock: (outletId: string) => ["stock", outletId] as const,
  channelLinks: ["channel-links"] as const,
  areas: (outletId: string) => ["areas", outletId] as const,
  tables: (outletId: string) => ["tables", outletId] as const,
  tenderTypes: ["tender-types"] as const,
  voidReasons: ["void-reasons"] as const,
  customers: (filters: Record<string, string | undefined>) => ["customers", filters] as const,
  customerGroups: ["customer-groups"] as const,
  taxClasses: ["tax-classes"] as const,
  pricingRules: ["pricing-rules"] as const,
  pricingValidation: ["pricing-validation"] as const,
  imports: ["imports"] as const,
  importJob: (id: string) => ["import", id] as const,
  orders: (outletId: string, filters: Record<string, string | undefined>) => ["orders", outletId, filters] as const,
  order: (id: string) => ["order", id] as const,
  outletEvents: (outletId: string) => ["outlet-events", outletId] as const,
};
