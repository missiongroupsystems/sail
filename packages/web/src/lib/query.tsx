"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ApiError } from "./api";

function makeClient(): QueryClient {
  return new QueryClient({
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
};
