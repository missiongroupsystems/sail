"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Badge, Button, DataTable, EmptyState, InlineError, SectionHead, Sheet, TagsField, type DataTableColumn, FieldsLocked } from "@sail/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { ORDER_TYPES, ORDER_TYPE_LABEL } from "@/components/backoffice/labels";
import { SOURCE_LABEL } from "@/components/backoffice/register";
import { FormSection, RhfCheckboxGroup, RhfSwitch, RhfTextField } from "@/components/forms/fields";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { paths } from "@/lib/api/schema";
import type { Station } from "@/lib/api/types";
import { useFreshErrors } from "@/lib/fresh-errors";

type Destination = paths["/v1/display-destinations"]["get"]["responses"][200]["content"]["application/json"]["data"][number];
type SheetState = { mode: "create" } | { mode: "edit"; destination: Destination } | null;

const Schema = z.object({
  name: z.string().trim().min(1, "Enter a name"),
  include_tags: z.array(z.string()),
  exclude_tags: z.array(z.string()),
  order_types: z.array(z.enum(ORDER_TYPES)),
  sources: z.array(z.enum(["pos", "guest"])),
  is_default: z.boolean(),
});
type Values = z.infer<typeof Schema>;

const defaults = (d: Destination | null): Values => ({ name: d?.name ?? "", include_tags: d?.include_tags ?? [], exclude_tags: d?.exclude_tags ?? [], order_types: (d?.order_types ?? []) as Values["order_types"], sources: (d?.sources ?? []) as Values["sources"], is_default: d?.is_default ?? false });

/**
 * Kitchen displays on the printing screen: each destination routes items exactly
 * as a kitchen printer does (services/printing.ts printerMatches), and display
 * stations (Settings › Stations) show the destinations they are given. A
 * destination and a printer may take the same tags; both get the items.
 */
export function DisplayDestinations({ outletId, stations, canEdit }: { outletId: string; stations: Station[]; canEdit: boolean }) {
  const [sheet, setSheet] = useState<SheetState>(null);
  const destinations = useQuery({
    queryKey: ["display-destinations", outletId],
    queryFn: () => req(api.GET("/v1/display-destinations", { params: { query: { outlet_id: outletId } } })).then((r) => r.data),
  });
  const shownOn = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const s of stations) if (s.kind === "display" && !s.archived) for (const id of s.display_destination_ids) m.set(id, [...(m.get(id) ?? []), s.name]);
    return m;
  }, [stations]);

  const columns: DataTableColumn<Destination>[] = [
    { key: "name", header: "Name", sortable: true, isRowHeader: true, render: (d) => <span className="text-ink">{d.name}</span> },
    {
      key: "tags",
      header: "Tags",
      render: (d) =>
        d.include_tags.length === 0 && d.exclude_tags.length === 0 ? (
          <span className="text-ink-2">{d.is_default ? "Everything else" : "Any"}</span>
        ) : (
          <span className="inline-flex flex-wrap gap-1">
            {d.include_tags.map((t) => (
              <Badge key={`i-${t}`}>{t}</Badge>
            ))}
            {d.exclude_tags.map((t) => (
              <Badge key={`x-${t}`} tone="alert">
                not {t}
              </Badge>
            ))}
          </span>
        ),
    },
    { key: "is_default", header: "Default", sortable: true, render: (d) => (d.is_default ? <Badge tone="seated">Default display</Badge> : <span className="text-ink-2">—</span>) },
    { key: "shown", header: "Shown on", render: (d) => <span className="text-ink-2">{shownOn.get(d.id)?.join(", ") ?? "No display station yet"}</span> },
  ];

  return (
    <section className="mt-10" aria-label="Kitchen displays">
      <SectionHead
        title="Kitchen displays"
        description="Items are routed to a display by the same tags, order types and sources as a printer. Assign destinations to a kitchen display station in Settings › Stations."
        className="mb-2"
        actions={
          <Button size="sm" variant="secondary" onPress={() => setSheet({ mode: "create" })} isDisabled={!canEdit}>
            Add display destination
          </Button>
        }
      />
      <DataTable
        aria-label="Kitchen display destinations"
        columns={columns}
        rows={destinations.data ?? []}
        rowKey={(d) => d.id}
        isLoading={destinations.isPending}
        defaultSort={{ column: "name", direction: "ascending" }}
        onRowAction={(d) => setSheet({ mode: "edit", destination: d })}
        emptyState={<EmptyState variant="centred" title="No kitchen displays at this outlet" hint="Without one, kitchen tickets only print." />}
      />
      <InlineError error={destinations.error} className="mt-4" />
      <DestinationSheet state={sheet} outletId={outletId} canEdit={canEdit} onClose={() => setSheet(null)} />
    </section>
  );
}

function DestinationSheet({ state, outletId, canEdit, onClose }: { state: SheetState; outletId: string; canEdit: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const destination = state?.mode === "edit" ? state.destination : null;
  const form = useForm<Values>({ resolver: zodResolver(Schema), defaultValues: defaults(destination) });
  const reset = form.reset;
  useEffect(() => {
    if (state) reset(defaults(state.mode === "edit" ? state.destination : null));
  }, [state, reset]);
  const settle = async () => {
    await qc.invalidateQueries({ queryKey: ["display-destinations", outletId] });
    onClose();
  };
  const save = useMutation<unknown, ApiError, Values>({
    mutationFn: (v) => {
      const body = { ...v, name: v.name.trim() };
      return destination ? req(api.PATCH("/v1/display-destinations/{id}", { params: { path: { id: destination.id } }, body })) : req(api.POST("/v1/display-destinations", { body: { ...body, outlet_id: outletId } }));
    },
    onSuccess: settle,
  });
  const archive = useMutation<unknown, ApiError, boolean>({
    mutationFn: (archived) => req(api.PATCH("/v1/display-destinations/{id}", { params: { path: { id: destination!.id } }, body: { archived } })),
    onSuccess: settle,
  });
  const busy = save.isPending || archive.isPending;

  useFreshErrors(state, form.watch(), save, archive);
  return (
    <Sheet
      isOpen={state !== null}
      onOpenChange={(open) => !open && onClose()}
      isDismissable={!busy}
      title={destination ? destination.name : "New display destination"}
      description="A kitchen display destination, routed like a kitchen printer. Display stations show the destinations they are given."
      footer={
        <>
          {destination && canEdit ? (
            <Button variant={destination.archived ? "secondary" : "destructive"} onPress={() => archive.mutate(!destination.archived)} isPending={archive.isPending} isDisabled={save.isPending} className="mr-auto">
              {destination.archived ? "Restore destination" : "Archive destination"}
            </Button>
          ) : null}
          <Button variant="quiet" onPress={onClose} isDisabled={busy}>
            {canEdit ? "Cancel" : "Close"}
          </Button>
          {canEdit ? (
            <Button variant="primary" type="submit" form="destination-form" isPending={save.isPending} isDisabled={archive.isPending}>
              {destination ? "Save changes" : "Add destination"}
            </Button>
          ) : null}
        </>
      }
    >
      <form id="destination-form" noValidate onSubmit={form.handleSubmit((v) => save.mutate(v))} className="flex flex-col gap-8">
        <fieldset disabled={!canEdit} className="contents">
        <FieldsLocked locked={!canEdit}>
          <FormSection>
            <RhfTextField control={form.control} name="name" label="Name" placeholder="Hot line" autoFocus={!destination} />
          </FormSection>
          <FormSection variant="label" title="Routing" hint="An item goes to every display destination whose include tags it carries. Items that match no destination go to the default one.">
            <Controller control={form.control} name="include_tags" render={({ field }) => <TagsField label="Include tags" value={field.value} onChange={field.onChange} placeholder="kitchen, grill, bar…" description="Empty means every item (unless this is the default, which then takes only the leftovers)." isDisabled={!canEdit} />} />
            <Controller control={form.control} name="exclude_tags" render={({ field }) => <TagsField label="Exclude tags" value={field.value} onChange={field.onChange} placeholder="drinks…" description="Items with any of these tags skip this display." isDisabled={!canEdit} />} />
            <RhfCheckboxGroup control={form.control} name="order_types" label="Order types" description="Leave all unticked for every type." columns={2} options={ORDER_TYPES.map((t) => ({ id: t, label: ORDER_TYPE_LABEL[t]! }))} />
            <RhfCheckboxGroup control={form.control} name="sources" label="Sources" description="Leave both unticked for every source." columns={2} options={(["pos", "guest"] as const).map((s) => ({ id: s, label: SOURCE_LABEL[s]! }))} />
            <RhfSwitch control={form.control} name="is_default" description="Receives items that match no other display destination.">
              Default display destination
            </RhfSwitch>
          </FormSection>
        </FieldsLocked>
        </fieldset>
        <InlineError error={save.error ?? archive.error} />
      </form>
    </Sheet>
  );
}
