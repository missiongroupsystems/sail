"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Button, InlineError, TextField } from "@sail/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { ApiError, toApiError } from "@/lib/api";

/** `password`: the register checks email and password. `supabase`: the external identity provider does, in the browser. */
export type LoginMode = { kind: "password" } | { kind: "supabase"; url: string; anonKey: string } | { kind: "unconfigured" };

type Values = { email: string; password: string };

const Schema = z.object({
  email: z.email("Enter an email address"),
  password: z.string().min(1, "Enter your password"),
});

async function createSession(body: { kind: "password"; email: string; password: string } | { kind: "token"; token: string }): Promise<void> {
  const res = await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw ApiError.from(res.status, await res.json().catch(() => null));
}

/** A lockout says when to try again in minutes, not in seconds. */
function shown(e: ApiError): ApiError {
  const retry = e.details?.retry_after_seconds;
  if (e.code !== "rate_limited" || typeof retry !== "number") return e;
  const minutes = Math.ceil(retry / 60);
  return new ApiError({ code: e.code, message: "Sign-in is locked after too many failed attempts", remedy: retry < 90 ? `Try again in ${retry} seconds.` : `Try again in ${minutes} minutes.`, details: e.details }, e.status);
}

export function LoginForm({ mode, nextPath }: { mode: LoginMode; nextPath: string }) {
  const router = useRouter();
  const [error, setError] = useState<ApiError | null>(null);
  const form = useForm<Values>({ resolver: zodResolver(Schema), defaultValues: { email: "", password: "" } });
  const [email, password] = form.watch(["email", "password"]);
  const filled = Boolean(email?.trim() && password);

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
        await createSession({ kind: "password", email: values.email, password: values.password });
      }
      router.replace(nextPath);
      router.refresh();
    } catch (e) {
      setError(shown(toApiError(e)));
    }
  });

  if (mode.kind === "unconfigured") {
    return <InlineError error={{ message: "This server signs in through an external identity provider that the web app is not set up for", remedy: "Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY for the web app." }} />;
  }

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
      <InlineError error={error} />
      {/* Grey until both fields hold something. */}
      <Button type="submit" variant="primary" isDisabled={!filled} isPending={form.formState.isSubmitting} className="mt-4 w-full">
        Sign in
      </Button>
      <p className="text-center text-caption text-ink-2">
        {mode.kind === "password" ? "Forgotten your password? Ask an Admin for a reset link." : "Signed in with your organisation's account."}
      </p>
    </form>
  );
}
