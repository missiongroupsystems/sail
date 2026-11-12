"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Badge, Button, DataTable, EmptyState, Icon, InlineError, PercentField, Sheet, StatusDot, Switch, TextField, type DataTableColumn } from "@sail/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Controller, useForm, type FieldErrors } from "react-hook-form";
import { z } from "zod";
import { ORDER_TYPES, ORDER_TYPE_LABEL } from "@/components/backoffice/labels";
import { componentsText, defaultRate } from "@/components/backoffice/tax-classes";
import { FormSection, RhfSelect, RhfSwitch, RhfTextField } from "@/components/forms/fields";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Outlet, TaxClass, TaxRate } from "@/lib/api/types";
import { keys } from "@/lib/query";

type SheetState = { mode: "create" } | { mode: "edit"; id: string } | null;

const NONE = "__none__";

const ComponentSchema = z.object({
  name: z.string().trim().min(1, "Enter the name printed on receipts"),
  bps: z
    .number()
    .int()
    .max(10_000, "At most 100%")
    .nullable()
    .refine((v): boolean => v !== null, "Enter a rate"),
});
const ComponentsSchema = z.array(ComponentSchema);
type ComponentValues = z.infer<typeof ComponentsSchema>;
const toComponents = (list: ComponentValues) => list.map((c) => ({ name: c.name.trim(), bps: c.bps ?? 0 }));

const ClassSchema = z.object({ name: z.string().trim().min(1, "Enter a name"), components: ComponentsSchema, is_default: z.boolean() });
type ClassValues = z.infer<typeof ClassSchema>;

const RateSchema = z.object({ outlet_id: z.string(), order_type: z.string(), components: ComponentsSchema });
type RateValues = z.infer<typeof RateSchema>;

/** Tax classes and their rates (pricing semantics §8): what products and fees are taxed at, per outlet and order type. */
export function TaxClassesView({ initialClasses, outlets }: { initialClasses: TaxClass[]; outlets: Outlet[] }) {
  const [showArchived, setShowArchived] = useState(false);
  const [sheet, setSheet] = useState<SheetState>(null);
  const classes = useQuery({
    queryKey: keys.taxClasses,
    queryFn: () => req(api.GET("/v1/tax-classes", { params: { query: { include_archived: "true" } } })).then((r) => r.data),
    initialData: initialClasses,
  });
  const rows = classes.data.filter((c) => showArchived || !c.archived);
  const editing = sheet?.mode === "edit" ? (classes.data.find((c) => c.id === sheet.id) ?? null) : null;

  const columns: DataTableColumn<TaxClass>[] = [
    {
      key: "name",
      header: "Tax class",
      isRowHeader: true,
      sortable: true,
      render: (c) => (
        <span className="inline-flex items-center gap-2 text-ink">
          {c.name}
          {c.is_default ? <Badge tone="paid">Default</Badge> : null}
        </span>
      ),
    },
    { key: "rate", header: "Rate", render: (c) => componentsText(defaultRate(c)?.components ?? []) },
    { key: "rates", header: "Outlet and order-type rates", numeric: true, render: (c) => c.rates.length - 1 || "—" },
    { key: "archived", header: "Status", sortable: true, sortValue: (c) => (c.archived ? 1 : 0), render: (c) => (c.archived ? <StatusDot status="neutral" label="Archived" muted /> : <StatusDot status="paid" label="Active" />) },
  ];

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-ink-2">What products and fees are taxed at. A product without a class uses the default.</p>
        <div className="flex items-center gap-4">
          <Switch isSelected={showArchived} onChange={setShowArchived} className="min-h-11 py-0">
            Show archived
          </Switch>
          <Button variant="primary" onPress={() => setSheet({ mode: "create" })}>
            Add tax class
          </Button>
        </div>
      </div>
      <DataTable
        aria-label="Tax classes"
        columns={columns}
        rows={rows}
        rowKey={(c) => c.id}
        defaultSort={{ column: "name", direction: "ascending" }}
        onRowAction={(c) => setSheet({ mode: "edit", id: c.id })}
        rowClassName={(c) => (c.archived ? "text-ink-2" : undefined)}
        emptyState={<EmptyState variant="quiet" title="No tax classes" hint="Add one for each way your items are taxed." />}
      />
      <TaxClassSheet isOpen={sheet !== null} taxClass={editing} outlets={outlets} onClose={() => setSheet(null)} />
    </>
  );
}

function TaxClassSheet({ isOpen, taxClass, outlets, onClose }: { isOpen: boolean; taxClass: TaxClass | null; outlets: Outlet[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [rate, setRate] = useState<TaxRate | "new" | null>(null);
  const form = useForm<ClassValues>({ resolver: zodResolver(ClassSchema), defaultValues: { name: "", components: [], is_default: false } });
  const reset = form.reset;
  const classId = taxClass?.id ?? null;
  const className = taxClass?.name ?? "";

  const refresh = () => qc.invalidateQueries({ queryKey: keys.taxClasses });
  const save = useMutation<unknown, ApiError, ClassValues>({
    mutationFn: (v) =>
      taxClass
        ? req(api.PATCH("/v1/tax-classes/{id}", { params: { path: { id: taxClass.id } }, body: { name: v.name.trim() } }))
        : req(api.POST("/v1/tax-classes", { body: { name: v.name.trim(), components: toComponents(v.components), is_default: v.is_default } })),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });
  const makeDefault = useMutation<unknown, ApiError>({
    mutationFn: () => req(api.PATCH("/v1/tax-classes/{id}", { params: { path: { id: taxClass!.id } }, body: { is_default: true } })),
    onSuccess: refresh,
  });
  const archive = useMutation<unknown, ApiError, boolean>({
    mutationFn: (archived) => req(api.PATCH("/v1/tax-classes/{id}", { params: { path: { id: taxClass!.id } }, body: { archived } })),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });
  const removeRate = useMutation<unknown, ApiError, string>({
    mutationFn: (rateId) => req(api.DELETE("/v1/tax-classes/{id}/rates/{rate_id}", { params: { path: { id: taxClass!.id, rate_id: rateId } } })),
    onSuccess: refresh,
  });
  // The sheet stays mounted between classes: clear the form and any error from the last one.
  const { reset: resetSave } = save;
  const { reset: resetDefault } = makeDefault;
  const { reset: resetArchive } = archive;
  const { reset: resetRemove } = removeRate;
  useEffect(() => {
    if (!isOpen) return;
    reset({ name: className, components: classId ? [] : [{ name: "", bps: null }], is_default: false });
    setRate(null);
    resetSave();
    resetDefault();
    resetArchive();
    resetRemove();
  }, [isOpen, classId, className, reset, resetSave, resetDefault, resetArchive, resetRemove]);
  const busy = save.isPending || archive.isPending || makeDefault.isPending;
  const outletName = (id: string | null) => (id ? (outlets.find((o) => o.id === id)?.name ?? "Unknown outlet") : "Every outlet");
  const scopeText = (r: TaxRate) => (r.outlet_id === null && r.order_type === null ? "Default rate" : `${outletName(r.outlet_id)} · ${r.order_type ? ORDER_TYPE_LABEL[r.order_type] : "every order type"}`);

  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={(open) => !open && onClose()}
      isDismissable={!busy}
      width="lg"
      title={taxClass ? taxClass.name : "New tax class"}
      description={taxClass ? (taxClass.archived ? "Archived" : taxClass.is_default ? "The default class: products without a class use it." : "Rename it, change its rates, or make it the default.") : "A class with its default rate. Add outlet or order-type rates after."}
      footer={
        <>
          {taxClass ? (
            <Button variant={taxClass.archived ? "secondary" : "destructive"} onPress={() => archive.mutate(!taxClass.archived)} isPending={archive.isPending} isDisabled={taxClass.is_default || save.isPending} className="mr-auto">
              {taxClass.archived ? "Restore" : "Archive"}
            </Button>
          ) : null}
          {taxClass && !taxClass.is_default && !taxClass.archived ? (
            <Button variant="secondary" onPress={() => makeDefault.mutate()} isPending={makeDefault.isPending} isDisabled={save.isPending}>
              Make default
            </Button>
          ) : null}
          <Button variant="quiet" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="tax-class-form" isPending={save.isPending}>
            {taxClass ? "Save name" : "Add tax class"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-8">
        <form id="tax-class-form" noValidate onSubmit={form.handleSubmit((v) => save.mutate(v))} className="flex flex-col gap-8">
          <FormSection>
            <RhfTextField control={form.control} name="name" label="Name" placeholder="Standard rate" autoFocus={!taxClass} description="Shown in the back office only; receipts print the component names." />
          </FormSection>
          {taxClass ? null : (
            <>
              <FormSection title="Default rate" hint="Applies at every outlet and order type. No components means exempt.">
                <Controller control={form.control} name="components" render={({ field }) => <ComponentsEditor value={field.value} onChange={field.onChange} errors={form.formState.errors.components} />} />
              </FormSection>
              <RhfSwitch control={form.control} name="is_default" description="Products without a class use the default.">
                Make this the default class
              </RhfSwitch>
            </>
          )}
          <InlineError error={save.error ?? archive.error ?? makeDefault.error} />
        </form>

        {taxClass ? (
          <FormSection title="Rates" hint="The most specific rate applies: outlet and order type, then outlet, then order type, then the default. Orders already open keep their rates.">
            {rate ? (
              <RateEditor key={rate === "new" ? "new" : rate.id} taxClass={taxClass} rate={rate === "new" ? null : rate} outlets={outlets} onDone={() => setRate(null)} />
            ) : (
              <>
                <ul className="flex flex-col">
                  {taxClass.rates.map((r) => {
                    const isDefault = r.outlet_id === null && r.order_type === null;
                    return (
                      <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 hairline-b">
                        <span className="min-w-0 flex-1">
                          <span className="block text-ink">{scopeText(r)}</span>
                          <span className="block text-caption text-ink-2">{componentsText(r.components)}</span>
                        </span>
                        <Button variant="quiet" onPress={() => setRate(r)} isDisabled={taxClass.archived}>
                          Edit
                        </Button>
                        {isDefault ? null : (
                          <Button variant="quiet" iconOnly aria-label={`Remove ${scopeText(r)}`} onPress={() => removeRate.mutate(r.id)} isDisabled={removeRate.isPending || taxClass.archived}>
                            <Icon icon={X} size={16} />
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <Button onPress={() => setRate("new")} isDisabled={taxClass.archived} className="self-start">
                  <Icon icon={Plus} size={16} /> Add a rate
                </Button>
                <InlineError error={removeRate.error} />
              </>
            )}
          </FormSection>
        ) : null}
      </div>
    </Sheet>
  );
}

/** Sets one rate of a class: its scope (fixed once it exists) and its components. */
function RateEditor({ taxClass, rate, outlets, onDone }: { taxClass: TaxClass; rate: TaxRate | null; outlets: Outlet[]; onDone: () => void }) {
  const qc = useQueryClient();
  const form = useForm<RateValues>({
    resolver: zodResolver(RateSchema),
    defaultValues: { outlet_id: rate?.outlet_id ?? NONE, order_type: rate?.order_type ?? NONE, components: rate ? rate.components : [{ name: "", bps: null }] },
  });
  const save = useMutation<unknown, ApiError, RateValues>({
    mutationFn: (v) =>
      req(
        api.PUT("/v1/tax-classes/{id}/rates", {
          params: { path: { id: taxClass.id } },
          body: { outlet_id: v.outlet_id === NONE ? null : v.outlet_id, order_type: v.order_type === NONE ? null : (v.order_type as (typeof ORDER_TYPES)[number]), components: toComponents(v.components) },
        }),
      ),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.taxClasses });
      onDone();
    },
  });
  return (
    <form noValidate onSubmit={form.handleSubmit((v) => save.mutate(v))} aria-label={rate ? "Edit rate" : "New rate"} className="flex flex-col gap-4 rounded-tile p-4 hairline">
      <div className="grid gap-4 sm:grid-cols-2">
        <RhfSelect control={form.control} name="outlet_id" label="Outlet" isDisabled={rate !== null} items={[{ id: NONE, label: "Every outlet" }, ...outlets.map((o) => ({ id: o.id, label: o.name }))]} />
        <RhfSelect control={form.control} name="order_type" label="Order type" isDisabled={rate !== null} items={[{ id: NONE, label: "Every order type" }, ...ORDER_TYPES.map((t) => ({ id: t, label: ORDER_TYPE_LABEL[t]! }))]} />
      </div>
      <Controller control={form.control} name="components" render={({ field }) => <ComponentsEditor value={field.value} onChange={field.onChange} errors={form.formState.errors.components} />} />
      <InlineError error={save.error} />
      <div className="flex justify-end gap-2">
        <Button variant="quiet" onPress={onDone} isDisabled={save.isPending}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" isPending={save.isPending}>
          Save rate
        </Button>
      </div>
    </form>
  );
}

/** The named components of a rate ("VAT 20%" at 20%); the name is printed on receipts as it stands. */
function ComponentsEditor({ value, onChange, errors }: { value: ComponentValues; onChange: (v: ComponentValues) => void; errors?: FieldErrors<ClassValues>["components"] }) {
  const update = (i: number, patch: Partial<ComponentValues[number]>) => onChange(value.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <div className="flex flex-col gap-3">
      {value.length === 0 ? <p className="text-caption text-ink-2">No components: exempt, nothing is printed.</p> : null}
      {value.map((c, i) => (
        <div key={i} className="grid items-start gap-3 sm:grid-cols-[1fr_140px_auto]">
          <TextField label={i === 0 ? "Name on receipts" : undefined} aria-label={i === 0 ? undefined : `Component ${i + 1} name`} placeholder="VAT 20%" value={c.name} onChange={(name) => update(i, { name })} isInvalid={!!errors?.[i]?.name} errorMessage={errors?.[i]?.name?.message} />
          <PercentField label={i === 0 ? "Rate" : undefined} aria-label={i === 0 ? undefined : `Component ${i + 1} rate`} value={c.bps} onChange={(bps) => update(i, { bps })} isInvalid={!!errors?.[i]?.bps} errorMessage={errors?.[i]?.bps?.message} />
          <Button variant="quiet" iconOnly aria-label={`Remove ${c.name || `component ${i + 1}`}`} onPress={() => onChange(value.filter((_, j) => j !== i))} className={i === 0 ? "sm:mt-7" : undefined}>
            <Icon icon={X} size={16} />
          </Button>
        </div>
      ))}
      <Button variant="quiet" onPress={() => onChange([...value, { name: "", bps: null }])} className="self-start">
        <Icon icon={Plus} size={16} /> Add a component
      </Button>
    </div>
  );
}
