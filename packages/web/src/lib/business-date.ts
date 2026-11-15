"use client";

import { useQuery } from "@tanstack/react-query";
import { req } from "./api";
import { api } from "./api.browser";

/**
 * The business date the register dates new orders on at an outlet: it rolls over at the outlet's cutoff, and moves to
 * the next day once today has been closed early. Never the browser's calendar date, which differs after midnight.
 */
export function useBusinessDate(outletId: string | null): string | null {
  const q = useQuery({
    queryKey: ["business-date", outletId ?? ""],
    queryFn: () => req(api.GET("/v1/outlets/{id}/floor", { params: { path: { id: outletId! } } })).then((r) => (r.data as unknown as { business_date: string }).business_date),
    enabled: outletId !== null,
    staleTime: 60_000,
  });
  return q.data ?? null;
}
