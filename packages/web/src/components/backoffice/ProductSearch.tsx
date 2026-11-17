"use client";

import { Button, Money, TextField, cx } from "@sail/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
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
  /** Ids already added: they stay in the results, marked "Already added", and cannot be picked again. */
  exclude?: string[];
  /** Products already placed somewhere else (another section of the menu), with where: shown beside the name, still pickable. */
  elsewhere?: Map<string, string>;
  autoFocus?: boolean;
  className?: string;
  /** A problem with what has been added so far ("Add at least one option"), shown under the field. */
  errorMessage?: string;
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
 * Results come from GET /v1/products?q=; picking one calls `onPick` and clears the search for the next one.
 * Up and Down move the highlight and Enter picks the highlighted result, never the form around the field (A P9).
 * A product already added shows as "Already added" rather than vanishing into "No products match" (A P16).
 */
export function ProductSearch({ onPick, label, placeholder = "Search products by name or SKU", brandId, kind, exclude = [], elsewhere, autoFocus, className, errorMessage }: ProductSearchProps) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const query = useDebounced(q.trim(), 200);
  const filters = { q: query, brand_id: brandId ?? undefined, kind, limit: 8 };
  const listId = useId();

  const results = useQuery({
    queryKey: keys.products(filters),
    queryFn: () => req(api.GET("/v1/products", { params: { query: filters } })),
    enabled: query.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  const rows = results.data?.data ?? [];
  const added = (p: Product) => exclude.includes(p.id);
  const pickable = rows.filter((p) => !added(p));
  // The highlight is on a pickable row: the first one until the keys move it.
  const highlighted = pickable[Math.min(active, pickable.length - 1)] ?? null;
  useEffect(() => setActive(0), [query]);

  const pick = (p: Product) => {
    onPick(p);
    setQ("");
    setActive(0);
  };

  return (
    <div className={cx("flex flex-col gap-2", className)}>
      <TextField
        aria-label={label ?? "Search products"}
        label={label}
        type="search"
        value={q}
        onChange={setQ}
        placeholder={placeholder}
        autoFocus={autoFocus}
        isInvalid={Boolean(errorMessage)}
        errorMessage={errorMessage}
        aria-controls={query ? listId : undefined}
        aria-activedescendant={highlighted ? `${listId}-${highlighted.id}` : undefined}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (pickable.length) setActive((i) => (Math.min(i, pickable.length - 1) + (e.key === "ArrowDown" ? 1 : pickable.length - 1)) % pickable.length);
          } else if (e.key === "Enter") {
            // Enter in the search is a pick (or nothing yet), never a submit of the sheet's form.
            e.preventDefault();
            if (highlighted && query === q.trim()) pick(highlighted);
          } else e.continuePropagation();
        }}
      />
      {query ? (
        <ul id={listId} className="flex flex-col rounded-tile hairline bg-surface" aria-label="Results">
          {rows.length === 0 && !results.isPending ? <li className="px-4 py-3 text-caption text-ink-2">No products match “{query}”.</li> : null}
          {rows.map((p) => (
            <li key={p.id} id={`${listId}-${p.id}`} className="hairline-b last:border-b-0">
              <Button
                variant="quiet"
                className={cx("w-full rounded-none text-left font-normal", p.id === highlighted?.id && "bg-surface-2")}
                isDisabled={added(p)}
                onPress={() => pick(p)}
              >
                {/* The row's own full-width box: Button centres its content, and class names are not merged, so a
                    justify-between on the Button itself lost to that and the text sat in the middle. */}
                <span className="flex w-full min-w-0 items-center justify-between gap-2">
                  <span className="min-w-0 truncate">
                    <span className={added(p) ? "text-ink-disabled" : "text-ink"}>{p.name}</span>
                    {p.sku ? <span className="ml-2 text-caption text-ink-2 tabular">{p.sku}</span> : null}
                    {p.archived ? <span className="ml-2 text-caption text-ink-2">archived</span> : null}
                    {!added(p) && elsewhere?.get(p.id) ? <span className="ml-2 text-caption text-ink-2">In {elsewhere.get(p.id)}</span> : null}
                  </span>
                  {added(p) ? <span className="text-caption text-ink-2">Already added</span> : <Money cents={p.price} className="text-ink-2" />}
                </span>
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
