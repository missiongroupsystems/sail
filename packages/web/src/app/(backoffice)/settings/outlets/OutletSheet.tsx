"use client";

import { useConfirm } from "@/components/backoffice/Confirm";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button, FieldText, InlineError, Sheet, Switch, TextField, FieldsLocked } from "@sail/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { greyPill, greyPillAlert, SheetSection } from "@/components/office/parts";
import { applyServerErrors } from "@/components/office/server-errors";
import { RhfSelect, RhfTextField } from "@/components/forms/fields";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Outlet, OutletCreate } from "@/lib/api/types";
import { keepShownOutlet } from "@/lib/cookies";
import { keys } from "@/lib/query";
import { useSession } from "@/lib/session-context";
import { formToHours, hoursToForm, TIME_RE, WEEKDAY_LABEL, WEEKDAYS, type HoursForm } from "@/lib/hours";
import { useFreshErrors } from "@/lib/fresh-errors";
import { useCan } from "@/lib/can";
import { useRecheckErrors } from "@/lib/recheck-errors";

export type OutletSheetState = { mode: "create" } | { mode: "edit"; outlet: Outlet } | null;

const timeMessage = "Use 24-hour time, like 11:00";

const DaySchema = z
  .object({ open: z.boolean(), from: z.string(), to: z.string() })
  .superRefine((d, ctx) => {
    if (!d.open) return;
    if (!TIME_RE.test(d.from)) ctx.addIssue({ code: "custom", path: ["from"], message: timeMessage });
    if (!TIME_RE.test(d.to)) ctx.addIssue({ code: "custom", path: ["to"], message: timeMessage });
  });

const Schema = z.object({
  name: z.string().trim().min(1, "Enter a name"),
  brand_id: z.string().min(1, "Choose a brand"),
  address: z.string(),
  phone: z.string(),
  business_registration_no: z.string(),
  tax_registration_no: z.string(),
  business_day_cutoff: z.string().refine((v) => v === "" || TIME_RE.test(v), "Use 24-hour time, like 04:00"),
  hours: z.object({ mon: DaySchema, tue: DaySchema, wed: DaySchema, thu: DaySchema, fri: DaySchema, sat: DaySchema, sun: DaySchema }),
});
type Values = z.infer<typeof Schema>;

function defaults(outlet: Outlet | null, brandId: string | null = null): Values {
  return {
    name: outlet?.name ?? "",
    // A new outlet starts on the merchant's only brand; with several, the brand is left to choose.
    brand_id: outlet?.brand_id ?? brandId ?? "",
    address: outlet?.address ?? "",
    phone: outlet?.phone ?? "",
    business_registration_no: outlet?.business_registration_no ?? "",
    tax_registration_no: outlet?.tax_registration_no ?? "",
    business_day_cutoff: outlet?.business_day_cutoff ?? "",
    hours: outlet ? hoursToForm(outlet.hours) : hoursToForm(undefined),
  };
}

function toBody(v: Values): Omit<OutletCreate, "id"> {
  return {
    name: v.name.trim(),
    brand_id: v.brand_id,
    address: v.address.trim() || null,
    phone: v.phone.trim() || null,
    business_registration_no: v.business_registration_no.trim() || null,
    tax_registration_no: v.tax_registration_no.trim() || null,
    business_day_cutoff: v.business_day_cutoff || null,
    hours: formToHours(v.hours as HoursForm),
  };
}

export function OutletSheet({ state, onClose }: { state: OutletSheetState; onClose: () => void }) {
  const confirm = useConfirm();
  const qc = useQueryClient();
  const router = useRouter();
  const session = useSession();
  const { business_registration_label, tax_registration_label, business_day_cutoff } = session.merchant.settings;
  const outlet = state?.mode === "edit" ? state.outlet : null;
  // An outlet belongs to one brand. The list is the merchant's brands; an outlet on an archived brand still names it.
  const brands = useQuery({ queryKey: keys.brands(true), queryFn: () => req(api.GET("/v1/brands", { params: { query: { include_archived: "true" } } })).then((r) => r.data), enabled: state !== null });
  const brandItems = (brands.data ?? []).filter((b) => !b.archived || b.id === outlet?.brand_id).map((b) => ({ id: b.id, label: b.name }));
  const onlyBrand = brandItems.length === 1 ? brandItems[0]!.id : null;
  // With one brand there is nothing to choose. An outlet that has orders or channels keeps its brand (the register
  // refuses a change), so its brand is shown, not offered; until that is known it is shown too.
  const brandChoice = brands.isError || brandItems.length > 1;
  const brandLocked = useQuery({
    queryKey: ["outlets", outlet?.id, "brand-locked"],
    enabled: state !== null && !!outlet && brandChoice,
    queryFn: async () => {
      const [orders, links] = await Promise.all([
        req(api.GET("/v1/outlets/{id}/orders", { params: { path: { id: outlet!.id }, query: { limit: 1 } } })),
        req(api.GET("/v1/channel-links", { params: { query: { outlet_id: outlet!.id, include_archived: "true" } } })),
      ]);
      return orders.data.length > 0 || links.data.length > 0;
    },
  });
  const brandShown = outlet && brandChoice && !brandLocked.isError && brandLocked.data !== false ? (brands.data?.find((b) => b.id === outlet.brand_id)?.name ?? null) : null;
  const form = useForm<Values>({ resolver: zodResolver(Schema), defaultValues: defaults(outlet, onlyBrand) });
  useRecheckErrors(form);

  const reset = form.reset;
  useEffect(() => {
    if (state) reset(defaults(state.mode === "edit" ? state.outlet : null, onlyBrand));
  }, [state, reset, onlyBrand]);

  const settle = async () => {
    await qc.invalidateQueries({ queryKey: ["outlets"] });
    router.refresh();
    onClose();
  };

  const save = useMutation<Outlet, ApiError, Values>({
    mutationFn: async (values) => {
      const body = toBody(values);
      const res = outlet
        ? await req(api.PATCH("/v1/outlets/{id}", { params: { path: { id: outlet.id } }, body }))
        : await req(api.POST("/v1/outlets", { body }));
      return res.data;
    },
    onSuccess: async (saved) => {
      // A new outlet does not take over the per-outlet pages: they stay on the outlet they were showing.
      const keep = outlet ? null : keepShownOutlet(session.scope, qc.getQueryData<Outlet[]>(keys.outlets(true)) ?? [], saved);
      if (keep) await fetch("/api/prefs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: keep }) }).catch(() => undefined);
      await settle();
    },
    // A refusal that names a field shows under it; the message also stays at the foot of the form.
    onError: (e) => applyServerErrors(form.setError, e, Object.keys(form.getValues())),
  });

  const archive = useMutation<Outlet, ApiError, boolean>({
    mutationFn: async (archived) => (await req(api.PATCH("/v1/outlets/{id}", { params: { path: { id: outlet!.id } }, body: { archived } }))).data,
    onSuccess: settle,
  });

  const busy = save.isPending || archive.isPending;
  const error = save.error ?? archive.error;

  const mayEdit = useCan("outlets.update");
  useFreshErrors(state, form.watch(), save, archive);
  return (
    <FieldsLocked locked={!mayEdit.ok}>
    <Sheet
      isOpen={state !== null}
      onOpenChange={(open) => !open && onClose()}
      isDismissable={!busy}
      title={outlet ? outlet.name : "New outlet"}
      description={outlet?.archived ? "Archived" : undefined}
      width="lg"
      footer={
        <>
          {outlet && mayEdit.ok ? (
            <Button
              variant="secondary"
              onPress={() => (outlet.archived ? archive.mutate(false) : confirm.ask({ title: `Archive ${outlet.name}?`, body: "It leaves the outlet lists in the back office and on the POS. Past orders and reports keep it. You can restore it later.", confirmLabel: "Archive outlet", cancelLabel: "Keep the outlet", onConfirm: () => archive.mutate(true) }))}
              isPending={archive.isPending}
              isDisabled={save.isPending}
              className={`mr-auto ${outlet.archived ? greyPill : greyPillAlert}`}
            >
              {outlet.archived ? "Restore outlet" : "Archive outlet…"}
            </Button>
          ) : null}
          <Button variant="secondary" className={greyPill} onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="outlet-form" isPending={save.isPending} isDisabled={!mayEdit.ok || archive.isPending}>
            {outlet ? "Save changes" : "Add outlet"}
          </Button>
        </>
      }
    >
      <form id="outlet-form" noValidate onSubmit={form.handleSubmit((v) => save.mutate(v))} className="flex flex-col gap-8">
        <SheetSection>
          <RhfTextField control={form.control} name="name" label="Name" isRequired placeholder="Brand · Location" autoFocus={!outlet} />
          {brandShown ? (
            <FieldText label="Brand">{brandShown}</FieldText>
          ) : brandChoice ? (
            <RhfSelect
              control={form.control}
              name="brand_id"
              label="Brand"
              isRequired
              placeholder="Choose a brand"
              items={brandItems}
              description={outlet ? "The outlet's stations, channels and orders are on this brand. It can change only while the outlet has no orders and no channels." : "An outlet trades as one brand. Its stations, channels and orders follow it."}
            />
          ) : null}
          <RhfTextField control={form.control} name="address" label="Address" multiline rows={2} />
          <div className="grid gap-4 sm:grid-cols-2">
            <RhfTextField control={form.control} name="phone" label="Phone" type="tel" inputMode="tel" numeric />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <RhfTextField control={form.control} name="business_registration_no" label={business_registration_label} />
            <RhfTextField control={form.control} name="tax_registration_no" label={tax_registration_label} />
          </div>
          <RhfTextField
            control={form.control}
            name="business_day_cutoff"
            label="Business day ends at"
            type="time"
            numeric
            // A time field shows no placeholder, so the inherited value is said here; what the cutoff means is on Merchant.
            description={`Empty uses the merchant's ${business_day_cutoff}.`}
            className="sm:max-w-[240px]"
          />
        </SheetSection>

        <SheetSection title="Hours">
          <div className="flex flex-col">
            {WEEKDAYS.map((day) => (
              <Controller
                key={day}
                control={form.control}
                name={`hours.${day}.open`}
                render={({ field: openField }) => (
                  <div className="grid grid-cols-[minmax(120px,1fr)_auto_auto_auto] items-start gap-x-3 border-b border-rule-subtle py-1.5 last:border-b-0">
                    <Switch isSelected={openField.value} onChange={openField.onChange} className="min-h-11">
                      {WEEKDAY_LABEL[day]}
                    </Switch>
                    <Controller
                      control={form.control}
                      name={`hours.${day}.from`}
                      render={({ field, fieldState }) => (
                        <TextField
                          aria-label={`${WEEKDAY_LABEL[day]} opens`}
                          type="time"
                          numeric
                          value={field.value}
                          onChange={field.onChange}
                          isDisabled={!openField.value}
                          isInvalid={!!fieldState.error}
                          errorMessage={fieldState.error?.message}
                          className="w-[132px] py-1"
                        />
                      )}
                    />
                    <span className="self-center pt-1 text-ink-2">–</span>
                    <Controller
                      control={form.control}
                      name={`hours.${day}.to`}
                      render={({ field, fieldState }) => (
                        <TextField
                          aria-label={`${WEEKDAY_LABEL[day]} closes`}
                          type="time"
                          numeric
                          value={field.value}
                          onChange={field.onChange}
                          isDisabled={!openField.value}
                          isInvalid={!!fieldState.error}
                          errorMessage={fieldState.error?.message}
                          className="w-[132px] py-1"
                        />
                      )}
                    />
                  </div>
                )}
              />
            ))}
          </div>
        </SheetSection>

        <InlineError error={error} />
      </form>
      {confirm.dialog}
    </Sheet>
    </FieldsLocked>
  );
}
