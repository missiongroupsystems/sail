"use client";

import { Users } from "lucide-react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Badge, Button, DataTable, EmptyState, InlineError, Panel, Pill, Sheet, StatusDot, TextField, type DataTableColumn } from "@sail/ui";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { FormSection, RhfCheckboxGroup, RhfSwitch, RhfTextField } from "@/components/forms/fields";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Customer, CustomerGroup, CustomerUpsert } from "@/lib/api/types";
import { keys } from "@/lib/query";

type CustomerSheet = { mode: "create" } | { mode: "edit"; customer: Customer } | null;
type GroupSheet = { mode: "create" } | { mode: "edit"; group: CustomerGroup } | null;

const CustomerSchema = z
  .object({
    name: z.string().trim().min(1, "Enter a name"),
    mobile: z.string().trim(),
    email: z.string().trim(),
    marketing_consent: z.boolean(),
    notes: z.string(),
    group_ids: z.array(z.string()),
  })
  .superRefine((v, ctx) => {
    if (v.email && !z.email().safeParse(v.email).success) ctx.addIssue({ code: "custom", path: ["email"], message: "Enter an email address" });
    if (v.mobile && !/^\+?[\d\s-]{6,}$/.test(v.mobile)) ctx.addIssue({ code: "custom", path: ["mobile"], message: "Enter a mobile number with its country code" });
  });
type CustomerValues = z.infer<typeof CustomerSchema>;

const GroupSchema = z.object({ name: z.string().trim().min(1, "Enter a name"), description: z.string() });
type GroupValues = z.infer<typeof GroupSchema>;

function useDebounced(value: string, ms = 250): string {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Customers (found by mobile or name) and the groups that pricing conditions refer to. */
export function CustomersView({ initialGroups, initialCustomers }: { initialGroups: CustomerGroup[]; initialCustomers: Customer[] }) {
  const [q, setQ] = useState("");
  const [groupId, setGroupId] = useState<string | null>(null);
  const [customerSheet, setCustomerSheet] = useState<CustomerSheet>(null);
  const [groupSheet, setGroupSheet] = useState<GroupSheet>(null);
  const dq = useDebounced(q.trim());
  const looksLikeMobile = /^\+?[\d\s-]{4,}$/.test(dq);
  const filters = { mobile: looksLikeMobile ? dq.replace(/[\s-]/g, "") : undefined, q: !looksLikeMobile && dq ? dq : undefined, group_id: groupId ?? undefined };

  const groups = useQuery({
    queryKey: keys.customerGroups,
    queryFn: () => req(api.GET("/v1/customer-groups", { params: { query: { include_archived: "true" } } })).then((r) => r.data),
    initialData: initialGroups,
  });
  const customers = useQuery({
    queryKey: keys.customers(filters),
    queryFn: () => req(api.GET("/v1/customers", { params: { query: { ...filters, limit: 50 } } })).then((r) => r.data),
    placeholderData: keepPreviousData,
    initialData: !dq && !groupId ? initialCustomers : undefined,
  });
  const groupName = useMemo(() => new Map(groups.data.map((g) => [g.id, g.name])), [groups.data]);

  const columns: DataTableColumn<Customer>[] = [
    { key: "name", header: "Name", isRowHeader: true, sortable: true, render: (c) => <span className="text-ink">{c.name}</span> },
    { key: "mobile", header: "Mobile", render: (c) => <span className="tabular">{c.mobile ?? "—"}</span> },
    { key: "email", header: "Email", render: (c) => <span className="text-ink-2">{c.email ?? "—"}</span> },
    { key: "marketing_consent", header: "Marketing", render: (c) => (c.marketing_consent ? <StatusDot status="paid" label="Consented" /> : <StatusDot status="neutral" label="No consent" muted />) },
    {
      key: "groups",
      header: "Groups",
      render: (c) => (
        <span className="flex flex-wrap gap-1">
          {c.group_ids.map((id) => (
            <Badge key={id}>{groupName.get(id) ?? "?"}</Badge>
          ))}
        </span>
      ),
    },
    { key: "archived", header: "Status", render: (c) => (c.archived ? <Pill size="sm" tone="neutral">Archived</Pill> : <Pill size="sm" tone="paid">Active</Pill>) },
  ];

  return (
    <div className="grid items-start gap-x-10 gap-y-8 xl:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
      <section className="min-w-0">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <TextField size="sm" aria-label="Find a customer" type="search" value={q} onChange={setQ} placeholder="Mobile number or name" className="w-[280px]" />
          <Button size="sm" variant="primary" onPress={() => setCustomerSheet({ mode: "create" })}>
            Add customer
          </Button>
        </div>
        <DataTable
          aria-label="Customers"
          columns={columns}
          rows={customers.data ?? []}
          rowKey={(c) => c.id}
          isLoading={customers.isPending}
          className={customers.isPlaceholderData ? "opacity-60" : undefined}
          defaultSort={{ column: "name", direction: "ascending" }}
          onRowAction={(c) => setCustomerSheet({ mode: "edit", customer: c })}
          emptyState={<EmptyState variant="centred" icon={Users} title={dq ? "No customers match" : "No customers yet"} hint={dq ? "Try the mobile number without spaces, or part of the name." : "Customers are created from pickup and delivery orders, by import, or here."} />}
        />
        <InlineError error={customers.error} className="mt-4" />
        <p className="mt-3 text-caption text-ink-2 tabular">
          {(customers.data ?? []).length} shown{groupId ? ` in ${groupName.get(groupId)}` : ""} · up to 50 per search
        </p>
      </section>

      <Panel
        title="Groups"
        body="flush"
        aside={
          <Button size="sm" onPress={() => setGroupSheet({ mode: "create" })}>
            Add group
          </Button>
        }
      >
        {groups.data.length === 0 ? (
          <EmptyState variant="quiet" className="px-5 py-4" title="No groups yet" hint="Groups like VIP or Staff let pricing rules apply to a customer." />
        ) : (
          <ul className="flex flex-col gap-0.5 p-2">
            <li>
              <Button variant="quiet" className={`min-h-10 w-full justify-start rounded-[10px] px-3 font-normal ${groupId === null ? "bg-surface-3 text-ink" : "text-ink-2"}`} onPress={() => setGroupId(null)}>
                All customers
              </Button>
            </li>
            {groups.data.map((g) => (
              <li key={g.id} className="flex items-center gap-1">
                <Button variant="quiet" className={`min-h-10 min-w-0 flex-1 justify-start rounded-[10px] px-3 text-left font-normal ${groupId === g.id ? "bg-surface-3 text-ink" : "text-ink-2"}`} onPress={() => setGroupId(g.id)}>
                  <span className="truncate">{g.name}</span>
                  {g.archived ? <span className="ml-2 text-caption">archived</span> : null}
                </Button>
                <Button variant="quiet" className="min-h-8 px-2.5 text-caption text-ink-2" onPress={() => setGroupSheet({ mode: "edit", group: g })}>
                  Edit
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <CustomerFormSheet state={customerSheet} groups={groups.data} onClose={() => setCustomerSheet(null)} />
      <GroupFormSheet state={groupSheet} onClose={() => setGroupSheet(null)} />
    </div>
  );
}

function CustomerFormSheet({ state, groups, onClose }: { state: CustomerSheet; groups: CustomerGroup[]; onClose: () => void }) {
  const qc = useQueryClient();
  const customer = state?.mode === "edit" ? state.customer : null;
  const defaults = (c: Customer | null): CustomerValues => ({ name: c?.name ?? "", mobile: c?.mobile ?? "", email: c?.email ?? "", marketing_consent: c?.marketing_consent ?? false, notes: c?.notes ?? "", group_ids: c?.group_ids ?? [] });
  const form = useForm<CustomerValues>({ resolver: zodResolver(CustomerSchema), defaultValues: defaults(customer) });
  const reset = form.reset;
  useEffect(() => {
    if (state) reset(defaults(state.mode === "edit" ? state.customer : null));
  }, [state, reset]);

  const settle = async () => {
    await qc.invalidateQueries({ queryKey: ["customers"] });
    onClose();
  };
  const save = useMutation<unknown, ApiError, CustomerValues>({
    mutationFn: (v) => {
      const body: CustomerUpsert = {
        ...(customer ? { id: customer.id } : {}),
        name: v.name.trim(),
        mobile: v.mobile.replace(/[\s-]/g, "") || null,
        email: v.email.trim() || null,
        marketing_consent: v.marketing_consent,
        notes: v.notes.trim() || null,
        group_ids: v.group_ids,
      };
      return req(api.PUT("/v1/customers", { body }));
    },
    onSuccess: settle,
  });
  // PUT replaces the whole record, so archiving sends every field back unchanged.
  const archive = useMutation<unknown, ApiError, boolean>({
    mutationFn: (archived) => {
      const c = customer!;
      return req(api.PUT("/v1/customers", { body: { id: c.id, name: c.name, mobile: c.mobile, email: c.email, marketing_consent: c.marketing_consent, notes: c.notes, group_ids: c.group_ids, archived } }));
    },
    onSuccess: settle,
  });
  const busy = save.isPending || archive.isPending;

  return (
    <Sheet
      isOpen={state !== null}
      onOpenChange={(open) => !open && onClose()}
      isDismissable={!busy}
      title={customer ? customer.name : "New customer"}
      description={customer ? (customer.archived ? "Archived" : "Edit the customer's details, consent and groups.") : "A customer is matched by mobile number on pickup and delivery orders."}
      footer={
        <>
          {customer ? (
            <Button variant={customer.archived ? "secondary" : "destructive"} onPress={() => archive.mutate(!customer.archived)} isPending={archive.isPending} isDisabled={save.isPending} className="mr-auto">
              {customer.archived ? "Restore customer" : "Archive customer"}
            </Button>
          ) : null}
          <Button variant="quiet" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="customer-form" isPending={save.isPending} isDisabled={archive.isPending}>
            {customer ? "Save changes" : "Add customer"}
          </Button>
        </>
      }
    >
      <form id="customer-form" noValidate onSubmit={form.handleSubmit((v) => save.mutate(v))} className="flex flex-col gap-8">
        <FormSection>
          <RhfTextField control={form.control} name="name" label="Name" autoFocus={!customer} />
          <div className="grid gap-4 sm:grid-cols-2">
            <RhfTextField control={form.control} name="mobile" label="Mobile" type="tel" inputMode="tel" numeric placeholder="+ country code and number" />
            <RhfTextField control={form.control} name="email" label="Email" type="email" inputMode="email" />
          </div>
          <RhfTextField control={form.control} name="notes" label="Notes" multiline rows={2} description="Seen by staff on the order, never by the customer." />
        </FormSection>
        <FormSection variant="label" title="Consent">
          <RhfSwitch control={form.control} name="marketing_consent" description="The customer agreed to receive marketing messages. Recorded with the time of the change.">
            Marketing consent
          </RhfSwitch>
        </FormSection>
        <FormSection variant="label" title="Groups" hint="Pricing rules can apply to customers in a group.">
          <RhfCheckboxGroup control={form.control} name="group_ids" aria-label="Groups" options={groups.filter((g) => !g.archived).map((g) => ({ id: g.id, label: g.name, description: g.description ?? undefined }))} columns={2} emptyHint="No groups yet. Add one on the right." />
        </FormSection>
        <InlineError error={save.error ?? archive.error} />
      </form>
    </Sheet>
  );
}

function GroupFormSheet({ state, onClose }: { state: GroupSheet; onClose: () => void }) {
  const qc = useQueryClient();
  const group = state?.mode === "edit" ? state.group : null;
  const form = useForm<GroupValues>({ resolver: zodResolver(GroupSchema), defaultValues: { name: group?.name ?? "", description: group?.description ?? "" } });
  const reset = form.reset;
  useEffect(() => {
    if (state) reset({ name: state.mode === "edit" ? state.group.name : "", description: state.mode === "edit" ? state.group.description ?? "" : "" });
  }, [state, reset]);
  const settle = async () => {
    await qc.invalidateQueries({ queryKey: keys.customerGroups });
    onClose();
  };
  const save = useMutation<unknown, ApiError, GroupValues>({
    mutationFn: (v) => {
      const body = { name: v.name.trim(), description: v.description.trim() || null };
      return group ? req(api.PATCH("/v1/customer-groups/{id}", { params: { path: { id: group.id } }, body })) : req(api.POST("/v1/customer-groups", { body }));
    },
    onSuccess: settle,
  });
  const archive = useMutation<unknown, ApiError, boolean>({
    mutationFn: (archived) => req(api.PATCH("/v1/customer-groups/{id}", { params: { path: { id: group!.id } }, body: { archived } })),
    onSuccess: settle,
  });
  const busy = save.isPending || archive.isPending;
  return (
    <Sheet
      isOpen={state !== null}
      onOpenChange={(open) => !open && onClose()}
      isDismissable={!busy}
      title={group ? group.name : "New customer group"}
      footer={
        <>
          {group ? (
            <Button variant={group.archived ? "secondary" : "destructive"} onPress={() => archive.mutate(!group.archived)} isPending={archive.isPending} className="mr-auto">
              {group.archived ? "Restore group" : "Archive group"}
            </Button>
          ) : null}
          <Button variant="quiet" onPress={onClose} isDisabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="group-form" isPending={save.isPending}>
            {group ? "Save changes" : "Add group"}
          </Button>
        </>
      }
    >
      <form id="group-form" noValidate onSubmit={form.handleSubmit((v) => save.mutate(v))} className="flex flex-col gap-6">
        <FormSection>
          <RhfTextField control={form.control} name="name" label="Name" placeholder="VIP" autoFocus />
          <RhfTextField control={form.control} name="description" label="Description" multiline rows={2} />
        </FormSection>
        <InlineError error={save.error ?? archive.error} />
      </form>
    </Sheet>
  );
}
