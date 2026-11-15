"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Button, DataTable, EmptyState, InlineError, Sheet, TagsField, type DataTableColumn, Pill, FieldsLocked } from "@sail/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { greyPill, SheetSection, TwoLine } from "@/components/office/parts";
import { CHANNEL_LABEL } from "@/components/backoffice/labels";
import { RhfSelect, RhfSwitch } from "@/components/forms/fields";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Brand, ChannelLink, MenuSummary, Outlet } from "@/lib/api/types";
import { keys } from "@/lib/query";
import { useFreshErrors } from "@/lib/fresh-errors";
import { useCan } from "@/lib/can";

type SheetState = { mode: "create" } | { mode: "edit"; link: ChannelLink } | null;

const Schema = z.object({
  channel: z.enum(["pos", "scan_to_order"]),
  outlet_id: z.string().min(1, "Choose an outlet"),
  brand_id: z.string().min(1, "Choose a brand"),
  menu_id: z.string().min(1, "Choose a menu"),
  enabled: z.boolean(),
  hold_orders: z.boolean(),
  open_on_first_scan: z.boolean(),
  service_requests: z.array(z.string().trim().min(1).max(40)).max(5, "Up to 5 table request labels"),
});
type Values = z.infer<typeof Schema>;

const DEFAULT_REQUESTS = ["Water", "Cutlery", "Bill", "Call staff"];

function defaults(l: ChannelLink | null): Values {
  return {
    channel: l?.channel ?? "scan_to_order",
    outlet_id: l?.outlet_id ?? "",
    brand_id: l?.brand_id ?? "",
    menu_id: l?.menu_id ?? "",
    enabled: l?.enabled ?? true,
    hold_orders: l?.hold_orders ?? false,
    open_on_first_scan: l?.open_on_first_scan ?? true,
    service_requests: l?.service_requests ?? DEFAULT_REQUESTS,
  };
}

/** Channel links: which menu a brand serves at an outlet on each channel, with the Scan to order behaviours. */
export function ChannelsView({ initialLinks, outlets, brands, menus }: { initialLinks: ChannelLink[]; outlets: Outlet[]; brands: Brand[]; menus: MenuSummary[] }) {
  const canCreate = useCan("channel_links.create");
  const [sheet, setSheet] = useState<SheetState>(null);
  const links = useQuery({
    queryKey: keys.channelLinks,
    queryFn: () => req(api.GET("/v1/channel-links", { params: { query: { include_archived: "true" } } })).then((r) => r.data),
    initialData: initialLinks,
  });
  const outletName = useMemo(() => new Map(outlets.map((o) => [o.id, o.name])), [outlets]);
  const brandName = useMemo(() => new Map(brands.map((b) => [b.id, b.name])), [brands]);
  const menuName = useMemo(() => new Map(menus.map((m) => [m.id, m.name])), [menus]);

  const columns: DataTableColumn<ChannelLink>[] = [
    { key: "channel", header: "Channel", isRowHeader: true, sortable: true, render: (l) => (
        <Pill size="sm" tone={l.channel === "pos" ? "neutral" : "seated"}>
          {CHANNEL_LABEL[l.channel]}
        </Pill>
      ),
    },
    { key: "outlet", header: "Outlet", sortable: true, sortValue: (l) => outletName.get(l.outlet_id), render: (l) => <TwoLine primary={outletName.get(l.outlet_id) ?? "—"} /> },
    { key: "brand", header: "Brand", sortable: true, sortValue: (l) => brandName.get(l.brand_id), render: (l) => brandName.get(l.brand_id) ?? "—" },
    { key: "menu", header: "Menu", render: (l) => <span className="text-ink-2">{menuName.get(l.menu_id) ?? "—"}</span> },
    {
      key: "behaviour",
      header: "Scan to order",
      render: (l) =>
        l.channel === "scan_to_order" ? (
          <span className="text-ink-2 break-words">
            {l.hold_orders ? "Holds orders for staff" : "Sends straight to kitchen"} · {l.open_on_first_scan ? "opens on first scan" : "staff open the table"}
            {l.service_requests.length ? ` · ${l.service_requests.length} requests` : ""}
          </span>
        ) : (
          <span className="text-ink-2">—</span>
        ),
    },
    { key: "enabled", header: "Status", sortable: true, render: (l) => (l.enabled ? <Pill size="sm" tone="paid">Enabled</Pill> : <Pill size="sm" tone="neutral">Disabled</Pill>) },
  ];

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[14px] text-ink-2">A channel link says which menu a brand serves at an outlet, on the POS or through Scan to order.</p>
        {canCreate.ok ? (
          <Button size="sm" variant="primary" onPress={() => setSheet({ mode: "create" })}>
          Add channel link
        </Button>
        ) : null}
      </div>
      <DataTable
        aria-label="Channel links"
        columns={columns}
        rows={links.data}
        rowKey={(l) => l.id}
        defaultSort={{ column: "outlet", direction: "ascending" }}
        onRowAction={(l) => setSheet({ mode: "edit", link: l })}
        rowClassName={(l) => (l.enabled ? undefined : "text-ink-2")}
        emptyState={<EmptyState variant="centred" title="No channel links yet" hint="Tap Add channel link to put a menu live at an outlet." />}
      />
      <InlineError error={links.error} className="mt-4" />
      <LinkSheet state={sheet} outlets={outlets} brands={brands} menus={menus} onClose={() => setSheet(null)} />
    </>
  );
}

function LinkSheet({ state, outlets, brands, menus, onClose }: { state: SheetState; outlets: Outlet[]; brands: Brand[]; menus: MenuSummary[]; onClose: () => void }) {
  const qc = useQueryClient();
  const link = state?.mode === "edit" ? state.link : null;
  const form = useForm<Values>({ resolver: zodResolver(Schema), defaultValues: defaults(link) });
  const reset = form.reset;
  useEffect(() => {
    if (state) reset(defaults(state.mode === "edit" ? state.link : null));
  }, [state, reset]);
  const brandId = useWatch({ control: form.control, name: "brand_id" });
  const channel = useWatch({ control: form.control, name: "channel" });
  const brandMenus = menus.filter((m) => m.brand_id === brandId && !m.archived);

  const settle = async () => {
    await qc.invalidateQueries({ queryKey: keys.channelLinks });
    onClose();
  };
  const save = useMutation<unknown, ApiError, Values>({
    mutationFn: (v) =>
      link
        ? req(api.PATCH("/v1/channel-links/{id}", { params: { path: { id: link.id } }, body: { menu_id: v.menu_id, enabled: v.enabled, hold_orders: v.hold_orders, open_on_first_scan: v.open_on_first_scan, service_requests: v.service_requests } }))
        : req(api.POST("/v1/channel-links", { body: { channel: v.channel, outlet_id: v.outlet_id, brand_id: v.brand_id, menu_id: v.menu_id, enabled: v.enabled, hold_orders: v.hold_orders, open_on_first_scan: v.open_on_first_scan, service_requests: v.service_requests } })),
    onSuccess: settle,
  });

  const mayEdit = useCan("channel_links.update");
  useFreshErrors(state, form.watch(), save);
  return (
    <FieldsLocked locked={!mayEdit.ok}>
    <Sheet
      isOpen={state !== null}
      onOpenChange={(open) => !open && onClose()}
      isDismissable={!save.isPending}
      title={link ? `${CHANNEL_LABEL[link.channel]} link` : "New channel link"}
      description={link ? "Channel, outlet and brand are fixed; change the menu and behaviours." : "One link per channel, outlet and brand."}
      footer={
        <>
          <Button variant="secondary" className={greyPill} onPress={onClose} isDisabled={save.isPending}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="link-form" isDisabled={!mayEdit.ok} isPending={save.isPending}>
            {link ? "Save changes" : "Add channel link"}
          </Button>
        </>
      }
    >
      <form id="link-form" noValidate onSubmit={form.handleSubmit((v) => save.mutate(v))} className="flex flex-col gap-8">
        <SheetSection>
          <RhfSelect
            control={form.control}
            name="channel"
            label="Channel"
            isDisabled={!!link}
            items={[
              { id: "pos", label: "POS", description: "Stations at the outlet." },
              { id: "scan_to_order", label: "Scan to order", description: "Guests ordering from a QR code at the table." },
            ]}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <RhfSelect control={form.control} name="outlet_id" label="Outlet" isDisabled={!!link} items={outlets.map((o) => ({ id: o.id, label: o.name }))} placeholder="Choose an outlet" />
            <RhfSelect control={form.control} name="brand_id" label="Brand" isDisabled={!!link} items={brands.map((b) => ({ id: b.id, label: b.name }))} placeholder="Choose a brand" />
          </div>
          <RhfSelect control={form.control} name="menu_id" label="Menu" items={brandMenus.map((m) => ({ id: m.id, label: m.name }))} placeholder={brandId ? (brandMenus.length ? "Choose a menu" : "This brand has no menus yet") : "Choose a brand first"} isDisabled={!brandId || brandMenus.length === 0} />
          <RhfSwitch control={form.control} name="enabled" description="Disabled links stop serving the menu without being deleted.">
            Enabled
          </RhfSwitch>
        </SheetSection>
        {channel === "scan_to_order" ? (
          <SheetSection title="Scan to order" hint="How guest orders behave at this outlet.">
            <RhfSwitch control={form.control} name="hold_orders" description="Guest orders wait for a staff member to send them, instead of going straight to the kitchen.">
              Hold orders for staff
            </RhfSwitch>
            <RhfSwitch control={form.control} name="open_on_first_scan" description="The first scan at a free table opens the order. Off: staff seat the table first.">
              Open the table on first scan
            </RhfSwitch>
            <Controller
              control={form.control}
              name="service_requests"
              render={({ field, fieldState }) => (
                <TagsField
                  label="Table request labels"
                  description="Up to 5. Guests tap one to call staff: Water, Cutlery, Bill."
                  value={field.value}
                  onChange={(v) => field.onChange(v.slice(0, 5))}
                  normalise={false}
                  placeholder="Add a label and press Enter"
                  isInvalid={!!fieldState.error}
                  errorMessage={fieldState.error?.message}
                />
              )}
            />
          </SheetSection>
        ) : null}
        {mayEdit.reason ? <p className="text-body text-ink-2">{mayEdit.reason}</p> : null}
        <InlineError error={save.error} />
      </form>
    </Sheet>
    </FieldsLocked>
  );
}
