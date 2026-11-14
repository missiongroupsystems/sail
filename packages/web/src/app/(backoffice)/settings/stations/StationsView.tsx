"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Button, DataTable, Dialog, EmptyState, InlineError, Select, Sheet, StatusDot, Switch, type DataTableColumn, Pill, FieldsLocked } from "@sail/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { greyPill, greyPillAlert, SheetSection, TwoLine } from "@/components/office/parts";
import { applyServerErrors } from "@/components/office/server-errors";
import { PairingPanel } from "@/components/backoffice/PairingPanel";
import { RhfCheckboxGroup, RhfSelect, RhfSwitch, RhfTextField } from "@/components/forms/fields";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Brand, Outlet, Station } from "@/lib/api/types";
import type { Scope } from "@/lib/cookies";
import { keys } from "@/lib/query";
import { useFreshErrors } from "@/lib/fresh-errors";
import { useCan } from "@/lib/can";

const NONE = "__none__";
const HOME_LABEL: Record<string, string> = { floor: "Floor plan", takeaway: "New takeaway order" };

type SheetState = { mode: "create" } | { mode: "edit"; station: Station } | null;

const Schema = z.object({
  name: z.string().trim().min(1, "Enter a name"),
  brand_id: z.string(),
  pay_before_firing: z.boolean(),
  seats_enabled: z.boolean(),
  home: z.enum(["floor", "takeaway"]),
  kind: z.enum(["pos", "display"]),
  display_destination_ids: z.array(z.string()),
});
type Values = z.infer<typeof Schema>;

function defaults(s: Station | null): Values {
  return { name: s?.name ?? "", brand_id: s?.brand_id ?? NONE, pay_before_firing: s?.pay_before_firing ?? false, seats_enabled: s?.seats_enabled ?? true, home: s?.home ?? "floor", kind: s?.kind ?? "pos", display_destination_ids: s?.display_destination_ids ?? [] };
}

export function StationsView({
  outlets,
  brands,
  scope,
  initialOutletId,
  initialStations,
}: {
  outlets: Outlet[];
  brands: Brand[];
  scope: Scope;
  initialOutletId: string | null;
  initialStations: Station[];
}) {
  const canCreate = useCan("stations.create");
  const [outletId, setOutletId] = useState<string | null>(initialOutletId);
  const [showArchived, setShowArchived] = useState(false);
  const [sheet, setSheet] = useState<SheetState>(null);
  useEffect(() => setOutletId(initialOutletId), [initialOutletId]);

  const stations = useQuery({
    queryKey: keys.stations(outletId ?? ""),
    // Archived stations come back only when asked (a register without the flag ignores it and lists the active ones).
    queryFn: () => req(api.GET("/v1/outlets/{id}/stations", { params: { path: { id: outletId! }, query: { include_archived: "true" } } })).then((r) => r.data),
    enabled: outletId !== null,
    initialData: outletId === initialOutletId ? initialStations : undefined,
  });

  const brandName = useMemo(() => new Map(brands.map((b) => [b.id, b.name])), [brands]);
  const rows = (stations.data ?? []).filter((s) => (showArchived || !s.archived) && (!scope.brandId || !s.brand_id || s.brand_id === scope.brandId));

  const columns: DataTableColumn<Station>[] = [
    { key: "name", header: "Name", sortable: true, isRowHeader: true, width: "1.4fr", render: (s) => <TwoLine primary={s.name} meta={s.kind === "display" ? "Kitchen display" : "POS station"} /> },
    { key: "brand_id", header: "Brand", sortable: true, sortValue: (s) => (s.brand_id ? brandName.get(s.brand_id) : ""), render: (s) => <span className="text-ink-2">{s.brand_id ? brandName.get(s.brand_id) ?? "Unknown brand" : "Any brand"}</span> },
    { key: "pay_before_firing", header: "Pay before sending", sortable: true, render: (s) => (s.pay_before_firing ? "Yes" : "—") },
    { key: "seats_enabled", header: "Seats", sortable: true, render: (s) => (s.seats_enabled ? "On" : "Off") },
    { key: "home", header: "Home screen", sortable: true, render: (s) => (s.kind === "display" ? (s.display_destination_ids.length ? "Kitchen display (/kds)" : <StatusDot status="alert" label="Kitchen display · shows nothing until a destination is ticked" />) : (HOME_LABEL[s.home] ?? s.home)) },
    {
      key: "paired",
      header: "Pairing",
      sortable: true,
      render: (s) => (s.paired ? <StatusDot status="paid" label={s.device_label ? `Paired · ${s.device_label}` : "Paired"} /> : <Pill size="sm" tone="neutral">Not paired</Pill>),
    },
    {
      key: "archived",
      header: "Status",
      sortable: true,
      sortValue: (s) => (s.archived ? 1 : 0),
      render: (s) => (s.archived ? <Pill size="sm" tone="neutral">Archived</Pill> : <Pill size="sm" tone="paid">Active</Pill>),
    },
  ];

  const scopedOutlet = outlets.find((o) => o.id === scope.outletId) ?? null;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-4">
          {scopedOutlet ? (
            <p className="min-h-11 py-2.5">
              <span className="text-ink-2">Outlet </span>
              <span className="text-ink">{scopedOutlet.name}</span>
              <span className="text-caption text-ink-2"> · from the scope picker</span>
            </p>
          ) : (
            <Select
              aria-label="Outlet"
              variant="toolbar" size="sm"
              items={outlets.map((o) => ({ id: o.id, label: o.name }))}
              selectedKey={outletId}
              onSelectionChange={setOutletId}
              placeholder="Choose an outlet"
            />
          )}
          <Switch isSelected={showArchived} onChange={setShowArchived} className="min-h-11 py-0">
            Show archived
          </Switch>
        </div>
        {canCreate.ok ? (
          <Button size="sm" variant="primary" onPress={() => setSheet({ mode: "create" })} isDisabled={!outletId}>
          Add station
        </Button>
        ) : null}
      </div>

      {outlets.length === 0 ? (
        <EmptyState title="No outlets yet" hint="Stations belong to an outlet. Add an outlet first." />
      ) : (
        <DataTable
          aria-label="Stations"
          columns={columns}
          rows={rows}
          rowKey={(s) => s.id}
          isLoading={stations.isPending}
          defaultSort={{ column: "name", direction: "ascending" }}
          onRowAction={(s) => setSheet({ mode: "edit", station: s })}
          rowClassName={(s) => (s.archived ? "text-ink-2" : undefined)}
          emptyState={<EmptyState variant="centred" title="No stations at this outlet" hint="Tap Add station, then pair an iPad to it." />}
        />
      )}
      <InlineError error={stations.error} className="mt-4" />

      {outletId ? <StationSheet state={sheet} outletId={outletId} brands={brands} onClose={() => setSheet(null)} /> : null}
    </>
  );
}

function StationSheet({ state, outletId, brands, onClose }: { state: SheetState; outletId: string; brands: Brand[]; onClose: () => void }) {
  const qc = useQueryClient();
  const station = state?.mode === "edit" ? state.station : null;
  const form = useForm<Values>({ resolver: zodResolver(Schema), defaultValues: defaults(station) });
  const reset = form.reset;
  useEffect(() => {
    if (state) reset(defaults(state.mode === "edit" ? state.station : null));
  }, [state, reset]);

  const settle = async () => {
    await qc.invalidateQueries({ queryKey: ["stations", outletId] });
    onClose();
  };

  const kind = form.watch("kind");
  const destinations = useQuery({
    queryKey: ["display-destinations", outletId],
    queryFn: () => req(api.GET("/v1/display-destinations", { params: { query: { outlet_id: outletId } } })).then((r) => r.data),
    enabled: state !== null && kind === "display",
  });

  const save = useMutation<Station, ApiError, Values>({
    mutationFn: async (v) => {
      const display = v.kind === "display";
      // A display shows destinations and has no menu or service settings of its own.
      const body = display ? { name: v.name.trim(), display_destination_ids: v.display_destination_ids } : { name: v.name.trim(), brand_id: v.brand_id === NONE ? null : v.brand_id, pay_before_firing: v.pay_before_firing, seats_enabled: v.seats_enabled, home: v.home };
      const res = station
        ? await req(api.PATCH("/v1/stations/{id}", { params: { path: { id: station.id } }, body }))
        : await req(api.POST("/v1/stations", { body: { ...body, kind: v.kind, outlet_id: outletId } }));
      return res.data;
    },
    onSuccess: settle,
    // A refusal that names a field shows under it; the message also stays at the foot of the form.
    onError: (e) => applyServerErrors(form.setError, e, Object.keys(form.getValues())),
  });
  const archive = useMutation<Station, ApiError, boolean>({
    mutationFn: async (archived) => (await req(api.PATCH("/v1/stations/{id}", { params: { path: { id: station!.id } }, body: { archived } }))).data,
    onSuccess: settle,
  });
  const busy = save.isPending || archive.isPending;
  const [confirmArchive, setConfirmArchive] = useState(false);
  useEffect(() => setConfirmArchive(false), [state]);

  const mayEdit = useCan("stations.update");
  useFreshErrors(state, form.watch(), save, archive);
  return (
    <FieldsLocked locked={!mayEdit.ok}>
    <>
    <Sheet
      isOpen={state !== null}
      onOpenChange={(open) => !open && onClose()}
      isDismissable={!busy}
      title={station ? station.name : "New station"}
      description={
        station ? (
          station.paired ? (
            <StatusDot status="paid" label={station.device_label ? `Paired · ${station.device_label}` : "Paired"} />
          ) : (
            <StatusDot status="neutral" label="Not paired. Issue a pairing code below." muted />
          )
        ) : (
          "A station is one iPad at the counter or on the floor, or a kitchen display."
        )
      }
      footer={
        <>
          {station && mayEdit.ok ? (
            <Button variant="secondary" onPress={() => (station.archived ? archive.mutate(false) : setConfirmArchive(true))} isPending={archive.isPending} isDisabled={save.isPending} className={`mr-auto ${station.archived ? greyPill : greyPillAlert}`}>
              {station.archived ? "Restore station" : "Archive station…"}
            </Button>
          ) : null}
          <Button variant="secondary" className={greyPill} onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="station-form" isPending={save.isPending} isDisabled={!mayEdit.ok || archive.isPending}>
            {station ? "Save changes" : "Add station"}
          </Button>
        </>
      }
    >
      <form id="station-form" noValidate onSubmit={form.handleSubmit((v) => save.mutate(v))} className="flex flex-col gap-8">
        {station?.archived ? (
          <p className="rounded-panel bg-surface-2 px-4 py-3 text-[14px] text-ink-2">
            Archived: no device can use it. Restoring brings it back unpaired, so pair the {station.kind === "display" ? "screen" : "iPad"} again afterwards.
          </p>
        ) : null}
        <SheetSection>
          <RhfTextField control={form.control} name="name" label="Name" placeholder="Counter 1" autoFocus={!station} />
          {station ? null : (
            <RhfSelect
              control={form.control}
              name="kind"
              label="Kind"
              items={[
                { id: "pos", label: "POS station", description: "An iPad that takes orders and payments." },
                { id: "display", label: "Kitchen display", description: "A screen at /kds that shows and bumps kitchen tickets, without a PIN." },
              ]}
            />
          )}
        </SheetSection>
        {kind === "display" ? (
          <SheetSection title="Kitchen display" hint="The display shows the tickets routed to these destinations. Set their routing in Printing › Printers.">
            <RhfCheckboxGroup control={form.control} name="display_destination_ids" label="Destinations" options={(destinations.data ?? []).map((d) => ({ id: d.id, label: d.name }))} emptyHint={destinations.isPending ? "Loading the destinations…" : "No display destinations at this outlet yet. Add one in Printing › Printers."} description="Tick at least one: a kitchen display with none shows no tickets." />
          </SheetSection>
        ) : (
          <>
            <SheetSection>
              <RhfSelect
                control={form.control}
                name="brand_id"
                label="Brand"
                items={[{ id: NONE, label: "Any brand", description: "The station uses the outlet's menu as configured." }, ...brands.map((b) => ({ id: b.id, label: b.name }))]}
              />
              <RhfSelect
                control={form.control}
                name="home"
                label="Home screen"
                description="Where the station opens after sign-in."
                items={[
                  { id: "floor", label: "Floor plan", description: "Dine-in stations." },
                  { id: "takeaway", label: "New takeaway order", description: "Counter stations." },
                ]}
              />
            </SheetSection>
            <SheetSection title="Service">
              <RhfSwitch control={form.control} name="pay_before_firing" description="An order sent from this station, of any type, goes to the kitchen only once it is paid in full. QR orders from guests’ phones are not held. For counters and kiosks.">
                Pay before sending
              </RhfSwitch>
              <RhfSwitch control={form.control} name="seats_enabled" description="Shows the seat strip so lines can be assigned to guests.">
                Seats
              </RhfSwitch>
            </SheetSection>
          </>
        )}
        {station ? (
          <SheetSection title="Pairing" hint={station.kind === "display" ? "A screen becomes this display by opening /kds and entering a one-time code. The code expires in 10 minutes." : "An iPad becomes this station by entering a one-time code. The code expires in 10 minutes."}>
            <PairingPanel station={station} />
          </SheetSection>
        ) : null}
        {mayEdit.reason ? <p className="text-body text-ink-2">{mayEdit.reason}</p> : null}
        <InlineError error={save.error ?? archive.error} />
      </form>
    </Sheet>
    {station ? (
      <Dialog
        isOpen={confirmArchive}
        onOpenChange={(open) => !open && setConfirmArchive(false)}
        role="alertdialog"
        title={`Archive ${station.name}?`}
        footer={
          <>
            <Button variant="secondary" className={greyPill} onPress={() => setConfirmArchive(false)} isDisabled={archive.isPending}>
              Keep the station
            </Button>
            <Button variant="destructive" isPending={archive.isPending} onPress={() => archive.mutate(true, { onSuccess: () => setConfirmArchive(false) })}>
              Archive station
            </Button>
          </>
        }
      >
        <p>{station.paired ? `The ${station.kind === "display" ? "screen" : "iPad"} paired to it${station.device_label ? ` (${station.device_label})` : ""} is signed out at once, and anyone signed in on it is signed out too.` : "It stops appearing on this outlet's lists."} To use it again, restore it and pair a device afresh.</p>
        <InlineError error={archive.error} />
      </Dialog>
    ) : null}
    </>
    </FieldsLocked>
  );
}
