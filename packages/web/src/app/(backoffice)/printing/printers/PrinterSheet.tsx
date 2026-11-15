"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Button, InlineError, Sheet, TagsField, FieldsLocked } from "@sail/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { ORDER_TYPES, ORDER_TYPE_LABEL } from "@/components/backoffice/labels";
import { SOURCE_LABEL, type CreatedJob, type Printer, type PrinterCreate, type PrinterPatch } from "@/components/backoffice/register";
import { Warnings } from "@/components/backoffice/Warnings";
import { FormSection, RhfCheckboxGroup, RhfSelect, RhfSwitch, RhfTextField } from "@/components/forms/fields";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Station } from "@/lib/api/types";
import { useFreshErrors } from "@/lib/fresh-errors";

export type PrinterSheetState = { mode: "create" } | { mode: "edit"; printer: Printer } | null;

const NONE = "__none__";
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

const Schema = z.object({
  name: z.string().trim().min(1, "Enter a name"),
  ip: z.string().trim().refine((v) => IPV4.test(v) || /^[a-z0-9.-]+$/i.test(v), "Enter an IPv4 address like 192.168.1.50"),
  port: z.string().regex(/^\d+$/, "Enter a port number").refine((v) => Number(v) >= 1 && Number(v) <= 65535, "Ports run from 1 to 65535"),
  paper_width: z.enum(["80mm", "58mm"]),
  role: z.enum(["kitchen", "receipt"]),
  station_id: z.string(),
  include_tags: z.array(z.string()),
  exclude_tags: z.array(z.string()),
  order_types: z.array(z.enum(ORDER_TYPES)),
  sources: z.array(z.enum(["pos", "guest"])),
  copies: z.string().regex(/^\d+$/, "Enter a number").refine((v) => Number(v) >= 1 && Number(v) <= 5, "1 to 5 copies"),
  backup_printer_id: z.string(),
  is_default_kitchen: z.boolean(),
  supports_status: z.boolean(),
  code_page_cjk: z.boolean(),
  cut: z.boolean(),
  beep: z.boolean(),
});
type Values = z.infer<typeof Schema>;

function defaults(p: Printer | null): Values {
  return {
    name: p?.name ?? "",
    ip: p?.ip ?? "",
    port: String(p?.port ?? 9100),
    paper_width: p?.paper_width ?? "80mm",
    role: p?.role ?? "kitchen",
    station_id: p?.station_id ?? NONE,
    include_tags: p?.include_tags ?? [],
    exclude_tags: p?.exclude_tags ?? [],
    order_types: (p?.order_types ?? []) as Values["order_types"],
    sources: (p?.sources ?? []) as Values["sources"],
    copies: String(p?.copies ?? 1),
    backup_printer_id: p?.backup_printer_id ?? NONE,
    is_default_kitchen: p?.is_default_kitchen ?? false,
    supports_status: p?.supports_status ?? true,
    code_page_cjk: p?.code_page_cjk ?? false,
    cut: p?.cut ?? true,
    beep: p?.beep ?? false,
  };
}

function toBody(v: Values): PrinterPatch {
  const kitchen = v.role === "kitchen";
  return {
    name: v.name.trim(),
    ip: v.ip.trim(),
    port: Number(v.port),
    paper_width: v.paper_width,
    role: v.role,
    station_id: v.station_id === NONE ? null : v.station_id,
    include_tags: kitchen ? v.include_tags : [],
    exclude_tags: kitchen ? v.exclude_tags : [],
    order_types: kitchen ? v.order_types : [],
    sources: kitchen ? v.sources : [],
    copies: Number(v.copies),
    backup_printer_id: v.backup_printer_id === NONE ? null : v.backup_printer_id,
    is_default_kitchen: kitchen ? v.is_default_kitchen : false,
    supports_status: v.supports_status,
    code_page_cjk: v.code_page_cjk,
    cut: v.cut,
    beep: v.beep,
  };
}

/** Create or edit a printer. The backup picker only offers printers of the same role. */
export function PrinterSheet({ state, outletId, printers, stations, canEdit, onClose }: { state: PrinterSheetState; outletId: string; printers: Printer[]; stations: Station[]; canEdit: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const printer = state?.mode === "edit" ? state.printer : null;
  const form = useForm<Values>({ resolver: zodResolver(Schema), defaultValues: defaults(printer) });
  const [warnings, setWarnings] = useState<string[]>([]);
  const [testNote, setTestNote] = useState<string | null>(null);
  const reset = form.reset;
  useEffect(() => {
    if (state) {
      reset(defaults(state.mode === "edit" ? state.printer : null));
      setWarnings([]);
      setTestNote(null);
    }
  }, [state, reset]);

  const role = form.watch("role");
  const backups = printers.filter((p) => p.id !== printer?.id && !p.archived && p.role === role);

  const settle = async (w: string[]) => {
    await qc.invalidateQueries({ queryKey: ["printers"] });
    if (w.length) setWarnings(w);
    else onClose();
  };
  const save = useMutation<{ data: Printer; warnings: string[] }, ApiError, Values>({
    mutationFn: async (v) => {
      const body = toBody(v);
      if (printer) return req(api.PATCH("/v1/printers/{id}", { params: { path: { id: printer.id } }, body }));
      const create: PrinterCreate = { ...(body as Omit<PrinterCreate, "outlet_id">), outlet_id: outletId, name: body.name!, ip: body.ip! };
      return req(api.POST("/v1/printers", { body: create }));
    },
    onSuccess: (r) => settle(r.warnings),
  });
  const archive = useMutation<{ data: Printer; warnings: string[] }, ApiError, boolean>({
    mutationFn: (archived) => req(api.PATCH("/v1/printers/{id}", { params: { path: { id: printer!.id } }, body: { archived } })),
    onSuccess: (r) => settle(r.warnings),
  });
  const test = useMutation<{ data: CreatedJob[]; warnings: string[] }, ApiError>({
    mutationFn: () => req(api.POST("/v1/printers/{id}/test", { params: { path: { id: printer!.id } }, body: {} })),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ["print-jobs"] });
      setTestNote(`Test ticket queued${r.data[0] ? ` · job ${r.data[0].id.slice(0, 8)}` : ""}. It prints when the relay picks it up; see Print jobs.`);
      if (r.warnings.length) setWarnings(r.warnings);
    },
  });
  const busy = save.isPending || archive.isPending;

  useFreshErrors(state, form.watch(), save, archive, test);
  return (
    <Sheet
      isOpen={state !== null}
      onOpenChange={(open) => !open && onClose()}
      isDismissable={!busy}
      width="lg"
      title={printer ? printer.name : "New printer"}
      description={printer ? <span className="font-mono">{printer.ip}:{printer.port}</span> : "An ESC/POS printer on the outlet LAN, reached by the relay over TCP port 9100."}
      footer={
        <>
          {printer && canEdit ? (
            <Button variant={printer.archived ? "secondary" : "destructive"} onPress={() => archive.mutate(!printer.archived)} isPending={archive.isPending} isDisabled={save.isPending} className="mr-auto">
              {printer.archived ? "Restore printer" : "Archive printer"}
            </Button>
          ) : null}
          <Button variant="quiet" onPress={onClose} isDisabled={busy}>
            {canEdit ? "Cancel" : "Close"}
          </Button>
          {canEdit ? (
            <Button variant="primary" type="submit" form="printer-form" isPending={save.isPending} isDisabled={archive.isPending}>
              {printer ? "Save changes" : "Add printer"}
            </Button>
          ) : null}
        </>
      }
    >
      <form id="printer-form" noValidate onSubmit={form.handleSubmit((v) => save.mutate(v))} className="flex flex-col gap-8">
        <fieldset disabled={!canEdit} className="contents">
        <FieldsLocked locked={!canEdit}>
          <FormSection>
            <RhfTextField control={form.control} name="name" label="Name" placeholder="Kitchen · Wok" autoFocus={!printer} />
            <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <RhfTextField control={form.control} name="ip" label="IP address" placeholder="192.168.1.50" mono description="Give the printer a fixed or reserved address on the LAN." />
              <RhfTextField control={form.control} name="port" label="Port" numeric inputMode="numeric" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <RhfSelect
                control={form.control}
                name="role"
                label="Role"
                items={[
                  { id: "kitchen", label: "Kitchen", description: "Kitchen and void tickets, routed by tags." },
                  { id: "receipt", label: "Receipt", description: "Bills, receipts, refund receipts and the Z-report." },
                ]}
              />
              <RhfSelect
                control={form.control}
                name="paper_width"
                label="Paper width"
                items={[
                  { id: "80mm", label: "80 mm", description: "48 columns" },
                  { id: "58mm", label: "58 mm", description: "32 columns" },
                ]}
              />
            </div>
            <RhfSelect
              control={form.control}
              name="station_id"
              label="Station"
              description={role === "kitchen" ? "A station-bound kitchen printer only takes items fired from that station (a bar printer at the bar station)." : "The station whose receipts print here. Set it on the station too."}
              items={[{ id: NONE, label: "Any station", description: "Serves the whole outlet." }, ...stations.filter((s) => !s.archived).map((s) => ({ id: s.id, label: s.name }))]}
            />
          </FormSection>

          {role === "kitchen" ? (
            <FormSection variant="label" title="Routing" hint="An item goes to every kitchen printer whose include tags it carries. Items that match no printer go to the default kitchen printer.">
              <Controller
                control={form.control}
                name="include_tags"
                render={({ field }) => <TagsField label="Include tags" value={field.value} onChange={field.onChange} placeholder="kitchen, grill, bar…" description="Empty means every item (unless this is the default printer, which then takes only the leftovers)." isDisabled={!canEdit} />}
              />
              <Controller control={form.control} name="exclude_tags" render={({ field }) => <TagsField label="Exclude tags" value={field.value} onChange={field.onChange} placeholder="drinks…" description="Items with any of these tags skip this printer." isDisabled={!canEdit} />} />
              <RhfCheckboxGroup control={form.control} name="order_types" label="Order types" description="Leave all unticked for every type." columns={2} options={ORDER_TYPES.map((t) => ({ id: t, label: ORDER_TYPE_LABEL[t]! }))} />
              <RhfCheckboxGroup control={form.control} name="sources" label="Sources" description="Leave both unticked for every source." columns={2} options={(["pos", "guest"] as const).map((s) => ({ id: s, label: SOURCE_LABEL[s]! }))} />
              <RhfSwitch control={form.control} name="is_default_kitchen" description="Receives items that match no other printer. One per outlet.">
                Default kitchen printer
              </RhfSwitch>
            </FormSection>
          ) : null}

          <FormSection variant="label" title="Output">
            <div className="grid gap-3 sm:grid-cols-2">
              <RhfTextField control={form.control} name="copies" label="Copies" numeric inputMode="numeric" description="Each copy is its own job." />
              <RhfSelect
                control={form.control}
                name="backup_printer_id"
                label="Backup printer"
                description={`Where waiting tickets go when this printer fails. ${role === "kitchen" ? "Kitchen" : "Receipt"} printers only.`}
                items={[{ id: NONE, label: "No backup" }, ...backups.map((p) => ({ id: p.id, label: p.name, description: `${p.ip}:${p.port}` }))]}
              />
            </div>
            <RhfSwitch control={form.control} name="supports_status" description="Turn off for printers that do not answer the DLE EOT query; the relay then prints without checking paper and cover.">
              Supports status
            </RhfSwitch>
            <RhfSwitch control={form.control} name="code_page_cjk" description="Chinese, Japanese and Korean item names in the printer's CJK code page.">
              CJK code page
            </RhfSwitch>
            <RhfSwitch control={form.control} name="cut">
              Cut after each ticket
            </RhfSwitch>
            <RhfSwitch control={form.control} name="beep">
              Beep on kitchen tickets
            </RhfSwitch>
          </FormSection>
        </FieldsLocked>
        </fieldset>

        {printer && !printer.archived ? (
          <FormSection variant="label" title="Test print" hint="Queues a ticket reading TEST PRINT with the printer's address. Admin only.">
            <div className="flex flex-wrap items-center gap-3">
              <Button onPress={() => test.mutate()} isPending={test.isPending} isDisabled={!canEdit}>
                Test print
              </Button>
              {testNote ? <span className="text-caption text-ink-2">{testNote}</span> : null}
            </div>
            <InlineError error={test.error} />
          </FormSection>
        ) : null}

        <Warnings warnings={warnings} />
        <InlineError error={save.error ?? archive.error} />
      </form>
    </Sheet>
  );
}
