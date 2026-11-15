"use client";

import { Button, Money, TextField, cx } from "@sail/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { req } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Product } from "@/lib/api/types";
import { keys } from "@/lib/query";

export type ProductSearchProps = {
  onPick: (product: Product) => void;
  label?: string;
  placeholder?: string;
  brandId?: string | null;
  kind?: "product" | "component";
  /** Ids to leave out of the results (already added). */
  exclude?: string[];
  /** Keep the typed text after a pick (adding several in a row). */
  keepQuery?: boolean;
  autoFocus?: boolean;
  className?: string;
};

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Server-side product search (SearchField, empty / typing / no results).
 * Results come from GET /v1/products?q=; picking one calls `onPick`.
 */
export function ProductSearch({ onPick, label, placeholder = "Search products by name or SKU", brandId, kind, exclude = [], keepQuery, autoFocus, className }: ProductSearchProps) {
  const [q, setQ] = useState("");
  const query = useDebounced(q.trim(), 200);
  const filters = { q: query, brand_id: brandId ?? undefined, kind, limit: 8 };

  const results = useQuery({
    queryKey: keys.products(filters),
    queryFn: () => req(api.GET("/v1/products", { params: { query: filters } })),
    enabled: query.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  const rows = (results.data?.data ?? []).filter((p) => !exclude.includes(p.id));

  return (
    <div className={cx("flex flex-col gap-2", className)}>
      <TextField aria-label={label ?? "Search products"} label={label} type="search" value={q} onChange={setQ} placeholder={placeholder} autoFocus={autoFocus} />
      {query ? (
        <ul className="flex flex-col rounded-tile hairline bg-surface" aria-label="Results">
          {rows.length === 0 && !results.isPending ? <li className="px-3 py-3 text-caption text-ink-2">No products match “{query}”.</li> : null}
          {rows.map((p) => (
            <li key={p.id} className="hairline-b last:border-b-0">
              <Button
                variant="quiet"
                className="w-full justify-between rounded-none px-3 text-left font-normal"
                onPress={() => {
                  onPick(p);
                  if (!keepQuery) setQ("");
                }}
              >
                <span className="min-w-0 truncate">
                  <span className="text-ink">{p.name}</span>
                  {p.sku ? <span className="ml-2 text-caption text-ink-2 tabular">{p.sku}</span> : null}
                  {p.archived ? <span className="ml-2 text-caption text-ink-2">archived</span> : null}
                </span>
                <Money cents={p.price} className="text-ink-2" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
