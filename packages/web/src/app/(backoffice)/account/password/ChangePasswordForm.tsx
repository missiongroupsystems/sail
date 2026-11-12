"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Button, InlineError } from "@sail/ui";
import { useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { FormSection, RhfTextField } from "@/components/forms/fields";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";

const Schema = z
  .object({ current: z.string().min(1, "Enter your current password"), password: z.string().min(12, "Use at least 12 characters"), confirm: z.string() })
  .refine((v) => v.password === v.confirm, { path: ["confirm"], message: "The two passwords differ" });
type Values = z.infer<typeof Schema>;

export function ChangePasswordForm() {
  const form = useForm<Values>({ resolver: zodResolver(Schema), defaultValues: { current: "", password: "", confirm: "" } });
  const change = useMutation<{ sessions_ended: number }, ApiError, Values>({
    mutationFn: async (v) => (await req(api.POST("/v1/auth/password", { body: { current_password: v.current, new_password: v.password } }))).data,
    onSuccess: () => form.reset(),
  });

  return (
    <form noValidate onSubmit={form.handleSubmit((v) => change.mutate(v))} className="flex max-w-[400px] flex-col gap-4">
      <FormSection>
        <RhfTextField control={form.control} name="current" label="Current password" type="password" autoComplete="current-password" />
        <RhfTextField control={form.control} name="password" label="New password" type="password" autoComplete="new-password" description="At least 12 characters." />
        <RhfTextField control={form.control} name="confirm" label="Type it again" type="password" autoComplete="new-password" />
      </FormSection>
      {change.isSuccess ? <p role="status" className="text-ink">Password changed.{change.data.sessions_ended ? ` ${change.data.sessions_ended} other session${change.data.sessions_ended === 1 ? "" : "s"} ended.` : ""}</p> : null}
      <InlineError error={change.error} />
      <div>
        <Button type="submit" variant="primary" isPending={change.isPending}>
          Change password
        </Button>
      </div>
    </form>
  );
}
