"use client";

import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent, type DraggableAttributes } from "@dnd-kit/core";
import type { SyntheticListenerMap } from "@dnd-kit/core/dist/hooks/utilities";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Badge, Button, Dialog, EmptyState, Icon, InlineError, Money, Select, Skeleton, Switch, TextField, useLocale, Pill } from "@sail/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GripVertical, Pencil, Plus, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { BrandChoice } from "@/components/backoffice/OutletChoice";
import { ProductSearch } from "@/components/backoffice/ProductSearch";
import { Warnings } from "@/components/backoffice/Warnings";
import { useAllProducts } from "@/components/backoffice/products";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Brand, Menu, MenuSection, MenuSectionInput, MenuSummary } from "@/lib/api/types";
import type { Scope } from "@/lib/cookies";
import { keys } from "@/lib/query";
import { greyPill } from "@/components/office/parts";

/** Local editing shape: one level of sub-sections, items in order. */
type Draft = { id: string; name: string; parent_id: string | null; items: string[] };

function toDraft(sections: MenuSection[], locale: string): Draft[] {
  return sections
    .slice()
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, locale))
    .map((s) => ({ id: s.id, name: s.name, parent_id: s.parent_id, items: s.items.slice().sort((a, b) => a.sort - b.sort).map((i) => i.product_id) }));
}

function toInput(drafts: Draft[]): MenuSectionInput[] {
  const tops = drafts.filter((d) => !d.parent_id);
  const out: MenuSectionInput[] = [];
  tops.forEach((t, i) => {
    out.push({ id: t.id, name: t.name, parent_id: null, sort: i, items: t.items.map((product_id, j) => ({ product_id, sort: j })) });
    drafts
      .filter((d) => d.parent_id === t.id)
      .forEach((c, j) => out.push({ id: c.id, name: c.name, parent_id: t.id, sort: j, items: c.items.map((product_id, k) => ({ product_id, sort: k })) }));
  });
  return out;
}

export function MenusView({ initialMenus, brands, scope }: { initialMenus: MenuSummary[]; brands: Brand[]; scope: Scope }) {
  const qc = useQueryClient();
  const [brandId, setBrandId] = useState<string | null>(scope.brandId ?? brands[0]?.id ?? null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  useEffect(() => {
    if (scope.brandId) setBrandId(scope.brandId);
  }, [scope.brandId]);

  const menus = useQuery({
    queryKey: keys.menus(null),
    queryFn: () => req(api.GET("/v1/menus", { params: { query: { include_archived: "true" } } })).then((r) => r.data),
    initialData: initialMenus,
  });
  const forBrand = menus.data.filter((m) => m.brand_id === brandId && (showArchived || !m.archived));
  const current = forBrand.find((m) => m.id === menuId) ?? forBrand[0] ?? null;

  const create = useMutation<{ data: Menu }, ApiError, string>({
    mutationFn: (name) => req(api.POST("/v1/menus", { body: { brand_id: brandId!, name, sections: [] } })),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["menus"] });
      setMenuId(r.data.id);
      setAdding(false);
      setNewName("");
    },
  });

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <BrandChoice brands={brands} scope={scope} brandId={brandId} onChange={(id) => { setBrandId(id); setMenuId(null); }} />
        <Select
          aria-label="Menu"
          variant="toolbar" size="sm"
          selectedKey={current?.id ?? null}
          onSelectionChange={setMenuId}
          placeholder={forBrand.length ? "Choose a menu" : "No menus for this brand"}
          items={forBrand.map((m) => ({ id: m.id, label: m.name, description: m.archived ? "Archived" : undefined }))}
          isDisabled={forBrand.length === 0}
        />
        <Switch isSelected={showArchived} onChange={setShowArchived} className="min-h-11 py-0">
          Show archived
        </Switch>
        <Button size="sm" className="ml-auto" variant="primary" onPress={() => setAdding(true)} isDisabled={!brandId}>
          Add menu
        </Button>
      </div>

      {!brandId ? (
        <EmptyState title="No brand yet" hint="Menus belong to a brand. Add a brand under Settings first." />
      ) : current ? (
        <MenuEditor key={current.id} summary={current} />
      ) : (
        <EmptyState title="No menus for this brand" hint="Tap Add menu. A menu has sections (and one level of sub-sections) with products in order." />
      )}

      <Dialog
        isOpen={adding}
        onOpenChange={(open) => !open && setAdding(false)}
        title="New menu"
        footer={
          <>
            <Button variant="secondary" className={greyPill} onPress={() => setAdding(false)}>
              Cancel
            </Button>
            <Button variant="primary" isDisabled={!newName.trim()} isPending={create.isPending} onPress={() => create.mutate(newName.trim())}>
              Add menu
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 pt-2">
          <TextField label="Name" value={newName} onChange={setNewName} placeholder="All day" autoFocus />
          <InlineError error={create.error} />
        </div>
      </Dialog>
    </>
  );
}

function MenuEditor({ summary }: { summary: MenuSummary }) {
  const qc = useQueryClient();
  const menu = useQuery({
    queryKey: keys.menu(summary.id),
    queryFn: () => req(api.GET("/v1/menus/{id}", { params: { path: { id: summary.id } } })).then((r) => r.data),
  });
  const [draft, setDraft] = useState<Draft[] | null>(null);
  const [dirty, setDirty] = useState(false);
  // Unsaved changes to the menu's order ask before the tab closes or reloads (live-test E-L4).
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const { locale } = useLocale();
  const [warnings, setWarnings] = useState<string[]>([]);
  const [renaming, setRenaming] = useState(false);
  const [menuName, setMenuName] = useState(summary.name);
  useEffect(() => {
    if (menu.data && !dirty) setDraft(toDraft(menu.data.sections, locale));
  }, [menu.data, dirty, locale]);

  const products = useAllProducts({ brand_id: undefined, include_archived: "true" });
  const sections = draft ?? [];
  const tops = sections.filter((s) => !s.parent_id);
  const childrenOf = (id: string) => sections.filter((s) => s.parent_id === id);

  const edit = (fn: (prev: Draft[]) => Draft[]) => {
    setDraft((prev) => fn(prev ?? []));
    setDirty(true);
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const a = String(active.id);
    const o = String(over.id);
    if (a.startsWith("sec:") && o.startsWith("sec:")) {
      const sa = sections.find((s) => s.id === a.slice(4));
      const so = sections.find((s) => s.id === o.slice(4));
      if (!sa || !so || sa.parent_id !== so.parent_id) return;
      edit((prev) => {
        const siblings = prev.filter((s) => s.parent_id === sa.parent_id);
        const moved = arrayMove(siblings, siblings.indexOf(siblings.find((s) => s.id === sa.id)!), siblings.indexOf(siblings.find((s) => s.id === so.id)!));
        // Rebuild in display order: tops in new order, each followed by its children.
        const others = prev.filter((s) => s.parent_id !== sa.parent_id);
        return sa.parent_id === null ? [...moved, ...others] : [...others, ...moved];
      });
    } else if (a.startsWith("item:") && o.startsWith("item:")) {
      const [, secA, prodA] = a.split(":");
      const [, secO, prodO] = o.split(":");
      if (secA !== secO) return;
      edit((prev) => prev.map((s) => (s.id === secA ? { ...s, items: arrayMove(s.items, s.items.indexOf(prodA!), s.items.indexOf(prodO!)) } : s)));
    }
  };

  const save = useMutation<{ data: Menu; warnings: string[] }, ApiError, void>({
    mutationFn: () => req(api.PATCH("/v1/menus/{id}", { params: { path: { id: summary.id } }, body: { sections: toInput(sections) } })),
    onSuccess: async (r) => {
      setWarnings(r.warnings);
      setDirty(false);
      qc.setQueryData(keys.menu(summary.id), r.data);
      setDraft(toDraft(r.data.sections, locale));
    },
  });
  const patchMenu = useMutation<{ data: Menu; warnings: string[] }, ApiError, { name?: string; archived?: boolean }>({
    mutationFn: (body) => req(api.PATCH("/v1/menus/{id}", { params: { path: { id: summary.id } }, body })),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["menus"] });
      await qc.invalidateQueries({ queryKey: keys.menu(summary.id) });
      setRenaming(false);
    },
  });

  const addSection = (parent_id: string | null) => edit((prev) => [...prev, { id: crypto.randomUUID(), name: parent_id ? "New sub-section" : "New section", parent_id, items: [] }]);
  const removeSection = (id: string) => edit((prev) => prev.filter((s) => s.id !== id && s.parent_id !== id));
  const rename = (id: string, name: string) => edit((prev) => prev.map((s) => (s.id === id ? { ...s, name } : s)));
  const addItem = (id: string, product_id: string) => edit((prev) => prev.map((s) => (s.id === id && !s.items.includes(product_id) ? { ...s, items: [...s.items, product_id] } : s)));
  const removeItem = (id: string, product_id: string) => edit((prev) => prev.map((s) => (s.id === id ? { ...s, items: s.items.filter((p) => p !== product_id) } : s)));

  if (menu.isPending) return <Skeleton lines={6} />;
  if (menu.error) return <InlineError error={menu.error} />;

  const itemCount = sections.reduce((n, s) => n + s.items.length, 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-rule-subtle pb-4">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          {renaming ? (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (menuName.trim()) patchMenu.mutate({ name: menuName.trim() });
              }}
            >
              <TextField aria-label="Menu name" value={menuName} onChange={setMenuName} autoFocus className="w-full sm:w-[240px]" />
              <Button type="submit" variant="primary" isPending={patchMenu.isPending}>
                Rename
              </Button>
              <Button variant="secondary" className={greyPill} onPress={() => setRenaming(false)}>
                Cancel
              </Button>
            </form>
          ) : (
            <>
              <div className="min-w-0">
                <div className="flex items-center gap-1">
                  <h2 className="font-heading text-[19px] leading-[1.3] font-semibold tracking-[-0.01em] text-ink [overflow-wrap:anywhere]">{summary.name}</h2>
                  <Button variant="quiet" iconOnly aria-label="Rename menu" onPress={() => { setMenuName(summary.name); setRenaming(true); }}>
                    <Icon icon={Pencil} size={16} />
                  </Button>
                  {summary.archived ? <Pill size="sm" tone="neutral">Archived</Pill> : null}
                </div>
                <p className="text-[13px] text-ink-3 tabular">
                  {tops.length} {tops.length === 1 ? "section" : "sections"} · {itemCount} {itemCount === 1 ? "item" : "items"}
                </p>
              </div>
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" className={greyPill} onPress={() => patchMenu.mutate({ archived: !summary.archived })} isPending={patchMenu.isPending && patchMenu.variables?.archived !== undefined}>
            {summary.archived ? "Restore menu" : "Archive menu"}
          </Button>
          <Button onPress={() => addSection(null)}>
            <Icon icon={Plus} size={16} /> Add section
          </Button>
          <Button variant="primary" isDisabled={!dirty} isPending={save.isPending} onPress={() => save.mutate()}>
            {dirty ? "Save menu order" : "Saved"}
          </Button>
        </div>
      </div>
      <Warnings warnings={warnings} />
      <InlineError error={save.error ?? patchMenu.error} />

      {tops.length === 0 ? (
        <EmptyState variant="quiet" title="No sections yet" hint="Tap Add section, then search products to add them. The POS and the guest app show only products in a section. Drag the handle to reorder, then Save menu order." />
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={tops.map((s) => `sec:${s.id}`)} strategy={verticalListSortingStrategy}>
            <ol className="flex flex-col gap-4">
              {tops.map((s) => (
                <SortableRow key={s.id} id={`sec:${s.id}`} className="rounded-panel border border-rule bg-surface">
                  {(handle) => (
                    <SectionBlock
                      section={s}
                      handle={handle}
                      byId={products.byId}
                      onRename={(n) => rename(s.id, n)}
                      onRemove={() => removeSection(s.id)}
                      onAddItem={(pid) => addItem(s.id, pid)}
                      onRemoveItem={(pid) => removeItem(s.id, pid)}
                      onAddSub={() => addSection(s.id)}
                    >
                      {childrenOf(s.id).length ? (
                        <SortableContext items={childrenOf(s.id).map((c) => `sec:${c.id}`)} strategy={verticalListSortingStrategy}>
                          <ol className="flex flex-col gap-3 sm:pl-6">
                            {childrenOf(s.id).map((c) => (
                              <SortableRow key={c.id} id={`sec:${c.id}`} className="rounded-panel border border-rule-subtle bg-surface-2/50">
                                {(h) => (
                                  <SectionBlock
                                    section={c}
                                    handle={h}
                                    byId={products.byId}
                                    sub
                                    onRename={(n) => rename(c.id, n)}
                                    onRemove={() => removeSection(c.id)}
                                    onAddItem={(pid) => addItem(c.id, pid)}
                                    onRemoveItem={(pid) => removeItem(c.id, pid)}
                                  />
                                )}
                              </SortableRow>
                            ))}
                          </ol>
                        </SortableContext>
                      ) : null}
                    </SectionBlock>
                  )}
                </SortableRow>
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}

type Handle = { attributes: DraggableAttributes; listeners: SyntheticListenerMap | undefined };

function SortableRow({ id, className, children }: { id: string; className?: string; children: (handle: Handle) => ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={`${className ?? ""} ${isDragging ? "relative z-10 shadow-sheet" : ""}`}>
      {children({ attributes, listeners })}
    </li>
  );
}

function DragHandle({ handle, label }: { handle: Handle; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      className="press inline-flex size-9 shrink-0 cursor-grab touch-none items-center justify-center rounded-full text-ink-3 outline-none hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-focus active:cursor-grabbing"
      {...handle.attributes}
      {...handle.listeners}
    >
      <Icon icon={GripVertical} size={18} />
    </button>
  );
}

function SectionBlock({
  section,
  handle,
  byId,
  sub,
  onRename,
  onRemove,
  onAddItem,
  onRemoveItem,
  onAddSub,
  children,
}: {
  section: Draft;
  handle: Handle;
  byId: ReturnType<typeof useAllProducts>["byId"];
  sub?: boolean;
  onRename: (name: string) => void;
  onRemove: () => void;
  onAddItem: (productId: string) => void;
  onRemoveItem: (productId: string) => void;
  onAddSub?: () => void;
  children?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState(section.name);

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <DragHandle handle={handle} label={`Reorder ${section.name}`} />
        {editing ? (
          <form
            className="flex flex-1 flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) onRename(name.trim());
              setEditing(false);
            }}
          >
            <TextField aria-label="Section name" value={name} onChange={setName} autoFocus className="w-full sm:w-[240px]" />
            <Button type="submit" variant="primary">
              Rename
            </Button>
            <Button variant="secondary" className={greyPill} onPress={() => setEditing(false)}>
              Cancel
            </Button>
          </form>
        ) : (
          <>
            <h3 className={`min-w-0 font-heading font-semibold text-ink [overflow-wrap:anywhere] ${sub ? "text-[15px] leading-[1.35]" : "text-[16px] leading-[1.35] tracking-[-0.005em]"}`}>{section.name}</h3>
            <Button variant="quiet" iconOnly aria-label={`Rename ${section.name}`} onPress={() => { setName(section.name); setEditing(true); }}>
              <Icon icon={Pencil} size={16} />
            </Button>
            <Badge>{section.items.length}</Badge>
          </>
        )}
        {/* On a phone the actions take their own line, tighter, so the × stays inside the card. */}
        <span className="flex min-w-0 items-center gap-0.5 max-sm:w-full max-sm:[&>button]:px-2! sm:ml-auto sm:justify-end">
          {onAddSub ? (
            <Button variant="quiet" onPress={onAddSub}>
              <Icon icon={Plus} size={16} /> Sub-section
            </Button>
          ) : null}
          <Button variant="quiet" onPress={() => setAdding((v) => !v)}>
            <Icon icon={Plus} size={16} /> Products
          </Button>
          <Button variant="quiet" iconOnly aria-label={`Remove ${section.name}`} onPress={onRemove} className="max-sm:ml-auto">
            <Icon icon={X} size={16} />
          </Button>
        </span>
      </div>

      {section.items.length ? (
        <SortableContext items={section.items.map((p) => `item:${section.id}:${p}`)} strategy={verticalListSortingStrategy}>
          <ol className="flex flex-col">
            {section.items.map((pid) => {
              const p = byId.get(pid);
              return (
                <SortableRow key={pid} id={`item:${section.id}:${pid}`} className="border-b border-rule-subtle last:border-b-0">
                  {(h) => (
                    <div className="flex items-center gap-2 py-0.5">
                      <DragHandle handle={h} label={`Reorder ${p?.name ?? "item"}`} />
                      <span className="min-w-0 flex-1 truncate text-[14px] text-ink">
                        {p?.name ?? `Product ${pid.slice(0, 8)}`}
                        {p?.archived ? <span className="ml-2 text-[12px] text-ink-3">archived</span> : null}
                      </span>
                      {p ? <Money cents={p.price} className="text-[14px] text-ink-2" /> : null}
                      <Button variant="quiet" iconOnly aria-label={`Remove ${p?.name ?? "item"} from ${section.name}`} onPress={() => onRemoveItem(pid)}>
                        <Icon icon={X} size={16} />
                      </Button>
                    </div>
                  )}
                </SortableRow>
              );
            })}
          </ol>
        </SortableContext>
      ) : (
        <p className="mx-1 rounded-field border border-dashed border-rule-dashed px-3 py-2.5 text-[13px] text-ink-3">No products in this section yet.</p>
      )}

      {adding ? <ProductSearch autoFocus keepQuery exclude={section.items} onPick={(p) => onAddItem(p.id)} className="w-full max-w-[520px]" /> : null}
      {children}
    </div>
  );
}
