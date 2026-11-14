"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Button, Checkbox, DataTable, EmptyState, Icon, InlineError, Money, MoneyField, Select, Sheet, Switch, type DataTableColumn, Pill } from "@sail/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { greyPill, greyPillAlert, Quiet, SheetSection, TwoLine } from "@/components/office/parts";
import { applyServerErrors } from "@/components/office/server-errors";
import { ProductSearch } from "@/components/backoffice/ProductSearch";
import { Warnings } from "@/components/backoffice/Warnings";
import { productName, useProductsById } from "@/components/backoffice/products";
import { RhfTextField } from "@/components/forms/fields";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { ModifierGroup, ModifierGroupCreate } from "@/lib/api/types";
import { keys } from "@/lib/query";
import { useFreshErrors } from "@/lib/fresh-errors";
import { useCan } from "@/lib/can";

type SheetState = { mode: "create" } | { mode: "edit"; group: ModifierGroup } | null;
const NONE = "__none__";

const intField = (min: number, msg: string) => z.string().refine((v): boolean => v === "" || (/^\d+$/.test(v) && Number(v) >= min), msg);

const Schema = z
  .object({
    name: z.string().trim().min(1, "Enter a name"),
    min_select: intField(0, "A whole number, 0 or more"),
    max_select: intField(1, "A whole number, 1 or more, or empty for no limit"),
    max_per_modifier: intField(1, "A whole number, 1 or more"),
    options: z.array(
      z.object({
        product_id: z.string(),
        price_override: z.number().int().min(0, "An override cannot be below zero. Leave it empty to use the product's price.").nullable(),
        child_group_id: z.string().nullable(),
        is_default: z.boolean(),
      }),
    ),
  })
  .superRefine((v, ctx) => {
    if (v.max_select !== "" && v.min_select !== "" && Number(v.max_select) < Number(v.min_select)) ctx.addIssue({ code: "custom", path: ["max_select"], message: "Maximum cannot be below the minimum" });
  });
type Values = z.infer<typeof Schema>;

function defaults(g: ModifierGroup | null): Values {
  return {
    name: g?.name ?? "",
    min_select: String(g?.min_select ?? 0),
    max_select: g?.max_select === null || g?.max_select === undefined ? "" : String(g.max_select),
    max_per_modifier: String(g?.max_per_modifier ?? 1),
    options: (g?.options ?? []).slice().sort((a, b) => a.sort - b.sort).map((o) => ({ product_id: o.product_id, price_override: o.price_override, child_group_id: o.child_group_id, is_default: o.is_default })),
  };
}

function toBody(v: Values): Omit<ModifierGroupCreate, "id"> {
  return {
    name: v.name.trim(),
    min_select: Number(v.min_select || 0),
    max_select: v.max_select === "" ? null : Number(v.max_select),
    max_per_modifier: Number(v.max_per_modifier || 1),
    options: v.options.map((o, i) => ({ product_id: o.product_id, price_override: o.price_override, child_group_id: o.child_group_id, is_default: o.is_default, sort: i })),
  };
}

function rule(g: ModifierGroup): string {
  if (g.max_select === 1 && g.min_select === 1) return "Choose 1";
  if (g.min_select === 0 && g.max_select === null) return "Choose any";
  if (g.min_select === 0) return `Choose up to ${g.max_select}`;
  if (g.max_select === null) return `Choose at least ${g.min_select}`;
  if (g.min_select === g.max_select) return `Choose ${g.min_select}`;
  return `Choose ${g.min_select}–${g.max_select}`;
}

export function ModifierGroupsView({ initialGroups }: { initialGroups: ModifierGroup[] }) {
  const canCreate = useCan("modifier_groups.create");
  const [showArchived, setShowArchived] = useState(false);
  const [sheet, setSheet] = useState<SheetState>(null);

  const groups = useQuery({
    queryKey: keys.modifierGroups,
    queryFn: () => req(api.GET("/v1/modifier-groups", { params: { query: { include_archived: "true", limit: 500 } } })).then((r) => r.data),
    initialData: initialGroups,
  });
  const rows = groups.data.filter((g) => showArchived || !g.archived);

  const columns: DataTableColumn<ModifierGroup>[] = [
    { key: "name", header: "Name", sortable: true, isRowHeader: true, width: "2fr", render: (g) => <TwoLine primary={g.name} meta={g.options.some((o) => o.child_group_id) ? "Has nested groups" : undefined} /> },
    { key: "rule", header: "Rule", render: (g) => <Quiet>{rule(g)}</Quiet> },
    { key: "max_per_modifier", header: "Max per option", numeric: true, render: (g) => g.max_per_modifier },
    { key: "options", header: "Options", numeric: true, sortable: true, sortValue: (g) => g.options.length, render: (g) => g.options.length },
    { key: "nested", header: "Nested", render: (g) => (g.options.some((o) => o.child_group_id) ? "Yes" : "—") },
    { key: "archived", header: "Status", sortable: true, sortValue: (g) => (g.archived ? 1 : 0), render: (g) => (g.archived ? <Pill size="sm" tone="neutral">Archived</Pill> : <Pill size="sm" tone="paid">Active</Pill>) },
  ];

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-ink-2 tabular">
          {rows.length} {rows.length === 1 ? "group" : "groups"}
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <Switch isSelected={showArchived} onChange={setShowArchived} className="min-h-11 py-0">
            Show archived
          </Switch>
          {canCreate.ok ? (
            <Button size="sm" variant="primary" onPress={() => setSheet({ mode: "create" })}>
            Add modifier group
          </Button>
          ) : null}
        </div>
      </div>
      <DataTable
        aria-label="Modifier groups"
        columns={columns}
        rows={rows}
        rowKey={(g) => g.id}
        defaultSort={{ column: "name", direction: "ascending" }}
        onRowAction={(g) => setSheet({ mode: "edit", group: g })}
        rowClassName={(g) => (g.archived ? "text-ink-2" : undefined)}
        emptyState={<EmptyState variant="centred" title="No modifier groups yet" hint="Tap Add modifier group. Options are products of kind Component." />}
      />
      <GroupSheet state={sheet} groups={groups.data} onClose={() => setSheet(null)} />
    </>
  );
}

function GroupSheet({ state, groups, onClose }: { state: SheetState; groups: ModifierGroup[]; onClose: () => void }) {
  const qc = useQueryClient();
  const group = state?.mode === "edit" ? state.group : null;
  const form = useForm<Values>({ resolver: zodResolver(Schema), defaultValues: defaults(group) });
  const [warnings, setWarnings] = useState<string[]>([]);
  const reset = form.reset;
  useEffect(() => {
    if (state) {
      reset(defaults(state.mode === "edit" ? state.group : null));
      setWarnings([]);
    }
  }, [state, reset]);

  const options = form.watch("options");
  const { byId } = useProductsById(options.map((o) => o.product_id));
  const otherGroups = useMemo(() => groups.filter((g) => !g.archived && g.id !== group?.id), [groups, group]);

  const settle = async (w: string[]) => {
    await qc.invalidateQueries({ queryKey: keys.modifierGroups });
    if (w.length) setWarnings(w);
    else onClose();
  };
  const save = useMutation<{ data: ModifierGroup; warnings: string[] }, ApiError, Values>({
    mutationFn: (v) => (group ? req(api.PATCH("/v1/modifier-groups/{id}", { params: { path: { id: group.id } }, body: toBody(v) })) : req(api.POST("/v1/modifier-groups", { body: toBody(v) }))),
    onSuccess: (r) => settle(r.warnings),
    // A refusal that names a field shows under it; the message also stays at the foot of the form.
    onError: (e) => applyServerErrors(form.setError, e, Object.keys(form.getValues())),
  });
  const archive = useMutation<{ data: ModifierGroup; warnings: string[] }, ApiError, boolean>({
    mutationFn: (archived) => req(api.PATCH("/v1/modifier-groups/{id}", { params: { path: { id: group!.id } }, body: { archived } })),
    onSuccess: (r) => settle(r.warnings),
  });
  const busy = save.isPending || archive.isPending;

  const mayEdit = useCan("modifier_groups.update");
  useFreshErrors(state, form.watch(), save, archive);
  return (
    <Sheet
      isOpen={state !== null}
      onOpenChange={(open) => !open && onClose()}
      isDismissable={!busy}
      width="lg"
      title={group ? group.name : "New modifier group"}
      description={group ? rule(group) : "Options a guest chooses when adding an item: sizes, sides, milk, spice level."}
      footer={
        <>
          {group ? (
            <Button variant="secondary" onPress={() => archive.mutate(!group.archived)} isPending={archive.isPending} isDisabled={save.isPending} className={`mr-auto ${group.archived ? greyPill : greyPillAlert}`}>
              {group.archived ? "Restore group" : "Archive group"}
            </Button>
          ) : null}
          <Button variant="secondary" className={greyPill} onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="group-form" isPending={save.isPending} isDisabled={!mayEdit.ok || archive.isPending}>
            {group ? "Save changes" : "Add modifier group"}
          </Button>
        </>
      }
    >
      <form id="group-form" noValidate onSubmit={form.handleSubmit((v) => save.mutate(v))} className="flex flex-col gap-8">
        <SheetSection>
          <RhfTextField control={form.control} name="name" label="Name" placeholder="Milk" autoFocus={!group} />
          <div className="grid gap-4 sm:grid-cols-3">
            <RhfTextField control={form.control} name="min_select" label="Minimum choices" numeric inputMode="numeric" description="0 makes the group optional." />
            <RhfTextField control={form.control} name="max_select" label="Maximum choices" numeric inputMode="numeric" placeholder="No limit" />
            <RhfTextField control={form.control} name="max_per_modifier" label="Max per option" numeric inputMode="numeric" description="How many times one option can be chosen." />
          </div>
        </SheetSection>

        <SheetSection flat title="Options" hint="Each option is a product (usually a component). The override replaces the product's price when chosen here.">
          <Controller
            control={form.control}
            name="options"
            render={({ field }) => {
              const list = field.value;
              const update = (i: number, patch: Partial<Values["options"][number]>) => field.onChange(list.map((o, j) => (j === i ? { ...o, ...patch } : o)));
              const move = (i: number, d: -1 | 1) => {
                const j = i + d;
                if (j < 0 || j >= list.length) return;
                const next = [...list];
                [next[i], next[j]] = [next[j]!, next[i]!];
                field.onChange(next);
              };
              return (
                <div className="flex flex-col gap-4">
                  {list.length === 0 ? <p className="rounded-panel border border-dashed border-rule-dashed px-4 py-3 text-[13px] text-ink-3">No options yet. Search a product below to add one.</p> : null}
                  {list.length ? (
                    <div className="overflow-x-auto rounded-panel border border-rule">
                      <table className="w-full text-[14px] leading-5">
                        <thead>
                          <tr className="text-left text-[12.5px] text-ink-3">
                            <th className="px-3 py-2 font-medium border-b border-rule-subtle">Option</th>
                            <th className="px-3 py-2 font-medium border-b border-rule-subtle">Price override</th>
                            <th className="px-3 py-2 font-medium border-b border-rule-subtle">Default</th>
                            <th className="px-3 py-2 font-medium border-b border-rule-subtle">Nested group</th>
                            <th className="px-3 py-2 font-medium border-b border-rule-subtle">
                              <span className="sr-only">Order</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {list.map((o, i) => {
                            const p = byId.get(o.product_id);
                            return (
                              <tr key={`${o.product_id}-${i}`} className="border-b border-rule-subtle align-middle last:border-b-0">
                                <td className="py-2 pr-2 pl-3">
                                  <span className="font-medium text-ink break-words">{productName(byId, o.product_id)}</span>
                                  {p ? (
                                    <span className="block text-[12px] text-ink-3">
                                      Product price <Money cents={p.price} />
                                    </span>
                                  ) : null}
                                </td>
                                <td className="py-2 pr-2 pl-3">
                                  {/* A refused override says why at the field rather than the form failing silently (live-test E-M9). */}
                                  <MoneyField aria-label={`Price override for ${productName(byId, o.product_id)}`} value={o.price_override} onChange={(c) => update(i, { price_override: c })} placeholder="product price" className="w-[140px]" isInvalid={Boolean(form.formState.errors.options?.[i]?.price_override)} errorMessage={form.formState.errors.options?.[i]?.price_override?.message} />
                                </td>
                                <td className="py-2 pr-2 pl-3">
                                  <Checkbox aria-label={`${productName(byId, o.product_id)} is chosen by default`} isSelected={o.is_default} onChange={(v) => update(i, { is_default: v })} className="py-0">
                                    <span className="sr-only">Default</span>
                                  </Checkbox>
                                </td>
                                <td className="py-2 pr-2 pl-3">
                                  <Select
                                    aria-label={`Nested group for ${productName(byId, o.product_id)}`}
                                    selectedKey={o.child_group_id ?? NONE}
                                    onSelectionChange={(k) => update(i, { child_group_id: k === NONE ? null : k })}
                                    items={[{ id: NONE, label: "None" }, ...otherGroups.map((g) => ({ id: g.id, label: g.name }))]}
                                    className="w-[180px]"
                                  />
                                </td>
                                <td className="py-2 pr-2">
                                  <span className="flex items-center justify-end">
                                    <Button variant="quiet" iconOnly aria-label="Move up" onPress={() => move(i, -1)} isDisabled={i === 0}>
                                      <Icon icon={ArrowUp} size={16} />
                                    </Button>
                                    <Button variant="quiet" iconOnly aria-label="Move down" onPress={() => move(i, 1)} isDisabled={i === list.length - 1}>
                                      <Icon icon={ArrowDown} size={16} />
                                    </Button>
                                    <Button variant="quiet" iconOnly aria-label={`Remove ${productName(byId, o.product_id)}`} onPress={() => field.onChange(list.filter((_, j) => j !== i))}>
                                      <Icon icon={X} size={16} />
                                    </Button>
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                  <ProductSearch
                    label="Add an option"
                    placeholder="Search products and components"
                    exclude={list.map((o) => o.product_id)}
                    keepQuery
                    onPick={(p) => field.onChange([...list, { product_id: p.id, price_override: null, child_group_id: null, is_default: false }])}
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
  );
}
