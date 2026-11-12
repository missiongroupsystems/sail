"use client";

import { Button, InlineError, TextField, useLocale } from "@sail/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { FormSection } from "@/components/forms/fields";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Staff } from "@/lib/api/types";
import { useSession } from "@/lib/session-context";

type Shown = { kind: "link" | "pre_authorised"; email: string; url: string | null };

/** Admin only: whether this person can sign in to the back office, and the invite, reset and revoke actions. */
export function AccessSection({ staff, emailUnsaved }: { staff: Staff; emailUnsaved: boolean }) {
  const { me } = useSession();
  const { stamp } = useLocale();
  const qc = useQueryClient();
  const [shown, setShown] = useState<Shown | null>(null);
  const [copied, setCopied] = useState(false);
  const key = ["staff", staff.id, "access"] as const;
  const access = useQuery({ queryKey: key, queryFn: () => req(api.GET("/v1/staff/{id}/access", { params: { path: { id: staff.id } } })).then((r) => r.data) });

  const act = useMutation<Shown | null, ApiError, "invite" | "reset" | "revoke">({
    mutationFn: async (action) => {
      const params = { params: { path: { id: staff.id } }, body: {} };
      if (action === "invite") return (await req(api.POST("/v1/staff/{id}/invite", params))).data;
      if (action === "reset") return (await req(api.POST("/v1/staff/{id}/password-reset", params))).data;
      await req(api.POST("/v1/staff/{id}/revoke-access", params));
      return null;
    },
    onSuccess: async (result) => {
      setShown(result);
      setCopied(false);
      await qc.invalidateQueries({ queryKey: key });
      await qc.invalidateQueries({ queryKey: ["staff"] });
    },
  });

  const a = access.data;
  const local = a?.provider === "local";
  const copy = async () => {
    if (!shown?.url) return;
    await navigator.clipboard.writeText(shown.url);
    setCopied(true);
  };

  return (
    <FormSection title="Back-office access" hint={local ? "People sign in with their email and a password they set from a link you give them." : "People sign in through your organisation's identity provider."}>
      {a ? (
        <p className="text-ink-2">
          {a.status === "active"
            ? `Can sign in as ${a.email ?? "their email"}.`
            : a.status === "invited"
              ? a.link
                ? `Invited; the link works until ${stamp(a.link.expires_at)}.`
                : `Pre-authorised: they can sign in as ${a.email ?? "their email"}.`
              : "No back-office access."}
          {a.status === "active" && a.link?.kind === "reset" ? ` A reset link works until ${stamp(a.link.expires_at)}.` : ""}
        </p>
      ) : null}
      {shown?.url ? (
        <div className="flex flex-col gap-2">
          <TextField label="Link for this person (shown once)" value={shown.url} isReadOnly description="Send it to them yourself. Anyone with the link can set this person's password until it is used or expires." />
          <div>
            <Button variant="secondary" onPress={() => void copy()}>
              {copied ? "Copied" : "Copy link"}
            </Button>
          </div>
        </div>
      ) : null}
      {shown?.kind === "pre_authorised" ? <p className="text-ink">They can now sign in as {shown.email}.</p> : null}
      {a ? (
        <div className="flex flex-wrap items-center gap-2">
          {a.status !== "active" ? (
            <Button variant="secondary" onPress={() => act.mutate("invite")} isPending={act.isPending && act.variables === "invite"} isDisabled={!staff.email || emailUnsaved || !staff.active}>
              {a.status === "invited" && local ? "New invite link" : "Invite to the back office"}
            </Button>
          ) : null}
          {a.status === "active" && local ? (
            <Button variant="secondary" onPress={() => act.mutate("reset")} isPending={act.isPending && act.variables === "reset"} isDisabled={!staff.active}>
              Password reset link
            </Button>
          ) : null}
          {a.status !== "none" && staff.id !== me.id ? (
            <Button variant="quiet" onPress={() => act.mutate("revoke")} isPending={act.isPending && act.variables === "revoke"}>
              Revoke access
            </Button>
          ) : null}
        </div>
      ) : null}
      {!staff.email || emailUnsaved ? <p className="text-caption text-ink-2">Save an email for this person to invite them.</p> : null}
      <InlineError error={act.error ?? access.error} />
    </FormSection>
  );
}
