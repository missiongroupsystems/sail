"use client";

import { Badge, Button, DataTable, EmptyState, InlineError, Money, Pill, Select, Switch, TextField, type DataTableColumn } from "@sail/ui";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@sail/ui";
import { req } from "@/lib/api";
import { api } from "@/lib/api.browser";
import { Quiet, TwoLine } from "@/components/office/parts";
import type { Brand, Category, Product, ProductPage } from "@/lib/api/types";
import type { Scope } from "@/lib/cookies";
import { keys } from "@/lib/query";
import { BulkPriceSheet } from "./BulkPriceSheet";
import { ProductSheet, type ProductSheetState } from "./ProductSheet";

const ANY = "__any__";
const PAGE = 50;

type Filters = { q?: string; brand_id?: string; category_id?: string; tag?: string; kind?: "product" | "component"; include_archived?: "true" | "false" };

/** "Parent › Child" labels for the two-level category tree. */
export function categoryLabels(categories: Category[]): Map<string, string> {
  const byId = new Map(categories.map((c) => [c.id, c] as const));
  return new Map(
    categories.map((c) => {
      const parent = c.parent_id ? byId.get(c.parent_id) : null;
      return [c.id, parent ? `${parent.name} › ${c.name}` : c.name] as const;
    }),
  );
}

function useDebounced(value: string, ms = 250): string {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function ProductsView({ initialPage, categories, brands, scope }: { initialPage: ProductPage; categories: Category[]; brands: Brand[]; scope: Scope }) {
  const [q, setQ] = useState("");
  const [tag, setTag] = useState("");
  const [brandId, setBrandId] = useState<string | null>(scope.brandId);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [kind, setKind] = useState<"product" | "component" | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [sheet, setSheet] = useState<ProductSheetState>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Map<string, Product>>(new Map());
  const [bulkOpen, setBulkOpen] = useState(false);
  useEffect(() => setBrandId(scope.brandId), [scope.brandId]);

  const dq = useDebounced(q.trim());
  const dtag = useDebounced(tag.trim());
  const filters: Filters = useMemo(
    () => ({
      q: dq || undefined,
      brand_id: brandId ?? undefined,
      category_id: categoryId ?? undefined,
      tag: dtag || undefined,
      kind: kind ?? undefined,
      include_archived: showArchived ? "true" : undefined,
    }),
    [dq, brandId, categoryId, dtag, kind, showArchived],
  );
  const isInitial = !filters.q && !filters.category_id && !filters.tag && !filters.kind && !filters.include_archived && (filters.brand_id ?? null) === (scope.brandId ?? null);

  const pages = useInfiniteQuery({
    queryKey: keys.products(filters),
    queryFn: ({ pageParam }) => req(api.GET("/v1/products", { params: { query: { ...filters, limit: PAGE, cursor: pageParam } } })),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
    initialData: isInitial ? { pages: [initialPage], pageParams: [undefined] } : undefined,
  });

  const rows = pages.data?.pages.flatMap((p) => p.data) ?? [];
  const total = pages.data?.pages[0]?.total ?? 0;
  const catLabel = useMemo(() => categoryLabels(categories), [categories]);
  const brandName = useMemo(() => new Map(brands.map((b) => [b.id, b.name])), [brands]);

  const toggle = (p: Product) =>
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(p.id)) next.delete(p.id);
      else next.set(p.id, p);
      return next;
    });

  const columns: DataTableColumn<Product>[] = [
    ...(selecting
      ? [
          {
            key: "selected",
            header: "",
            width: 44,
            render: (p: Product) => (
              <span aria-label={selected.has(p.id) ? "Selected" : "Not selected"} className={`inline-flex size-5 items-center justify-center rounded-[5px] hairline ${selected.has(p.id) ? "bg-primary text-on-primary" : "bg-surface"}`}>
                {selected.has(p.id) ? <Icon icon={Check} size={14} /> : null}
              </span>
            ),
          } satisfies DataTableColumn<Product>,
        ]
      : []),
    {
      key: "name",
      header: "Name",
      isRowHeader: true,
      width: "2fr",
      render: (p) => <TwoLine primary={p.name} meta={p.kitchen_name && p.kitchen_name !== p.name ? `Kitchen: ${p.kitchen_name}` : undefined} />,
    },
    { key: "sku", header: "SKU", render: (p) => <span className="text-ink-2 tabular break-words">{p.sku ?? "—"}</span> },
    {
      key: "kind",
      header: "Kind",
      render: (p) => (
        <Pill size="sm" tone={p.kind === "component" ? "seated" : "neutral"}>
          {p.kind === "component" ? "Component" : "Product"}
        </Pill>
      ),
    },
    { key: "category_id", header: "Category", render: (p) => <Quiet>{p.category_id ? catLabel.get(p.category_id) ?? "—" : "—"}</Quiet> },
    { key: "brand_id", header: "Brand", hideBelow: "xl", render: (p) => <Quiet className="whitespace-nowrap">{p.brand_id ? brandName.get(p.brand_id) ?? "—" : "All brands"}</Quiet> },
    {
      key: "tags",
      header: "Tags",
      render: (p) => (
        <span className="flex flex-wrap gap-1">
          {p.tags.map((t) => (
            <Badge key={t}>{t}</Badge>
          ))}
          {p.has_deposit ? <Badge tone="seated">Deposit</Badge> : null}
          {p.open_price ? <Badge tone="sent">Open price</Badge> : null}
        </span>
      ),
    },
    {
      key: "price",
      header: "Price",
      numeric: true,
      render: (p) => (
        <span className="inline-flex flex-col items-end">
          <Money cents={p.price} />
          {Object.keys(p.prices_by_order_type).length ? <span className="text-[12px] text-ink-3">+{Object.keys(p.prices_by_order_type).length} by order type</span> : null}
        </span>
      ),
    },
    {
      key: "archived",
      header: "Status",
      render: (p) =>
        p.archived ? (
          <Pill size="sm" tone="neutral">
            Archived
          </Pill>
        ) : (
          <Pill size="sm" tone="paid">
            Active
          </Pill>
        ),
    },
  ];

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <TextField size="sm" aria-label="Search products" type="search" value={q} onChange={setQ} placeholder="Search name or SKU" className="w-full sm:w-[150px] xl:w-[180px]" />
        {/* A merchant with one brand has nothing to filter by brand; leaving it out keeps the actions on the row at 1024px. */}
        {brands.length > 1 ? (
        <Select
          aria-label="Brand"
          variant="toolbar" size="sm"
          selectedKey={brandId ?? ANY}
          onSelectionChange={(k) => setBrandId(k === ANY ? null : k)}
          items={[{ id: ANY, label: "All brands" }, ...brands.map((b) => ({ id: b.id, label: b.name }))]}
        />
        ) : null}
        <Select
          aria-label="Category"
          variant="toolbar" size="sm"
          selectedKey={categoryId ?? ANY}
          onSelectionChange={(k) => setCategoryId(k === ANY ? null : k)}
          items={[{ id: ANY, label: "All categories" }, ...categories.filter((c) => !c.archived).map((c) => ({ id: c.id, label: catLabel.get(c.id) ?? c.name }))]}
        />
        <Select
          aria-label="Kind"
          variant="toolbar" size="sm"
          selectedKey={kind ?? ANY}
          onSelectionChange={(k) => setKind(k === ANY || k === null ? null : (k as "product" | "component"))}
          items={[
            { id: ANY, label: "All kinds" },
            { id: "product", label: "Products only" },
            { id: "component", label: "Components only", description: "Modifier options and parts of other items." },
          ]}
        />
        <TextField size="sm" aria-label="Tag" value={tag} onChange={setTag} placeholder="Tag" className="w-[80px] xl:w-[96px]" />
        {/* "Archived" alone below 1280px keeps Bulk price edit and Add product on the row at 1024. */}
        <Switch isSelected={showArchived} onChange={setShowArchived} aria-label="Show archived" className="min-h-11 py-0">
          <span className="xl:hidden">Archived</span>
          <span className="max-xl:hidden">Show archived</span>
        </Switch>
        <div className="ml-auto flex items-center gap-2">
          {selecting ? (
            <>
              <span className="text-caption text-ink-2 tabular">{selected.size} selected</span>
              <Button size="sm" variant="quiet" onPress={() => { setSelecting(false); setSelected(new Map()); }}>
                Done selecting
              </Button>
              <Button size="sm" variant="primary" isDisabled={selected.size === 0} onPress={() => setBulkOpen(true)}>
                Set prices for {selected.size}
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" onPress={() => setSelecting(true)}>Bulk price edit</Button>
              <Button size="sm" variant="primary" onPress={() => setSheet({ mode: "create" })}>
                Add product
              </Button>
            </>
          )}
        </div>
      </div>

      <DataTable
        aria-label="Products"
        columns={columns}
        rows={rows}
        rowKey={(p) => p.id}
        isLoading={pages.isPending}
        className={pages.isPlaceholderData ? "opacity-60" : undefined}
        onRowAction={(p) => (selecting ? toggle(p) : setSheet({ mode: "edit", product: p }))}
        rowClassName={(p) => (p.archived ? "text-ink-2" : undefined)}
        emptyState={<EmptyState variant="centred" title="No products match" hint={rows.length === 0 && total === 0 && isInitial ? "Tap Add product, or import a legacy export under Import. A product reaches the POS once it is in a section of a menu (Menu › Menus & sections) and that menu is linked in Settings › Channels." : "Widen the filters or clear the search."} />}
      />
      <InlineError error={pages.error} className="mt-4" />

      <div className="mt-4 flex items-center gap-4">
        {pages.hasNextPage ? (
          <Button onPress={() => pages.fetchNextPage()} isPending={pages.isFetchingNextPage}>
            Show more
          </Button>
        ) : null}
        <span className="text-[13px] text-ink-2 tabular">
          {rows.length} of {total} {total === 1 ? "product" : "products"}
        </span>
      </div>

      <ProductSheet state={sheet} onClose={() => setSheet(null)} categories={categories} brands={brands} />
      <BulkPriceSheet
        isOpen={bulkOpen}
        products={Array.from(selected.values())}
        onClose={() => setBulkOpen(false)}
        onSaved={() => {
          setBulkOpen(false);
          setSelecting(false);
          setSelected(new Map());
        }}
      />
    </>
  );
}
