"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ApiError } from "./api";

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
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

/** Query keys, by resource and session. */
export const keys = {
  menu: (channelLinkId: string) => ["menu", channelLinkId] as const,
  order: (sessionId: string) => ["order", sessionId] as const,
  receipt: (token: string) => ["receipt", token] as const,
};
