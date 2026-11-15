"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Button, InlineError, MoneyField, Select, Sheet, TagsField, useLocale, FieldsLocked } from "@sail/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { Icon } from "@sail/ui";
import { useEffect, useMemo, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { Warnings } from "@/components/backoffice/Warnings";
import { useAllProducts } from "@/components/backoffice/products";
import { ORDER_TYPES, ORDER_TYPE_LABEL } from "@/components/backoffice/labels";
import { taxClassItems, useTaxClasses } from "@/components/backoffice/tax-classes";
import { RhfSelect, RhfSwitch, RhfTextField } from "@/components/forms/fields";
import { greyPill, greyPillAlert, SheetSection } from "@/components/office/parts";
import { applyServerErrors } from "@/components/office/server-errors";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Brand, Category, PricesByOrderType, Product, ProductCreate } from "@/lib/api/types";
import { keys } from "@/lib/query";
import { categoryLabels } from "./ProductsView";
import { useFreshErrors } from "@/lib/fresh-errors";
import { useCan } from "@/lib/can";

export type ProductSheetState = { mode: "create" } | { mode: "edit"; product: Product } | null;

const NONE = "__none__";
const cents = z.number().int().min(0, "Amounts cannot be negative");

const Schema = z.object({
  name: z.string().trim().min(1, "Enter a name"),
  sku: z.string(),
  kind: z.enum(["product", "component"]),
  kitchen_name: z.string(),
  description: z.string(),
  brand_id: z.string(),
  category_id: z.string(),
  price: cents.nullable().refine((v): boolean => v !== null, "Enter a base price"),
  prices: z.object({ dine_in: cents.nullable(), takeaway: cents.nullable(), pickup: cents.nullable(), delivery: cents.nullable() }),
  tags: z.array(z.string()),
  tax_class_id: z.string(),
  has_deposit: z.boolean(),
  open_price: z.boolean(),
  modifier_group_ids: z.array(z.string()),
});
type Values = z.infer<typeof Schema>;

function defaults(p: Product | null): Values {
  const by = p?.prices_by_order_type ?? {};
  return {
    name: p?.name ?? "",
    sku: p?.sku ?? "",
    kind: p?.kind ?? "product",
    kitchen_name: p?.kitchen_name ?? "",
    description: p?.description ?? "",
    brand_id: p?.brand_id ?? NONE,
    category_id: p?.category_id ?? NONE,
    price: p?.price ?? null,
    prices: { dine_in: by.dine_in ?? null, takeaway: by.takeaway ?? null, pickup: by.pickup ?? null, delivery: by.delivery ?? null },
    tags: p?.tags ?? [],
    tax_class_id: p?.tax_class_id ?? NONE,
    has_deposit: p?.has_deposit ?? false,
    open_price: p?.open_price ?? false,
    modifier_group_ids: p?.modifier_group_ids ?? [],
  };
}

function toBody(v: Values): Omit<ProductCreate, "id"> {
  const by: PricesByOrderType = {};
  for (const t of ORDER_TYPES) {
    const value = v.prices[t];
    if (value !== null) by[t] = value;
  }
  return {
    name: v.name.trim(),
    sku: v.sku.trim() || null,
    kind: v.kind,
    kitchen_name: v.kitchen_name.trim() || null,
    description: v.description.trim() || null,
    brand_id: v.brand_id === NONE ? null : v.brand_id,
    category_id: v.category_id === NONE ? null : v.category_id,
    price: v.price ?? 0,
    prices_by_order_type: by,
    tags: v.tags,
    tax_class_id: v.tax_class_id === NONE ? null : v.tax_class_id,
    has_deposit: v.has_deposit,
    open_price: v.open_price,
    modifier_group_ids: v.modifier_group_ids,
  };
}

export function ProductSheet({ state, onClose, categories, brands }: { state: ProductSheetState; onClose: () => void; categories: Category[]; brands: Brand[] }) {
  const { stamp } = useLocale();
  const qc = useQueryClient();
  const product = state?.mode === "edit" ? state.product : null;
  const form = useForm<Values>({ resolver: zodResolver(Schema), defaultValues: defaults(product) });
  // A second product of the same name is allowed but said, rather than saved silently (live-test E-L15).
  const all = useAllProducts({ include_archived: "false" }, state !== null);
  const typedName = (useWatch({ control: form.control, name: "name" }) ?? "").trim();
  const sameName = typedName ? ((all.data ?? []).find((p) => p.id !== product?.id && p.name.trim().toLowerCase() === typedName.toLowerCase())?.name ?? null) : null;
  const [warnings, setWarnings] = useState<string[]>([]);
  const reset = form.reset;
  useEffect(() => {
    if (state) {
      reset(defaults(state.mode === "edit" ? state.product : null));
      setWarnings([]);
    }
  }, [state, reset]);

  const groups = useQuery({
    queryKey: keys.modifierGroups,
    queryFn: () => req(api.GET("/v1/modifier-groups", { params: { query: { limit: 500 } } })).then((r) => r.data),
    enabled: state !== null,
    staleTime: 60_000,
  });
  const taxClasses = useTaxClasses(state !== null);
  const defaultClass = taxClasses.data?.find((c) => c.is_default);
  const groupName = useMemo(() => new Map((groups.data ?? []).map((g) => [g.id, g.name])), [groups.data]);
  const catLabel = useMemo(() => categoryLabels(categories), [categories]);

  const settle = async (w: string[]) => {
    await qc.invalidateQueries({ queryKey: ["products"] });
    if (product) await qc.invalidateQueries({ queryKey: keys.product(product.id) });
    if (w.length) setWarnings(w);
    else onClose();
  };

  const save = useMutation<{ data: Product; warnings: string[] }, ApiError, Values>({
    mutationFn: async (values) => {
      const body = toBody(values);
      return product ? req(api.PATCH("/v1/products/{id}", { params: { path: { id: product.id } }, body })) : req(api.POST("/v1/products", { body }));
    },
    onSuccess: (res) => settle(res.warnings),
    // A refusal that names a field shows under it; the message also stays at the foot of the form.
    onError: (e) => applyServerErrors(form.setError, e, Object.keys(form.getValues())),
  });
  const archive = useMutation<{ data: Product; warnings: string[] }, ApiError, boolean>({
    mutationFn: (archived) => req(api.PATCH("/v1/products/{id}", { params: { path: { id: product!.id } }, body: { archived } })),
    onSuccess: (res) => settle(res.warnings),
  });
  const busy = save.isPending || archive.isPending;

  const mayEdit = useCan("products.update");
  useFreshErrors(state, form.watch(), save, archive);
  return (
    <FieldsLocked locked={!mayEdit.ok}>
    <Sheet
      isOpen={state !== null}
      onOpenChange={(open) => !open && onClose()}
      isDismissable={!busy}
      title={product ? product.name : "New product"}
      description={product ? (product.archived ? "Archived. Restore it to sell it again." : `Updated ${stamp(product.updated_at)}`) : "A product is anything that can be sold or added as a modifier."}
      footer={
        <>
          {product && mayEdit.ok ? (
            <Button variant="secondary" onPress={() => archive.mutate(!product.archived)} isPending={archive.isPending} isDisabled={save.isPending} className={`mr-auto ${product.archived ? greyPill : greyPillAlert}`}>
              {product.archived ? "Restore product" : "Archive product"}
            </Button>
          ) : null}
          <Button variant="secondary" className={greyPill} onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="product-form" isPending={save.isPending} isDisabled={!mayEdit.ok || archive.isPending}>
            {product ? "Save changes" : "Add product"}
          </Button>
        </>
      }
    >
      <form id="product-form" noValidate onSubmit={form.handleSubmit((v) => save.mutate(v))} className="flex flex-col gap-7">
        <SheetSection title="Details">
          <div className="grid gap-4 sm:grid-cols-[1fr_180px]">
            <RhfTextField control={form.control} name="name" label="Name" placeholder="Iced tea" autoFocus={!product} description={sameName ? `Another product is already called ${sameName}. Two items of one name are hard to tell apart on the POS.` : undefined} />
            <RhfTextField control={form.control} name="sku" label="SKU" description="Matches rows on import." />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <RhfSelect
              control={form.control}
              name="kind"
              label="Kind"
              items={[
                { id: "product", label: "Product", description: "Sold on its own." },
                { id: "component", label: "Component", description: "A modifier option or part; not sold alone." },
              ]}
            />
            <RhfTextField control={form.control} name="kitchen_name" label="Kitchen name" description="Printed on kitchen tickets instead of the name." />
          </div>
          <RhfTextField control={form.control} name="description" label="Description" multiline rows={2} description="Shown to guests in Scan to order." />
          <div className="grid gap-4 sm:grid-cols-2">
            <RhfSelect control={form.control} name="brand_id" label="Brand" items={[{ id: NONE, label: "All brands" }, ...brands.map((b) => ({ id: b.id, label: b.name }))]} />
            <RhfSelect
              control={form.control}
              name="category_id"
              label="Category"
              items={[{ id: NONE, label: "No category" }, ...categories.filter((c) => !c.archived).map((c) => ({ id: c.id, label: catLabel.get(c.id) ?? c.name }))]}
            />
          </div>
        </SheetSection>

        <SheetSection title="Prices" hint="The base price applies unless an order type has its own. Open-price items ask for the amount at the register.">
          <div className="grid gap-4">
            <Controller
              control={form.control}
              name="price"
              render={({ field, fieldState }) => <MoneyField label="Base price" value={field.value} onChange={field.onChange} onBlur={field.onBlur} isInvalid={!!fieldState.error} errorMessage={fieldState.error?.message} />}
            />
            <div className="grid grid-cols-2 gap-3">
              {ORDER_TYPES.map((t) => (
                <Controller
                  key={t}
                  control={form.control}
                  name={`prices.${t}`}
                  render={({ field, fieldState }) => (
                    <MoneyField label={ORDER_TYPE_LABEL[t]} value={field.value} onChange={field.onChange} onBlur={field.onBlur} placeholder="base" isInvalid={!!fieldState.error} errorMessage={fieldState.error?.message} />
                  )}
                />
              ))}
            </div>
          </div>
          <div className="grid gap-x-6 sm:grid-cols-2">
            <RhfSwitch control={form.control} name="open_price" description="Staff key in the price when they add it.">
              Open price
            </RhfSwitch>
            <RhfSwitch control={form.control} name="has_deposit" description="A deposit rule (scope: deposit items) applies to this item.">
              Deposit item
            </RhfSwitch>
          </div>
        </SheetSection>

        <SheetSection title="Tax">
          <RhfSelect
            control={form.control}
            name="tax_class_id"
            label="Tax class"
            items={[{ id: NONE, label: defaultClass ? `Merchant default (${defaultClass.name})` : "Merchant default", description: "Follows the default class if it changes." }, ...taxClassItems(taxClasses.data ?? [], product?.tax_class_id ?? null)]}
            description="Sets the tax rates this item is charged at."
            className="sm:max-w-[360px]"
          />
        </SheetSection>

        <SheetSection title="Tags" hint="Tags drive pricing scopes and menu filters.">
          <Controller control={form.control} name="tags" render={({ field }) => <TagsField aria-label="Tags" value={field.value} onChange={field.onChange} />} />
        </SheetSection>

        <SheetSection flat title="Modifier groups" hint="Shown in this order when the item is added. Required groups come first on the POS.">
          <Controller
            control={form.control}
            name="modifier_group_ids"
            render={({ field }) => {
              const ids = field.value;
              const move = (i: number, d: -1 | 1) => {
                const next = [...ids];
                const j = i + d;
                if (j < 0 || j >= next.length) return;
                [next[i], next[j]] = [next[j]!, next[i]!];
                field.onChange(next);
              };
              return (
                <div className="flex flex-col gap-3">
                  {ids.length === 0 ? <p className="rounded-panel border border-dashed border-rule-dashed px-4 py-3 text-[13px] text-ink-3">No modifier groups attached.</p> : null}
                  {ids.length > 0 ? <ol className="flex flex-col rounded-panel border border-rule">
                    {ids.map((id, i) => (
                      <li key={id} className="flex items-center gap-2 border-b border-rule-subtle py-1 pr-2 pl-4 last:border-b-0">
                        <span className="w-6 text-[13px] text-ink-3 tabular">{i + 1}.</span>
                        <span className="min-w-0 flex-1 truncate text-ink">{groupName.get(id) ?? id}</span>
                        <Button variant="quiet" iconOnly aria-label="Move up" onPress={() => move(i, -1)} isDisabled={i === 0 || !mayEdit.ok}>
                          <Icon icon={ArrowUp} size={16} />
                        </Button>
                        <Button variant="quiet" iconOnly aria-label="Move down" onPress={() => move(i, 1)} isDisabled={i === ids.length - 1 || !mayEdit.ok}>
                          <Icon icon={ArrowDown} size={16} />
                        </Button>
                        <Button variant="quiet" iconOnly aria-label={`Remove ${groupName.get(id) ?? "group"}`} isDisabled={!mayEdit.ok} onPress={() => field.onChange(ids.filter((x) => x !== id))}>
                          <Icon icon={X} size={16} />
                        </Button>
                      </li>
                    ))}
                  </ol> : null}
                  <Select
                    aria-label="Attach a modifier group"
                    placeholder="Attach a modifier group…"
                    selectedKey={null}
                    onSelectionChange={(k) => k && !ids.includes(k) && field.onChange([...ids, k])}
                    items={(groups.data ?? []).filter((g) => !g.archived && !ids.includes(g.id)).map((g) => ({ id: g.id, label: g.name, description: `${g.options.length} options` }))}
                    className="sm:max-w-[360px]"
                  />
                </div>
              );
            }}
          />
        </SheetSection>

        <Warnings warnings={warnings} />
        {mayEdit.reason ? <p className="text-body text-ink-2">{mayEdit.reason}</p> : null}
        <InlineError error={save.error ?? archive.error} />
      </form>
    </Sheet>
    </FieldsLocked>
  );
}
