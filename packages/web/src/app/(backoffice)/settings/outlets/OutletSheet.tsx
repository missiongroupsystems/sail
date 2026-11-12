"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Button, InlineError, Sheet, Switch, TextField } from "@sail/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { FormSection, RhfTextField } from "@/components/forms/fields";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Outlet, OutletCreate } from "@/lib/api/types";
import { useSession } from "@/lib/session-context";
import { formToHours, hoursToForm, TIME_RE, WEEKDAY_LABEL, WEEKDAYS, type HoursForm } from "@/lib/hours";

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
  address: z.string(),
  phone: z.string(),
  business_registration_no: z.string(),
  tax_registration_no: z.string(),
  business_day_cutoff: z.string().refine((v) => v === "" || TIME_RE.test(v), "Use 24-hour time, like 04:00"),
  hours: z.object({ mon: DaySchema, tue: DaySchema, wed: DaySchema, thu: DaySchema, fri: DaySchema, sat: DaySchema, sun: DaySchema }),
});
type Values = z.infer<typeof Schema>;

function defaults(outlet: Outlet | null): Values {
  return {
    name: outlet?.name ?? "",
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
    address: v.address.trim() || null,
    phone: v.phone.trim() || null,
    business_registration_no: v.business_registration_no.trim() || null,
    tax_registration_no: v.tax_registration_no.trim() || null,
    business_day_cutoff: v.business_day_cutoff || null,
    hours: formToHours(v.hours as HoursForm),
  };
}

export function OutletSheet({ state, onClose }: { state: OutletSheetState; onClose: () => void }) {
  const qc = useQueryClient();
  const router = useRouter();
  const { business_registration_label, tax_registration_label } = useSession().merchant.settings;
  const outlet = state?.mode === "edit" ? state.outlet : null;
  const form = useForm<Values>({ resolver: zodResolver(Schema), defaultValues: defaults(outlet) });

  const reset = form.reset;
  useEffect(() => {
    if (state) reset(defaults(state.mode === "edit" ? state.outlet : null));
  }, [state, reset]);

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
    onSuccess: settle,
  });

  const archive = useMutation<Outlet, ApiError, boolean>({
    mutationFn: async (archived) => (await req(api.PATCH("/v1/outlets/{id}", { params: { path: { id: outlet!.id } }, body: { archived } }))).data,
    onSuccess: settle,
  });

  const busy = save.isPending || archive.isPending;
  const error = save.error ?? archive.error;

  return (
    <Sheet
      isOpen={state !== null}
      onOpenChange={(open) => !open && onClose()}
      isDismissable={!busy}
      title={outlet ? outlet.name : "New outlet"}
      description={outlet ? (outlet.archived ? "Archived" : "Edit the outlet's details and hours.") : "An outlet is a place with its own stations, printers and hours."}
      width="lg"
      footer={
        <>
          {outlet ? (
            <Button
              variant={outlet.archived ? "secondary" : "destructive"}
              onPress={() => archive.mutate(!outlet.archived)}
              isPending={archive.isPending}
              isDisabled={save.isPending}
              className="mr-auto"
            >
              {outlet.archived ? "Restore outlet" : "Archive outlet"}
            </Button>
          ) : null}
          <Button variant="quiet" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="outlet-form" isPending={save.isPending} isDisabled={archive.isPending}>
            {outlet ? "Save changes" : "Add outlet"}
          </Button>
        </>
      }
    >
      <form id="outlet-form" noValidate onSubmit={form.handleSubmit((v) => save.mutate(v))} className="flex flex-col gap-8">
        <FormSection>
          <RhfTextField control={form.control} name="name" label="Name" placeholder="Brand · Location" autoFocus={!outlet} />
          <RhfTextField control={form.control} name="address" label="Address" multiline rows={2} />
          <div className="grid gap-4 sm:grid-cols-2">
            <RhfTextField control={form.control} name="phone" label="Phone" type="tel" inputMode="tel" numeric />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <RhfTextField control={form.control} name="business_registration_no" label={business_registration_label} mono description="Shown on receipts and invoices." />
            <RhfTextField control={form.control} name="tax_registration_no" label={tax_registration_label} mono description="Shown on receipts and invoices." />
          </div>
          <RhfTextField
            control={form.control}
            name="business_day_cutoff"
            label="Business day ends at"
            type="time"
            numeric
            description="Leave empty to use the merchant's cutoff. Sales after this time count towards the same day."
            className="sm:max-w-[240px]"
          />
        </FormSection>

        <FormSection title="Hours" hint="One opening range per day. Closed days have no range.">
          <div className="flex flex-col">
            {WEEKDAYS.map((day) => (
              <Controller
                key={day}
                control={form.control}
                name={`hours.${day}.open`}
                render={({ field: openField }) => (
                  <div className="grid grid-cols-[minmax(120px,1fr)_auto_auto_auto] items-start gap-x-3 py-1 hairline-b last:border-b-0">
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
        </FormSection>

        <InlineError error={error} />
      </form>
    </Sheet>
  );
}
