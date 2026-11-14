"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Button, EmptyState, Icon, InlineError, Sheet, Switch, useLocale, Pill, FieldsLocked } from "@sail/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { greyPill, greyPillAlert, SheetSection } from "@/components/office/parts";
import { applyServerErrors } from "@/components/office/server-errors";
import { RhfSelect, RhfTextField } from "@/components/forms/fields";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Category } from "@/lib/api/types";
import { keys } from "@/lib/query";
import { useFreshErrors } from "@/lib/fresh-errors";
import { useCan } from "@/lib/can";

const ROOT = "__root__";
type SheetState = { mode: "create"; parentId: string | null } | { mode: "edit"; category: Category } | null;

const Schema = z.object({ name: z.string().trim().min(1, "Enter a name"), parent_id: z.string() });
type Values = z.infer<typeof Schema>;

/** Names compare in the merchant's locale, so the server render and the browser agree. */
function bySort(locale: string) {
  return (a: Category, b: Category) => a.sort - b.sort || a.name.localeCompare(b.name, locale);
}

/** The two-level category tree: parents with their children, each editable, each movable among its siblings. */
export function CategoriesView({ initialCategories }: { initialCategories: Category[] }) {
  const canCreate = useCan("categories.create");
  // Reordering writes each category: a role that cannot change them gets no Move buttons (L3).
  const canReorder = useCan("categories.update").ok;
  const qc = useQueryClient();
  const [showArchived, setShowArchived] = useState(false);
  const [sheet, setSheet] = useState<SheetState>(null);

  const categories = useQuery({
    queryKey: keys.categories,
    queryFn: () => req(api.GET("/v1/categories", { params: { query: { include_archived: "true" } } })).then((r) => r.data),
    initialData: initialCategories,
  });

  const visible = categories.data.filter((c) => showArchived || !c.archived);
  const { locale } = useLocale();
  const parents = useMemo(() => visible.filter((c) => !c.parent_id).sort(bySort(locale)), [visible, locale]);
  const childrenOf = useMemo(() => {
    const m = new Map<string, Category[]>();
    for (const c of visible) if (c.parent_id) m.set(c.parent_id, [...(m.get(c.parent_id) ?? []), c].sort(bySort(locale)));
    return m;
  }, [visible, locale]);

  const reorder = useMutation<unknown, ApiError, { siblings: Category[]; from: number; to: number }>({
    mutationFn: async ({ siblings, from, to }) => {
      // Renumber the siblings in their new order; only the ones whose sort changed are written.
      const next = siblings.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved!);
      await Promise.all(next.map((c, i) => (c.sort === i ? null : req(api.PATCH("/v1/categories/{id}", { params: { path: { id: c.id } }, body: { sort: i } })))).filter(Boolean));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.categories }),
  });

  const Row = ({ c, siblings, depth }: { c: Category; siblings: Category[]; depth: 0 | 1 }) => {
    const i = siblings.findIndex((s) => s.id === c.id);
    return (
      <li className={`flex flex-wrap items-center gap-1 border-b border-rule-subtle py-1 pr-2 last:border-b-0 ${depth ? "pl-6 sm:pl-10" : "pl-2"}`}>
        <Button variant="quiet" className="min-w-0 flex-1 basis-[160px] justify-start rounded-field px-2 text-left font-normal" onPress={() => setSheet({ mode: "edit", category: c })}>
          <span className={`truncate ${depth ? "text-[14px]" : "font-medium"} ${c.archived ? "text-ink-2" : "text-ink"}`}>{c.name}</span>
          {c.archived ? <Pill size="sm" tone="neutral" className="ml-1">Archived</Pill> : null}
          {c.legacy_id ? <span className="ml-1 truncate text-[12px] text-ink-3">{c.legacy_id}</span> : null}
        </Button>
        {depth === 0 && canCreate.ok ? (
          <Button variant="quiet" onPress={() => setSheet({ mode: "create", parentId: c.id })} className="text-[13px] text-ink-2">
            <Icon icon={Plus} size={14} /> Sub-category
          </Button>
        ) : null}
        {canReorder ? (
          <>
        <Button variant="quiet" iconOnly aria-label={`Move ${c.name} up`} isDisabled={i <= 0 || reorder.isPending} onPress={() => reorder.mutate({ siblings, from: i, to: i - 1 })}>
          <Icon icon={ArrowUp} size={16} />
        </Button>
        <Button variant="quiet" iconOnly aria-label={`Move ${c.name} down`} isDisabled={i < 0 || i >= siblings.length - 1 || reorder.isPending} onPress={() => reorder.mutate({ siblings, from: i, to: i + 1 })}>
          <Icon icon={ArrowDown} size={16} />
        </Button>
          </>
        ) : null}
      </li>
    );
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[14px] text-ink-2">Two levels: a category and its sub-categories. Pricing scopes on a category include its sub-categories.</p>
        <div className="flex flex-wrap items-center gap-4">
          <Switch isSelected={showArchived} onChange={setShowArchived} className="min-h-11 py-0">
            Show archived
          </Switch>
          {canCreate.ok ? (
            <Button size="sm" variant="primary" onPress={() => setSheet({ mode: "create", parentId: null })}>
            Add category
          </Button>
          ) : null}
        </div>
      </div>

      {parents.length === 0 ? (
        <EmptyState title="No categories yet" hint="Tap Add category to create the first one. Products are grouped by category in reports and pricing scopes." />
      ) : (
        <ul className="flex max-w-[760px] flex-col gap-3">
          {parents.map((p) => (
            <li key={p.id}>
              <ul className="rounded-panel border border-rule bg-surface">
                <Row c={p} siblings={parents} depth={0} />
                {(childrenOf.get(p.id) ?? []).map((c) => (
                  <Row key={c.id} c={c} siblings={childrenOf.get(p.id) ?? []} depth={1} />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      <InlineError error={reorder.error} className="mt-4" />
      <CategorySheet state={sheet} parents={categories.data.filter((c) => !c.parent_id && !c.archived)} parentIds={new Set(categories.data.map((c) => c.parent_id).filter((x): x is string => !!x))} onClose={() => setSheet(null)} />
    </>
  );
}

function CategorySheet({ state, parents, parentIds, onClose }: { state: SheetState; parents: Category[]; parentIds: Set<string>; onClose: () => void }) {
  const qc = useQueryClient();
  const category = state?.mode === "edit" ? state.category : null;
  const defaults = (s: SheetState): Values => ({ name: s?.mode === "edit" ? s.category.name : "", parent_id: s?.mode === "edit" ? s.category.parent_id ?? ROOT : s?.mode === "create" ? s.parentId ?? ROOT : ROOT });
  const form = useForm<Values>({ resolver: zodResolver(Schema), defaultValues: defaults(state) });
  const reset = form.reset;
  useEffect(() => {
    if (state) reset(defaults(state));
  }, [state, reset]);

  const settle = async () => {
    await qc.invalidateQueries({ queryKey: keys.categories });
    onClose();
  };
  const save = useMutation<unknown, ApiError, Values>({
    mutationFn: (v) => {
      const body = { name: v.name.trim(), parent_id: v.parent_id === ROOT ? null : v.parent_id };
      return category ? req(api.PATCH("/v1/categories/{id}", { params: { path: { id: category.id } }, body })) : req(api.POST("/v1/categories", { body }));
    },
    onSuccess: settle,
    // A refusal that names a field shows under it; the message also stays at the foot of the form.
    onError: (e) => applyServerErrors(form.setError, e, Object.keys(form.getValues())),
  });
  const archive = useMutation<unknown, ApiError, boolean>({
    mutationFn: (archived) => req(api.PATCH("/v1/categories/{id}", { params: { path: { id: category!.id } }, body: { archived } })),
    onSuccess: settle,
  });
  const busy = save.isPending || archive.isPending;
  // A category with sub-categories stays at the top level (two levels only).
  const canHaveParent = !category || !parentIds.has(category.id);

  const mayEdit = useCan("categories.update");
  useFreshErrors(state, form.watch(), save, archive);
  return (
    <FieldsLocked locked={!mayEdit.ok}>
    <Sheet
      isOpen={state !== null}
      onOpenChange={(open) => !open && onClose()}
      isDismissable={!busy}
      title={category ? category.name : "New category"}
      description={category ? (category.archived ? "Archived" : "Rename or move the category.") : "Categories group products for reports and pricing scopes."}
      footer={
        <>
          {category && mayEdit.ok ? (
            <Button variant="secondary" onPress={() => archive.mutate(!category.archived)} isPending={archive.isPending} isDisabled={save.isPending} className={`mr-auto ${category.archived ? greyPill : greyPillAlert}`}>
              {category.archived ? "Restore category" : "Archive category"}
            </Button>
          ) : null}
          <Button variant="secondary" className={greyPill} onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="category-form" isPending={save.isPending} isDisabled={!mayEdit.ok || archive.isPending}>
            {category ? "Save changes" : "Add category"}
          </Button>
        </>
      }
    >
      <form id="category-form" noValidate onSubmit={form.handleSubmit((v) => save.mutate(v))} className="flex flex-col gap-6">
        <SheetSection>
          <RhfTextField control={form.control} name="name" label="Name" autoFocus />
          {canHaveParent ? (
            <RhfSelect
              control={form.control}
              name="parent_id"
              label="Parent"
              description="Leave as top level, or place it under a category."
              items={[{ id: ROOT, label: "Top level" }, ...parents.filter((p) => p.id !== category?.id).map((p) => ({ id: p.id, label: p.name }))]}
            />
          ) : null}
        </SheetSection>
        {mayEdit.reason ? <p className="text-body text-ink-2">{mayEdit.reason}</p> : null}
        <InlineError error={save.error ?? archive.error} />
      </form>
    </Sheet>
    </FieldsLocked>
  );
}
