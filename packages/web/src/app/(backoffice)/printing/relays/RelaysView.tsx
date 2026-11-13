"use client";

import { Button, Dialog, EmptyState, Group, InlineError, Sheet, Skeleton, StatusDot, Switch, TextField, useLocale } from "@sail/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { OutletChoice, useOutletChoice } from "@/components/backoffice/OutletChoice";
import { boKeys, can, roleIs, type Printer, type Relay } from "@/components/backoffice/register";
import { RelayCard, RelayPairingPanel, RelayStatus } from "@/components/backoffice/RelayPairingPanel";
import { FormSection } from "@/components/forms/fields";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Outlet } from "@/lib/api/types";
import type { Scope } from "@/lib/cookies";
import { useSession } from "@/lib/session-context";

export function RelaysView({ outlets, scope, initialOutletId, initialRelays, initialPrinters }: { outlets: Outlet[]; scope: Scope; initialOutletId: string | null; initialRelays: Relay[]; initialPrinters: Printer[] }) {
  const { dayClock, locale } = useLocale();
  const { me } = useSession();
  const qc = useQueryClient();
  const admin = roleIs(me, "admin");
  const canPair = can(me, "relays.pair");
  const { outletId, setOutletId } = useOutletChoice(outlets, scope, initialOutletId);
  const [showArchived, setShowArchived] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const relays = useQuery({
    queryKey: boKeys.relays(outletId ?? ""),
    queryFn: () => req(api.GET("/v1/relays", { params: { query: { outlet_id: outletId!, include_archived: "true" } } })).then((r) => r.data),
    enabled: outletId !== null,
    initialData: outletId === initialOutletId ? initialRelays : undefined,
    refetchInterval: 15_000,
  });
  const printers = useQuery({
    queryKey: boKeys.printers(outletId ?? ""),
    queryFn: () => req(api.GET("/v1/printers", { params: { query: { outlet_id: outletId!, include_archived: "true" } } })).then((r) => r.data),
    enabled: outletId !== null,
    initialData: outletId === initialOutletId ? initialPrinters : undefined,
  });

  const rows = (relays.data ?? []).filter((r) => showArchived || !r.archived).sort((a, b) => a.name.localeCompare(b.name, locale, { sensitivity: "base", numeric: true }));
  const open = (relays.data ?? []).find((r) => r.id === openId) ?? null;
  const invalidate = () => qc.invalidateQueries({ queryKey: ["relays"] });

  const create = useMutation<{ data: Relay }, ApiError, string>({
    mutationFn: (name) => req(api.POST("/v1/relays", { body: { outlet_id: outletId!, name } })),
    onSuccess: async (r) => {
      await invalidate();
      setCreating(false);
      setOpenId(r.data.id);
    },
  });

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-4">
          <OutletChoice outlets={outlets} scope={scope} outletId={outletId} onChange={setOutletId} />
          <Switch isSelected={showArchived} onChange={setShowArchived} className="min-h-11 py-0">
            Show archived
          </Switch>
        </div>
        <Button size="sm" variant="primary" onPress={() => { setNewName(""); setCreating(true); }} isDisabled={!outletId || !admin}>
          Add relay
        </Button>
      </div>

      {outlets.length === 0 ? (
        <EmptyState title="No outlets yet" hint="A relay belongs to an outlet. Add an outlet first." />
      ) : (
        <section aria-label="Print relays">
          {relays.isPending ? (
            <Skeleton lines={3} />
          ) : rows.length === 0 ? (
            <EmptyState variant="quiet" title="No relay at this outlet" hint={admin ? "Tap Add relay, then Pair: the device takes a 6-digit code on first start." : "An Admin adds and pairs relays."} />
          ) : (
            <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {rows.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setOpenId(r.id)}
                    className="press block h-full w-full rounded-[14px] text-left outline-none transition-colors duration-[120ms] hover:[&>span]:border-rule-strong hover:[&>span]:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                  >
                    <RelayCard
                      relay={r}
                      className="h-full"
                      detail={<span className="text-caption text-ink-3 tabular">{r.paired_at ? `Paired ${dayClock(r.paired_at)}` : "Not paired yet"}</span>}
                    />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <InlineError error={relays.error} className="mt-4" />
      <p className="mt-3 text-caption text-ink-2">A relay silent for 2 minutes shows Offline. Refreshes every 15 s.</p>

      <Dialog
        isOpen={creating}
        onOpenChange={(o) => !o && setCreating(false)}
        title="New relay"
        footer={
          <>
            <Button variant="quiet" onPress={() => setCreating(false)}>
              Cancel
            </Button>
            <Button variant="primary" isDisabled={!newName.trim()} isPending={create.isPending} onPress={() => create.mutate(newName.trim())}>
              Add relay
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 pt-2">
          <TextField label="Name" value={newName} onChange={setNewName} placeholder="Relay · Front counter" autoFocus />
          <InlineError error={create.error} />
        </div>
      </Dialog>

      <RelaySheet relay={open} printers={printers.data ?? []} canEdit={admin} canPair={canPair} onClose={() => setOpenId(null)} />
    </>
  );
}

function RelaySheet({ relay, printers, canEdit, canPair, onClose }: { relay: Relay | null; printers: Printer[]; canEdit: boolean; canPair: boolean; onClose: () => void }) {
  const { dayClock } = useLocale();
  const qc = useQueryClient();
  const [name, setName] = useState(relay?.name ?? "");
  useEffect(() => setName(relay?.name ?? ""), [relay?.id, relay?.name]);

  const patch = useMutation<{ data: Relay }, ApiError, { name?: string; archived?: boolean }>({
    mutationFn: (body) => req(api.PATCH("/v1/relays/{id}", { params: { path: { id: relay!.id } }, body })),
    onSuccess: async (_r, body) => {
      await qc.invalidateQueries({ queryKey: ["relays"] });
      if (body.archived !== undefined) onClose();
    },
  });
  const printerName = (id: string) => printers.find((p) => p.id === id)?.name ?? `Printer ${id.slice(0, 8)}`;
  const statuses = relay ? Object.entries(relay.printer_status) : [];

  return (
    <Sheet
      isOpen={relay !== null}
      onOpenChange={(o) => !o && onClose()}
      title={relay?.name ?? "Relay"}
      description={relay ? <RelayStatus relay={relay} /> : undefined}
      footer={
        <>
          {relay && canEdit ? (
            <Button variant={relay.archived ? "secondary" : "destructive"} onPress={() => patch.mutate({ archived: !relay.archived })} isPending={patch.isPending && patch.variables?.archived !== undefined} className="mr-auto">
              {relay.archived ? "Restore relay" : "Archive relay"}
            </Button>
          ) : null}
          <Button variant="quiet" onPress={onClose}>
            Close
          </Button>
          {canEdit ? (
            <Button variant="primary" isDisabled={!name.trim() || name.trim() === relay?.name} isPending={patch.isPending && patch.variables?.name !== undefined} onPress={() => patch.mutate({ name: name.trim() })}>
              Save name
            </Button>
          ) : null}
        </>
      }
    >
      {relay ? (
        <div className="flex flex-col gap-8">
          <FormSection>
            <TextField label="Name" value={name} onChange={setName} isDisabled={!canEdit} />
          </FormSection>
          <FormSection variant="label" title="Pairing" hint="The device exchanges the code for a token on first start. Codes expire in 15 minutes and work once.">
            <RelayPairingPanel relay={relay} canPair={canPair && !relay.archived} />
          </FormSection>
          <FormSection variant="label" title="Printers" hint="Reachability as the relay last reported it (every 30 s).">
            {statuses.length === 0 ? (
              <p className="text-ink-2">No report yet. The relay reports each printer once it is online.</p>
            ) : (
              <Group>
              <ul className="flex flex-col divide-y divide-rule-subtle">
                {statuses.map(([id, s]) => (
                  <li key={id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-4 py-2.5">
                    <span className="text-ink">{printerName(id)}</span>
                    <span className="inline-flex items-baseline gap-3">
                      <StatusDot status={s.ok ? "paid" : "alert"} label={s.ok ? "Reachable" : s.error || "Not reachable"} />
                      <span className="text-caption text-ink-2 tabular">{dayClock(s.checked_at)}</span>
                    </span>
                  </li>
                ))}
              </ul>
              </Group>
            )}
          </FormSection>
          <InlineError error={patch.error} />
        </div>
      ) : null}
    </Sheet>
  );
}
