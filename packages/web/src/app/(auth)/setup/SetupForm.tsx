"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { REGION_PRESET_KEYS, REGION_PRESETS } from "@sail/shared";
import { Button, deviceTimeZone, InlineError } from "@sail/ui";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { FormSection, RhfSelect, RhfTextField } from "@/components/forms/fields";
import { ApiError, toApiError } from "@/lib/api";

const PRESETS = Object.values(REGION_PRESETS);

const Schema = z
  .object({
    business_name: z.string().trim().min(1, "Enter the business name"),
    preset: z.enum(REGION_PRESET_KEYS),
    time_zone: z.string().trim().min(1, "Enter a time zone, for example Europe/London"),
    currency: z.string().trim(),
    locale: z.string().trim(),
    outlet_name: z.string().trim().min(1, "Enter the outlet's name"),
    name: z.string().trim().min(1, "Enter your name"),
    email: z.email("Enter an email address"),
    password: z.string(),
    withPassword: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.withPassword && v.password.length < 12) ctx.addIssue({ code: "custom", path: ["password"], message: "Use at least 12 characters" });
    if (v.preset === "blank" && !/^[A-Za-z]{3}$/.test(v.currency)) ctx.addIssue({ code: "custom", path: ["currency"], message: "Enter a three-letter currency code" });
    if (v.preset === "blank" && !v.locale) ctx.addIssue({ code: "custom", path: ["locale"], message: "Enter a locale, for example en-GB" });
  });
type Values = z.infer<typeof Schema>;

export function SetupForm({ withPassword }: { withPassword: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<ApiError | null>(null);
  const form = useForm<Values>({
    resolver: zodResolver(Schema),
    defaultValues: { business_name: "", preset: "blank", time_zone: "", currency: "", locale: "", outlet_name: "", name: "", email: "", password: "", withPassword },
  });
  const preset = form.watch("preset");
  const setValue = form.setValue;
  // The device's zone is known only in the browser, so the suggestion comes after the server render: the region whose
  // suggested zone is the device's, otherwise blank (no country is the default), and the device's zone.
  useEffect(() => {
    const zone = deviceTimeZone();
    setValue("time_zone", zone);
    setValue("preset", PRESETS.find((p) => p.time_zone_suggestion === zone)?.key ?? "blank");
  }, [setValue]);
  // A region suggests its time zone; the field stays editable.
  useEffect(() => {
    const zone = REGION_PRESETS[preset].time_zone_suggestion;
    if (zone) setValue("time_zone", zone);
  }, [preset, setValue]);

  const submit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "setup",
          business_name: v.business_name,
          preset: v.preset,
          time_zone: v.time_zone,
          ...(v.preset === "blank" ? { currency: v.currency.toUpperCase(), locale: v.locale } : {}),
          outlet_name: v.outlet_name,
          admin: { name: v.name, email: v.email, password: v.password },
        }),
      });
      const body = (await res.json().catch(() => null)) as { signed_in?: boolean } | null;
      if (!res.ok) throw ApiError.from(res.status, body);
      router.replace(body?.signed_in ? "/today" : "/login");
      router.refresh();
    } catch (e) {
      setError(toApiError(e));
    }
  });

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-7">
      <FormSection variant="label" title="Business">
        <RhfTextField control={form.control} name="business_name" label="Business name" autoFocus />
        <RhfSelect
          control={form.control}
          name="preset"
          label="Region"
          description="Sets up tax, tenders and cash for the region."
          items={PRESETS.map((p) => ({ id: p.key, label: p.name }))}
        />
        <RhfTextField control={form.control} name="time_zone" label="Time zone" description="An IANA zone, for example Asia/Singapore or Europe/London." />
        {preset === "blank" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <RhfTextField control={form.control} name="currency" label="Currency" placeholder="GBP" maxLength={3} />
            <RhfTextField control={form.control} name="locale" label="Locale" placeholder="en-GB" />
          </div>
        ) : null}
        <RhfTextField control={form.control} name="outlet_name" label="First outlet" />
      </FormSection>
      <div aria-hidden className="h-px bg-rule-subtle" />
      <FormSection variant="label" title="You, the first Admin">
        <RhfTextField control={form.control} name="name" label="Your name" autoComplete="name" />
        <RhfTextField control={form.control} name="email" label="Email" type="email" inputMode="email" autoComplete="username" />
        {withPassword ? <RhfTextField control={form.control} name="password" label="Password" type="password" autoComplete="new-password" description="At least 12 characters." /> : <p className="text-ink-2">You will sign in through your organisation's identity provider with this email.</p>}
      </FormSection>
      <InlineError error={error} />
      <Button type="submit" variant="primary" isPending={form.formState.isSubmitting} className="w-full">
        Set up and sign in
      </Button>
    </form>
  );
}
