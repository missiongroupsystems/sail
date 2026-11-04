"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Button, InlineError } from "@sail/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { FormSection, RhfSelect, RhfTextField } from "@/components/forms/fields";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Merchant, MerchantSettingsPatch } from "@/lib/api/types";
import { formatBps, formatClock } from "@/lib/format";
import { TIME_RE } from "@/lib/hours";
import { keys } from "@/lib/query";

const ROUNDING = [
  { id: "off", label: "Off", description: "Cash is taken to the cent." },
  { id: "5", label: "5¢", description: "Round cash totals to the nearest 5 cents." },
  { id: "10", label: "10¢" },
  { id: "50", label: "50¢" },
  { id: "100", label: "$1" },
];

const Schema = z.object({
  name: z.string().trim().min(1, "Enter the merchant's name"),
  tax_mode: z.enum(["inclusive", "exclusive"]),
  gst_bps: z
    .string()
    .trim()
    .regex(/^\d+$/, "Enter whole basis points, like 900 for 9%")
    .refine((v) => Number(v) <= 10_000, "GST cannot exceed 100%"),
  cash_rounding_increment: z.string(),
  business_day_cutoff: z.string().regex(TIME_RE, "Use 24-hour time, like 04:00"),
  receipt_footer: z.string(),
});
type Values = z.infer<typeof Schema>;

function toValues(m: Merchant): Values {
  return {
    name: m.name,
    tax_mode: m.settings.tax_mode,
    gst_bps: String(m.settings.gst_bps),
    cash_rounding_increment: m.settings.cash_rounding_increment ? String(m.settings.cash_rounding_increment) : "off",
    business_day_cutoff: m.settings.business_day_cutoff,
    receipt_footer: m.settings.receipt_footer ?? "",
  };
}

function toPatch(v: Values): MerchantSettingsPatch {
  return {
    name: v.name.trim(),
    tax_mode: v.tax_mode,
    gst_bps: Number(v.gst_bps),
    cash_rounding_increment: v.cash_rounding_increment === "off" ? null : Number(v.cash_rounding_increment),
    business_day_cutoff: v.business_day_cutoff,
    receipt_footer: v.receipt_footer.trim() || null,
  };
}

export function MerchantForm({ initialMerchant }: { initialMerchant: Merchant }) {
  const qc = useQueryClient();
  const router = useRouter();
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const merchant = useQuery({ queryKey: keys.merchant, queryFn: () => req(api.GET("/v1/merchant")).then((r) => r.data), initialData: initialMerchant });
  const form = useForm<Values>({ resolver: zodResolver(Schema), defaultValues: toValues(merchant.data) });
  const reset = form.reset;
  useEffect(() => reset(toValues(merchant.data)), [merchant.data, reset]);

  const save = useMutation<Merchant, ApiError, Values>({
    mutationFn: async (v) => (await req(api.PATCH("/v1/merchant/settings", { body: toPatch(v) }))).data,
    onSuccess: async (data) => {
      qc.setQueryData(keys.merchant, data);
      setSavedAt(new Date());
      router.refresh();
    },
  });

  const gst = form.watch("gst_bps");
  const gstPreview = /^\d+$/.test(gst) ? formatBps(Number(gst)) : null;

  return (
    <form noValidate onSubmit={form.handleSubmit((v) => save.mutate(v))} className="flex max-w-[640px] flex-col gap-10">
      <FormSection title="Merchant">
        <RhfTextField control={form.control} name="name" label="Name" />
      </FormSection>

      <FormSection title="Tax" hint="Applies to every outlet. Orders already priced keep their snapshot.">
        <RhfSelect
          control={form.control}
          name="tax_mode"
          label="Tax mode"
          items={[
            { id: "inclusive", label: "Prices include GST", description: "Menu prices are what the guest pays." },
            { id: "exclusive", label: "GST added at the bill", description: "Menu prices are before tax." },
          ]}
        />
        <RhfTextField
          control={form.control}
          name="gst_bps"
          label="GST rate"
          inputMode="numeric"
          numeric
          suffix="bps"
          description={gstPreview ? `${gst} basis points = ${gstPreview}` : "In basis points: 900 = 9%."}
          className="sm:max-w-[240px]"
        />
      </FormSection>

      <FormSection title="Cash and day">
        <RhfSelect control={form.control} name="cash_rounding_increment" label="Cash rounding" items={ROUNDING} description="Card and PayNow payments are never rounded." className="sm:max-w-[320px]" />
        <RhfTextField
          control={form.control}
          name="business_day_cutoff"
          label="Business day ends at"
          type="time"
          numeric
          description="Sales after this time count towards the same business day. Outlets can set their own."
          className="sm:max-w-[240px]"
        />
      </FormSection>

      <FormSection title="Receipts">
        <RhfTextField control={form.control} name="receipt_footer" label="Receipt footer" multiline rows={3} description="Printed under every receipt. Leave empty for none." />
      </FormSection>

      <InlineError error={save.error} />

      <div className="flex items-center gap-4 hairline-t pt-6">
        <Button variant="primary" type="submit" isPending={save.isPending} isDisabled={!form.formState.isDirty && !save.isError}>
          Save changes
        </Button>
        {savedAt && !form.formState.isDirty ? <span className="text-caption text-ink-2">Saved · {formatClock(savedAt)}</span> : null}
      </div>
    </form>
  );
}
