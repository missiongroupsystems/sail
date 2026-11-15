"use client";

import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { req } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Product } from "@/lib/api/types";
import { keys } from "@/lib/query";

const PAGE = 200;
const MAX_PAGES = 25;

/** Walks the cursor until the register says there is no more (at most 5,000 products). */
export async function fetchAllProducts(filters: { brand_id?: string; include_archived?: "true" | "false" } = {}): Promise<Product[]> {
  const out: Product[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await req(api.GET("/v1/products", { params: { query: { ...filters, limit: PAGE, cursor } } }));
    out.push(...page.data);
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }
  return out;
}

/** Every product (optionally one brand's), for pickers and name lookups. One query, cached for a minute. */
export function useAllProducts(filters: { brand_id?: string; include_archived?: "true" | "false" } = {}, enabled = true) {
  const query = useQuery({
    queryKey: keys.products({ all: 1, ...filters }),
    queryFn: () => fetchAllProducts(filters),
    staleTime: 60_000,
    enabled,
  });
  const byId = useMemo(() => new Map((query.data ?? []).map((p) => [p.id, p] as const)), [query.data]);
  return { ...query, byId };
}

/** Products by id, one GET each, for the few ids a page shows (stock entries, rule scopes). */
export function useProductsById(ids: string[]) {
  const unique = useMemo(() => Array.from(new Set(ids)).sort(), [ids]);
  const results = useQueries({
    queries: unique.map((id) => ({
      queryKey: keys.product(id),
      queryFn: () => req(api.GET("/v1/products/{id}", { params: { path: { id } } })).then((r) => r.data),
      staleTime: 5 * 60_000,
    })),
  });
  const byId = useMemo(() => {
    const m = new Map<string, Product>();
    results.forEach((r, i) => {
      if (r.data) m.set(unique[i]!, r.data);
    });
    return m;
  }, [results, unique]);
  return { byId, isPending: results.some((r) => r.isPending) };
}

export function productName(byId: Map<string, Product>, id: string): string {
  return byId.get(id)?.name ?? `Product ${id.slice(0, 8)}`;
}
