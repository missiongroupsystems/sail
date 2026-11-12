"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Button, InlineError, TagsField, useLocale, type LocaleFormat } from "@sail/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { FormSection, RhfSelect, RhfTextField } from "@/components/forms/fields";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Merchant, MerchantSettingsPatch } from "@/lib/api/types";
import { TIME_RE } from "@/lib/hours";
import { keys } from "@/lib/query";

/** Increments in the merchant's minor units, labelled in its currency. */
function roundingItems(money: LocaleFormat["money"]) {
  return [
    { id: "off", label: "Off", description: "Cash is taken to the smallest unit." },
    ...[5, 10, 50, 100].map((n) => ({ id: String(n), label: money(n, { dropZeroFraction: true }), description: `Round cash totals to the nearest ${money(n, { dropZeroFraction: true })}.` })),
  ];
}

function isLocale(tag: string): boolean {
  try {
    return Intl.getCanonicalLocales(tag).length === 1;
  } catch {
    return false;
  }
}

const Schema = z.object({
  name: z.string().trim().min(1, "Enter the merchant's name"),
  tax_mode: z.enum(["inclusive", "exclusive"]),
  tax_rounding: z.enum(["per_line", "per_rate"]),
  cash_rounding_increment: z.string(),
  cash_denominations: z.array(z.number().int().positive()),
  /** Money text in the merchant's locale; parsed to minor units on save. */
  cash_variance_threshold: z.string(),
  business_day_cutoff: z.string().regex(TIME_RE, "Use 24-hour time, like 04:00"),
  locale: z.string().trim().refine(isLocale, "Enter a language tag, like en-GB or de-DE"),
  business_registration_label: z.string().trim().min(1, "Enter a label"),
  tax_registration_label: z.string().trim().min(1, "Enter a label"),
  receipt_footer: z.string(),
});
type Values = z.infer<typeof Schema>;

function toValues(m: Merchant, moneyText: LocaleFormat["moneyText"]): Values {
  return {
    name: m.name,
    tax_mode: m.settings.tax_mode,
    tax_rounding: m.settings.tax_rounding,
    cash_rounding_increment: m.settings.cash_rounding_increment ? String(m.settings.cash_rounding_increment) : "off",
    cash_denominations: m.settings.cash_denominations,
    cash_variance_threshold: moneyText(m.settings.cash_variance_threshold),
    business_day_cutoff: m.settings.business_day_cutoff,
    locale: m.settings.locale,
    business_registration_label: m.settings.business_registration_label,
    tax_registration_label: m.settings.tax_registration_label,
    receipt_footer: m.settings.receipt_footer ?? "",
  };
}

function toPatch(v: Values, varianceThreshold: number): MerchantSettingsPatch {
  return {
    name: v.name.trim(),
    tax_mode: v.tax_mode,
    tax_rounding: v.tax_rounding,
    cash_rounding_increment: v.cash_rounding_increment === "off" ? null : Number(v.cash_rounding_increment),
    cash_denominations: [...v.cash_denominations].sort((a, b) => b - a),
    cash_variance_threshold: varianceThreshold,
    business_day_cutoff: v.business_day_cutoff,
    locale: v.locale.trim(),
    business_registration_label: v.business_registration_label.trim(),
    tax_registration_label: v.tax_registration_label.trim(),
    receipt_footer: v.receipt_footer.trim() || null,
  };
}

export function MerchantForm({ initialMerchant }: { initialMerchant: Merchant }) {
  const { clock, money, moneyText, parseMoney } = useLocale();
  const qc = useQueryClient();
  const router = useRouter();
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const merchant = useQuery({ queryKey: keys.merchant, queryFn: () => req(api.GET("/v1/merchant")).then((r) => r.data), initialData: initialMerchant });
  const form = useForm<Values>({ resolver: zodResolver(Schema), defaultValues: toValues(merchant.data, moneyText) });
  const reset = form.reset;
  useEffect(() => reset(toValues(merchant.data, moneyText)), [merchant.data, moneyText, reset]);

  const save = useMutation<Merchant, ApiError, { values: Values; varianceThreshold: number }>({
    mutationFn: async ({ values, varianceThreshold }) => (await req(api.PATCH("/v1/merchant/settings", { body: toPatch(values, varianceThreshold) }))).data,
    onSuccess: async (data) => {
      qc.setQueryData(keys.merchant, data);
      setSavedAt(new Date());
      router.refresh();
    },
  });

  return (
    <form
      noValidate
      onSubmit={form.handleSubmit((v) => {
        const varianceThreshold = parseMoney(v.cash_variance_threshold);
        if (typeof varianceThreshold !== "number" || varianceThreshold < 0) {
          form.setError("cash_variance_threshold", { message: "Enter an amount, like " + moneyText(500) });
          return;
        }
        save.mutate({ values: v, varianceThreshold });
      })}
      className="flex max-w-[640px] flex-col gap-10"
    >
      <FormSection title="Merchant">
        <RhfTextField control={form.control} name="name" label="Name" />
      </FormSection>

      <FormSection title="Tax" hint="Applies to every outlet. Orders already priced keep their snapshot.">
        <RhfSelect
          control={form.control}
          name="tax_mode"
          label="Tax mode"
          items={[
            { id: "inclusive", label: "Prices include tax", description: "Menu prices are what the guest pays." },
            { id: "exclusive", label: "Tax added at the bill", description: "Menu prices are before tax." },
          ]}
        />
        <RhfSelect
          control={form.control}
          name="tax_rounding"
          label="Tax rounding"
          items={[
            { id: "per_line", label: "Per line", description: "Each line's tax is rounded, then added up." },
            { id: "per_rate", label: "Per rate", description: "Tax is rounded once for each rate on the bill." },
          ]}
        />
        <p className="text-caption text-ink-2">
          Rates are set per tax class in{" "}
          <Link href="/settings/tax" className="text-ink underline underline-offset-4">
            Tax classes
          </Link>
          .
        </p>
      </FormSection>

      <FormSection title="Money and language" hint={`Amounts are in ${merchant.data.settings.currency}, which cannot change once set.`}>
        <RhfTextField control={form.control} name="locale" label="Locale" description="Formats money, dates and times, for example en-GB or de-DE." className="sm:max-w-[240px]" />
      </FormSection>

      <FormSection title="Cash and day">
        <RhfSelect control={form.control} name="cash_rounding_increment" label="Cash rounding" items={roundingItems(money)} description="Card and other non-cash payments are never rounded." className="sm:max-w-[320px]" />
        <Controller
          control={form.control}
          name="cash_denominations"
          render={({ field, fieldState }) => (
            <TagsField
              label="Notes and coins"
              description="For the cash counter at the register. Type an amount and press Enter."
              placeholder="Add an amount"
              normalise={false}
              value={field.value.map(moneyText)}
              onChange={(texts) => {
                const values = texts.map(parseMoney);
                if (values.some((v) => typeof v !== "number" || v <= 0)) {
                  form.setError("cash_denominations", { message: "Enter each note or coin as an amount, like " + moneyText(500) });
                  return;
                }
                form.clearErrors("cash_denominations");
                field.onChange([...new Set(values as number[])].sort((a, b) => b - a));
              }}
              isInvalid={!!fieldState.error}
              errorMessage={fieldState.error?.message}
            />
          )}
        />
        <RhfTextField
          control={form.control}
          name="cash_variance_threshold"
          label="Cash variance needing a reason"
          numeric
          description="Closing a shift with the drawer more than this over or short asks for a reason."
          className="sm:max-w-[240px]"
        />
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
        <div className="grid gap-4 sm:grid-cols-2">
          <RhfTextField control={form.control} name="business_registration_label" label="Business registration label" description="Printed before each outlet's business registration number." />
          <RhfTextField control={form.control} name="tax_registration_label" label="Tax registration label" description="Printed before each outlet's tax registration number." />
        </div>
        <RhfTextField control={form.control} name="receipt_footer" label="Receipt footer" multiline rows={3} description="Printed under every receipt. Leave empty for none." />
      </FormSection>

      <InlineError error={save.error} />

      <div className="flex items-center gap-4 hairline-t pt-6">
        <Button variant="primary" type="submit" isPending={save.isPending} isDisabled={!form.formState.isDirty && !save.isError}>
          Save changes
        </Button>
        {savedAt && !form.formState.isDirty ? <span className="text-caption text-ink-2">Saved · {clock(savedAt)}</span> : null}
      </div>
    </form>
  );
}
