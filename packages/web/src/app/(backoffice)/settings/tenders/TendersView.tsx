"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Button, DataTable, EmptyState, InlineError, Sheet, Switch, type DataTableColumn, Pill } from "@sail/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { greyPill, greyPillAlert, SheetSection, TwoLine } from "@/components/office/parts";
import { applyServerErrors } from "@/components/office/server-errors";
import { RhfSwitch, RhfTextField } from "@/components/forms/fields";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { TenderType } from "@/lib/api/types";
import { keys } from "@/lib/query";
import { useFreshErrors } from "@/lib/fresh-errors";
import { useCan } from "@/lib/can";

type SheetState = { mode: "create" } | { mode: "edit"; tender: TenderType } | null;

const Schema = z.object({
  name: z.string().trim().min(1, "Enter a name"),
  is_cash: z.boolean(),
  opens_drawer: z.boolean(),
  is_terminal: z.boolean(),
  requires_approval: z.boolean(),
  requires_reference: z.boolean(),
  sort: z.string().regex(/^\d*$/, "A whole number"),
});
type Values = z.infer<typeof Schema>;

const defaults = (t: TenderType | null): Values => ({ name: t?.name ?? "", is_cash: t?.is_cash ?? false, opens_drawer: t?.opens_drawer ?? false, is_terminal: t?.is_terminal ?? false, requires_approval: t?.requires_approval ?? true, requires_reference: t?.requires_reference ?? false, sort: t ? String(t.sort) : "" });

/** Payment methods (the API says tender). */
export function TendersView({ initialTenders }: { initialTenders: TenderType[] }) {
  const canCreate = useCan("tender_types.create");
  const [showArchived, setShowArchived] = useState(false);
  const [sheet, setSheet] = useState<SheetState>(null);
  const tenders = useQuery({
    queryKey: keys.tenderTypes,
    queryFn: () => req(api.GET("/v1/tender-types", { params: { query: { include_archived: "true" } } })).then((r) => r.data),
    initialData: initialTenders,
  });
  const rows = tenders.data.filter((t) => showArchived || !t.archived);

  const columns: DataTableColumn<TenderType>[] = [
    { key: "sort", header: "Order", numeric: true, sortable: true, width: 80, render: (t) => t.sort },
    { key: "name", header: "Payment method", isRowHeader: true, sortable: true, width: "2fr", render: (t) => <TwoLine primary={t.name} meta={[t.is_cash ? "Cash" : null, t.is_terminal ? "Card terminal" : null].filter(Boolean).join(" · ") || undefined} /> },
    { key: "is_cash", header: "Cash", render: (t) => (t.is_cash ? "Yes · rounding applies" : "—") },
    { key: "opens_drawer", header: "Opens drawer", render: (t) => (t.opens_drawer ? "Yes" : "—") },
    // A provider-linked method names its provider and terminal (live-test E-L10); a by-hand terminal is keyed in.
    { key: "is_terminal", header: "Card terminal", render: (t) => ((t as { provider?: string | null }).provider ? <TwoLine primary={`Sent to ${(t as { provider?: string | null }).provider}`} meta={(t as { terminal_id?: string | null }).terminal_id ? `Terminal ${(t as { terminal_id?: string | null }).terminal_id}` : undefined} /> : t.is_terminal ? "Yes · amount shown to key in" : "—") },
    { key: "archived", header: "Status", sortable: true, sortValue: (t) => (t.archived ? 1 : 0), render: (t) => (t.archived ? <Pill size="sm" tone="neutral">Archived</Pill> : <Pill size="sm" tone="paid">Active</Pill>) },
  ];

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[14px] text-ink-2">Payment methods offered at the register, in the order they appear.</p>
        <div className="flex flex-wrap items-center gap-4">
          <Switch isSelected={showArchived} onChange={setShowArchived} className="min-h-11 py-0">
            Show archived
          </Switch>
          {canCreate.ok ? (
            <Button size="sm" variant="primary" onPress={() => setSheet({ mode: "create" })}>
            Add payment method
          </Button>
          ) : null}
        </div>
      </div>
      <DataTable
        aria-label="Payment methods"
        columns={columns}
        rows={rows}
        rowKey={(t) => t.id}
        defaultSort={{ column: "sort", direction: "ascending" }}
        onRowAction={(t) => setSheet({ mode: "edit", tender: t })}
        rowClassName={(t) => (t.archived ? "text-ink-2" : undefined)}
        emptyState={<EmptyState variant="centred" title="No payment methods yet" hint="Add Cash and your card terminal to start." />}
      />
      <TenderSheet state={sheet} nextSort={tenders.data.length} onClose={() => setSheet(null)} />
    </>
  );
}

function TenderSheet({ state, nextSort, onClose }: { state: SheetState; nextSort: number; onClose: () => void }) {
  const qc = useQueryClient();
  const tender = state?.mode === "edit" ? state.tender : null;
  const form = useForm<Values>({ resolver: zodResolver(Schema), defaultValues: defaults(tender) });
  const reset = form.reset;
  useEffect(() => {
    if (state) reset(defaults(state.mode === "edit" ? state.tender : null));
  }, [state, reset]);
  // A new method that is neither cash nor a card terminal (a house account) needs approval unless the Admin says otherwise.
  const [isCash, isTerminal] = form.watch(["is_cash", "is_terminal"]);
  useEffect(() => {
    if (!tender && !form.getFieldState("requires_approval").isDirty) form.setValue("requires_approval", !isCash && !isTerminal);
  }, [tender, isCash, isTerminal, form]);
  const settle = async () => {
    await qc.invalidateQueries({ queryKey: keys.tenderTypes });
    onClose();
  };
  const save = useMutation<unknown, ApiError, Values>({
    mutationFn: (v) => {
      const body = { name: v.name.trim(), is_cash: v.is_cash, opens_drawer: v.opens_drawer, is_terminal: v.is_terminal, requires_approval: v.requires_approval, requires_reference: v.requires_reference, sort: v.sort === "" ? nextSort : Number(v.sort) };
      return tender ? req(api.PATCH("/v1/tender-types/{id}", { params: { path: { id: tender.id } }, body })) : req(api.POST("/v1/tender-types", { body }));
    },
    onSuccess: settle,
    // A refusal that names a field shows under it; the message also stays at the foot of the form.
    onError: (e) => applyServerErrors(form.setError, e, Object.keys(form.getValues())),
  });
  const archive = useMutation<unknown, ApiError, boolean>({
    mutationFn: (archived) => req(api.PATCH("/v1/tender-types/{id}", { params: { path: { id: tender!.id } }, body: { archived } })),
    onSuccess: settle,
  });
  const busy = save.isPending || archive.isPending;
  const mayEdit = useCan("tender_types.update");
  useFreshErrors(state, form.watch(), save, archive);
  return (
    <Sheet
      isOpen={state !== null}
      onOpenChange={(open) => !open && onClose()}
      isDismissable={!busy}
      title={tender ? tender.name : "New payment method"}
      footer={
        <>
          {tender && mayEdit.ok ? (
            <Button variant="secondary" onPress={() => archive.mutate(!tender.archived)} isPending={archive.isPending} className={`mr-auto ${tender.archived ? greyPill : greyPillAlert}`}>
              {tender.archived ? "Restore" : "Archive"}
            </Button>
          ) : null}
          <Button variant="secondary" className={greyPill} onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="tender-form" isDisabled={!mayEdit.ok} isPending={save.isPending}>
            {tender ? "Save changes" : "Add payment method"}
          </Button>
        </>
      }
    >
      <form id="tender-form" noValidate onSubmit={form.handleSubmit((v) => save.mutate(v))} className="flex flex-col gap-8">
        <SheetSection>
          <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
            <RhfTextField control={form.control} name="name" label="Name" placeholder="Cash" autoFocus={!tender} />
            <RhfTextField control={form.control} name="sort" label="Order" numeric inputMode="numeric" placeholder={String(nextSort)} />
          </div>
        </SheetSection>
        {(tender as { provider?: string | null } | null)?.provider ? (
          // The provider is set where the payment provider is configured; its own sheet says which it is (E-L10).
          <SheetSection title="Payment provider">
            <TwoLine primary={`Sent to ${(tender as { provider?: string | null }).provider}`} meta={(tender as { terminal_id?: string | null }).terminal_id ? `Terminal ${(tender as { terminal_id?: string | null }).terminal_id}` : "The amount goes to the terminal and the bill updates when the guest has paid."} />
          </SheetSection>
        ) : null}
        <SheetSection title="Behaviour">
          <RhfSwitch control={form.control} name="is_cash" description="Cash rounding applies and change is calculated.">
            Cash
          </RhfSwitch>
          <RhfSwitch control={form.control} name="opens_drawer" description="The receipt printer kicks the cash drawer on payment.">
            Opens the drawer
          </RhfSwitch>
          <RhfSwitch control={form.control} name="is_terminal" description="The amount is shown large for keying into a card terminal.">
            Card terminal
          </RhfSwitch>
          <RhfSwitch control={form.control} name="requires_approval" description="A Cashier needs a Manager's PIN to take a payment this way. On by default for methods that are neither cash nor a card terminal, such as a house account.">
            Needs a manager's approval
          </RhfSwitch>
          <RhfSwitch control={form.control} name="requires_reference" description="The payment is refused without a reference, such as an account, a room or a voucher number.">
            Needs a reference
          </RhfSwitch>
        </SheetSection>
        {mayEdit.reason ? <p className="text-body text-ink-2">{mayEdit.reason}</p> : null}
        <InlineError error={save.error ?? archive.error} />
      </form>
    </Sheet>
  );
}
