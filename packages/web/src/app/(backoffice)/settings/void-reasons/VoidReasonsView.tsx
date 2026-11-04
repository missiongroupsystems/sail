"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Button, DataTable, EmptyState, InlineError, Sheet, StatusDot, Switch, type DataTableColumn } from "@sail/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { FormSection, RhfSwitch, RhfTextField } from "@/components/forms/fields";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { VoidReason } from "@/lib/api/types";
import { keys } from "@/lib/query";

type SheetState = { mode: "create" } | { mode: "edit"; reason: VoidReason } | null;

const Schema = z.object({ name: z.string().trim().min(1, "Enter a reason"), for_refunds: z.boolean(), sort: z.string().regex(/^\d*$/, "A whole number") });
type Values = z.infer<typeof Schema>;
const defaults = (r: VoidReason | null): Values => ({ name: r?.name ?? "", for_refunds: r?.for_refunds ?? false, sort: r ? String(r.sort) : "" });

/** Reasons staff pick when voiding a sent line or refunding (design 8: ReasonPicker). */
export function VoidReasonsView({ initialReasons }: { initialReasons: VoidReason[] }) {
  const [showArchived, setShowArchived] = useState(false);
  const [sheet, setSheet] = useState<SheetState>(null);
  const reasons = useQuery({
    queryKey: keys.voidReasons,
    queryFn: () => req(api.GET("/v1/void-reasons", { params: { query: { include_archived: "true" } } })).then((r) => r.data),
    initialData: initialReasons,
  });
  const rows = reasons.data.filter((r) => showArchived || !r.archived);
  const columns: DataTableColumn<VoidReason>[] = [
    { key: "sort", header: "Order", numeric: true, sortable: true, width: 80, render: (r) => r.sort },
    { key: "name", header: "Reason", isRowHeader: true, sortable: true, render: (r) => <span className="text-ink">{r.name}</span> },
    { key: "for_refunds", header: "Also for refunds", render: (r) => (r.for_refunds ? "Yes" : "—") },
    { key: "archived", header: "Status", sortable: true, sortValue: (r) => (r.archived ? 1 : 0), render: (r) => (r.archived ? <StatusDot status="neutral" label="Archived" muted /> : <StatusDot status="paid" label="Active" />) },
  ];
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-ink-2">Shown when staff void a sent item; “Other” with a typed reason is always available.</p>
        <div className="flex items-center gap-4">
          <Switch isSelected={showArchived} onChange={setShowArchived} className="min-h-11 py-0">
            Show archived
          </Switch>
          <Button variant="primary" onPress={() => setSheet({ mode: "create" })}>
            Add void reason
          </Button>
        </div>
      </div>
      <DataTable
        aria-label="Void reasons"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        defaultSort={{ column: "sort", direction: "ascending" }}
        onRowAction={(r) => setSheet({ mode: "edit", reason: r })}
        rowClassName={(r) => (r.archived ? "text-ink-2" : undefined)}
        emptyState={<EmptyState variant="quiet" title="No void reasons yet" hint="Add a few: Wrong item, Guest changed mind, Kitchen error." />}
      />
      <ReasonSheet state={sheet} nextSort={reasons.data.length} onClose={() => setSheet(null)} />
    </>
  );
}

function ReasonSheet({ state, nextSort, onClose }: { state: SheetState; nextSort: number; onClose: () => void }) {
  const qc = useQueryClient();
  const reason = state?.mode === "edit" ? state.reason : null;
  const form = useForm<Values>({ resolver: zodResolver(Schema), defaultValues: defaults(reason) });
  const reset = form.reset;
  useEffect(() => {
    if (state) reset(defaults(state.mode === "edit" ? state.reason : null));
  }, [state, reset]);
  const settle = async () => {
    await qc.invalidateQueries({ queryKey: keys.voidReasons });
    onClose();
  };
  const save = useMutation<unknown, ApiError, Values>({
    mutationFn: (v) => {
      const body = { name: v.name.trim(), for_refunds: v.for_refunds, sort: v.sort === "" ? nextSort : Number(v.sort) };
      return reason ? req(api.PATCH("/v1/void-reasons/{id}", { params: { path: { id: reason.id } }, body })) : req(api.POST("/v1/void-reasons", { body }));
    },
    onSuccess: settle,
  });
  const archive = useMutation<unknown, ApiError, boolean>({
    mutationFn: (archived) => req(api.PATCH("/v1/void-reasons/{id}", { params: { path: { id: reason!.id } }, body: { archived } })),
    onSuccess: settle,
  });
  const busy = save.isPending || archive.isPending;
  return (
    <Sheet
      isOpen={state !== null}
      onOpenChange={(open) => !open && onClose()}
      isDismissable={!busy}
      title={reason ? reason.name : "New void reason"}
      footer={
        <>
          {reason ? (
            <Button variant={reason.archived ? "secondary" : "destructive"} onPress={() => archive.mutate(!reason.archived)} isPending={archive.isPending} className="mr-auto">
              {reason.archived ? "Restore" : "Archive"}
            </Button>
          ) : null}
          <Button variant="quiet" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="reason-form" isPending={save.isPending}>
            {reason ? "Save changes" : "Add void reason"}
          </Button>
        </>
      }
    >
      <form id="reason-form" noValidate onSubmit={form.handleSubmit((v) => save.mutate(v))} className="flex flex-col gap-8">
        <FormSection>
          <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
            <RhfTextField control={form.control} name="name" label="Reason" placeholder="Wrong item" autoFocus={!reason} />
            <RhfTextField control={form.control} name="sort" label="Order" numeric inputMode="numeric" placeholder={String(nextSort)} />
          </div>
          <RhfSwitch control={form.control} name="for_refunds" description="Offered in the refund flow as well as for voids.">
            Also a refund reason
          </RhfSwitch>
        </FormSection>
        <InlineError error={save.error ?? archive.error} />
      </form>
    </Sheet>
  );
}
