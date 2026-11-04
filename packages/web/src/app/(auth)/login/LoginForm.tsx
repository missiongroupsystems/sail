"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Button, InlineError, TextField } from "@sail/ui";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { ApiError, toApiError } from "@/lib/api";

export type LoginMode = { kind: "dev" } | { kind: "supabase"; url: string; anonKey: string };

type Values = { email: string; password: string };

function schemaFor(mode: LoginMode) {
  return z.object({
    email: z.email("Enter an email address"),
    password: mode.kind === "supabase" ? z.string().min(1, "Enter your password") : z.string(),
  });
}

async function createSession(body: { kind: "dev"; email: string } | { kind: "token"; token: string }): Promise<void> {
  const res = await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw ApiError.from(res.status, await res.json().catch(() => null));
}

export function LoginForm({ mode, nextPath }: { mode: LoginMode; nextPath: string }) {
  const router = useRouter();
  const [error, setError] = useState<ApiError | null>(null);
  const schema = useMemo(() => schemaFor(mode), [mode]);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { email: mode.kind === "dev" ? "admin@sail.local" : "", password: "" },
  });

  const submit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      if (mode.kind === "supabase") {
        const { createBrowserClient } = await import("@supabase/ssr");
        const supabase = createBrowserClient(mode.url, mode.anonKey);
        const { data, error: signInError } = await supabase.auth.signInWithPassword({ email: values.email, password: values.password });
        if (signInError || !data.session) {
          throw new ApiError({ code: "unauthenticated", message: signInError?.message ?? "Sign-in failed", remedy: "Check the email and password, then try again." }, 401);
        }
        await createSession({ kind: "token", token: data.session.access_token });
      } else {
        await createSession({ kind: "dev", email: values.email });
      }
      router.replace(nextPath);
      router.refresh();
    } catch (e) {
      setError(toApiError(e));
    }
  });

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <Controller
        control={form.control}
        name="email"
        render={({ field, fieldState }) => (
          <TextField
            label="Email"
            type="email"
            autoComplete="username"
            inputMode="email"
            autoFocus
            value={field.value}
            onChange={field.onChange}
            onBlur={field.onBlur}
            isInvalid={!!fieldState.error}
            errorMessage={fieldState.error?.message}
          />
        )}
      />
      {mode.kind === "supabase" ? (
        <Controller
          control={form.control}
          name="password"
          render={({ field, fieldState }) => (
            <TextField
              label="Password"
              type="password"
              autoComplete="current-password"
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
              isInvalid={!!fieldState.error}
              errorMessage={fieldState.error?.message}
            />
          )}
        />
      ) : null}
      <InlineError error={error} />
      <Button type="submit" variant="primary" isPending={form.formState.isSubmitting} className="mt-2 w-full">
        Sign in
      </Button>
      <p className="text-caption text-ink-2">
        {mode.kind === "dev"
          ? "Development sign-in: the register issues a 12-hour token for this email. Not available in production."
          : "Signed in with your organisation's account."}
      </p>
    </form>
  );
}
