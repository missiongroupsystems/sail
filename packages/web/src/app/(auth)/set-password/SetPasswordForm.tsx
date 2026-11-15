"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Button, InlineError } from "@sail/ui";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { RhfTextField } from "@/components/forms/fields";
import { ApiError, toApiError } from "@/lib/api";
import { useRecheckErrors } from "@/lib/recheck-errors";

const Schema = z
  .object({ password: z.string().min(12, "Use at least 12 characters"), confirm: z.string() })
  .refine((v) => v.password === v.confirm, { path: ["confirm"], message: "The two passwords differ" });
type Values = z.infer<typeof Schema>;

export function SetPasswordForm({ signedInAs }: { signedInAs: string | null }) {
  const router = useRouter();
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<ApiError | null>(null);
  /** Whose password the link sets, read from the register without using the link (F-N4). */
  const [account, setAccount] = useState<{ name: string; email: string } | null>(null);
  const [dead, setDead] = useState<ApiError | null>(null);
  const form = useForm<Values>({ resolver: zodResolver(Schema), defaultValues: { password: "", confirm: "" } });
  useRecheckErrors(form);

  useEffect(() => {
    const found = new URLSearchParams(window.location.hash.slice(1)).get("token");
    setToken(found);
    // Keep the token out of the address bar and the browser history once read.
    if (found) window.history.replaceState(null, "", window.location.pathname);
    if (found)
      fetch("/api/link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: found }) })
        .then(async (res) => {
          const body = (await res.json().catch(() => null)) as { data?: { name: string; email: string } } | null;
          if (res.ok && body?.data) setAccount({ name: body.data.name, email: body.data.email });
          else if (res.status === 404) setDead(ApiError.from(404, body));
        })
        .catch(() => undefined);
  }, []);

  const submit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      const res = await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "link", token, password: v.password }) });
      if (!res.ok) throw ApiError.from(res.status, await res.json().catch(() => null));
      router.replace("/today");
      router.refresh();
    } catch (e) {
      setError(toApiError(e));
    }
  });

  if (token === undefined) return null;
  if (!token) return <InlineError error={{ message: "This page needs the link an Admin gave you", remedy: "Open the whole link, or ask an Admin for a new one." }} />;
  if (dead) return <InlineError error={dead} />;
  const whose = account ? `${account.name} (${account.email})` : "the account it was made for";

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      {account ? (
        <p className="text-body text-ink-2">
          For <span className="font-medium text-ink">{account.name}</span> · {account.email}
        </p>
      ) : null}
      {signedInAs ? (
        <p className="rounded-tile bg-surface-2 px-4 py-3 text-[14px] leading-5 text-ink" role="status">
          This browser is signed in as {signedInAs}. The link sets the password of {whose}, and signs {signedInAs} out here.
        </p>
      ) : null}
      <RhfTextField control={form.control} name="password" label="New password" type="password" autoComplete="new-password" autoFocus />
      <RhfTextField control={form.control} name="confirm" label="Type it again" type="password" autoComplete="new-password" />
      <InlineError error={error} />
      <Button type="submit" variant="primary" isPending={form.formState.isSubmitting} className="mt-4 w-full">
        {signedInAs ? `Sign out of ${signedInAs} and set the password` : "Set password and sign in"}
      </Button>
    </form>
  );
}
