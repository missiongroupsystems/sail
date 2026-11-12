"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ROLES, type Role } from "@sail/shared";
import { AttributionChip, Badge, Button, DataTable, EmptyState, InlineError, initialsOf, Sheet, StatusDot, Switch, type DataTableColumn } from "@sail/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { FormSection, RhfCheckboxGroup, RhfSelect, RhfSwitch, RhfTextField } from "@/components/forms/fields";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Brand, Outlet, Staff, StaffPatch } from "@/lib/api/types";
import type { Scope } from "@/lib/cookies";
import { keys } from "@/lib/query";
import { useSession } from "@/lib/session-context";
import { AccessSection } from "./AccessSection";

const ROLE_LABEL: Record<Role, string> = { server: "Server", cashier: "Cashier", manager: "Manager", finance: "Finance", admin: "Admin" };
const ROLE_HINT: Record<Role, string> = {
  server: "Takes orders and sends to the kitchen.",
  cashier: "Also takes payments and opens shifts.",
  manager: "Also approves refunds, voids and overrides.",
  finance: "Also edits past orders and runs reports.",
  admin: "Everything, including configuration and staff.",
};

type SheetState = { mode: "create" } | { mode: "edit"; staff: Staff } | null;

const PIN_RE = /^\d{6}$/;
const Schema = z
  .object({
    name: z.string().trim().min(1, "Enter a name"),
    initials: z.string().trim().max(3, "Up to 3 letters"),
    email: z.string().trim(),
    role: z.enum(ROLES),
    outlet_ids: z.array(z.string()),
    brand_ids: z.array(z.string()),
    pin_action: z.enum(["keep", "set", "remove"]),
    pin: z.string(),
    active: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.email && !z.email().safeParse(v.email).success) ctx.addIssue({ code: "custom", path: ["email"], message: "Enter an email address" });
    if (v.pin_action === "set" && !PIN_RE.test(v.pin)) ctx.addIssue({ code: "custom", path: ["pin"], message: "Use exactly 6 digits" });
  });
type Values = z.infer<typeof Schema>;

function defaults(s: Staff | null): Values {
  return {
    name: s?.name ?? "",
    initials: s?.initials ?? "",
    email: s?.email ?? "",
    role: s?.role ?? "server",
    outlet_ids: s?.outlet_ids ?? [],
    brand_ids: s?.brand_ids ?? [],
    pin_action: s ? "keep" : "set",
    pin: "",
    active: s?.active ?? true,
  };
}

export function TeamView({ initialStaff, outlets, brands, scope }: { initialStaff: Staff[]; outlets: Outlet[]; brands: Brand[]; scope: Scope }) {
  const [showInactive, setShowInactive] = useState(false);
  const [sheet, setSheet] = useState<SheetState>(null);
  const staff = useQuery({
    queryKey: keys.staff(true),
    queryFn: () => req(api.GET("/v1/staff", { params: { query: { include_inactive: "true" } } })).then((r) => r.data),
    initialData: initialStaff,
  });
  const outletName = useMemo(() => new Map(outlets.map((o) => [o.id, o.name])), [outlets]);
  const scopedOutlet = outlets.find((o) => o.id === scope.outletId) ?? null;

  const rows = staff.data.filter((s) => (showInactive || s.active) && (!scope.outletId || s.outlet_ids.length === 0 || s.outlet_ids.includes(scope.outletId)));

  const columns: DataTableColumn<Staff>[] = [
    {
      key: "name",
      header: "Name",
      sortable: true,
      isRowHeader: true,
      render: (s) => (
        <span className="inline-flex items-center gap-3">
          <AttributionChip who={{ kind: "person", initials: s.initials ?? initialsOf(s.name) }} />
          <span className="text-ink">{s.name}</span>
        </span>
      ),
    },
    { key: "role", header: "Role", sortable: true, sortValue: (s) => ROLES.indexOf(s.role), render: (s) => <Badge tone={s.role === "admin" ? "seated" : "neutral"}>{ROLE_LABEL[s.role]}</Badge> },
    {
      key: "outlets",
      header: "Outlets",
      render: (s) => (
        <span className="text-ink-2">
          {s.outlet_ids.length === 0 ? "All outlets" : s.outlet_ids.length <= 2 ? s.outlet_ids.map((id) => outletName.get(id) ?? "Unknown").join(", ") : `${s.outlet_ids.length} outlets`}
        </span>
      ),
    },
    { key: "has_pin", header: "PIN", sortable: true, render: (s) => (s.has_pin ? "Set" : <span className="text-ink-2">None</span>) },
    { key: "has_login", header: "Back-office login", sortable: true, render: (s) => (s.has_login ? "Yes" : <span className="text-ink-2">—</span>) },
    { key: "active", header: "Status", sortable: true, render: (s) => (s.active ? <StatusDot status="paid" label="Active" /> : <StatusDot status="neutral" label="Inactive" muted />) },
  ];

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-ink-2">
          {rows.length} {rows.length === 1 ? "person" : "people"}
          {scopedOutlet ? ` who can work at ${scopedOutlet.name}` : ""}
        </p>
        <div className="flex items-center gap-4">
          <Switch isSelected={showInactive} onChange={setShowInactive} className="min-h-11 py-0">
            Show inactive
          </Switch>
          <Button variant="primary" onPress={() => setSheet({ mode: "create" })}>
            Add staff member
          </Button>
        </div>
      </div>
      <DataTable
        aria-label="Staff"
        columns={columns}
        rows={rows}
        rowKey={(s) => s.id}
        defaultSort={{ column: "name", direction: "ascending" }}
        onRowAction={(s) => setSheet({ mode: "edit", staff: s })}
        rowClassName={(s) => (s.active ? undefined : "text-ink-2")}
        emptyState={<EmptyState variant="quiet" title="Nobody here yet" hint="Tap Add staff member to invite the first person." />}
      />
      <StaffSheet state={sheet} outlets={outlets} brands={brands} onClose={() => setSheet(null)} />
    </>
  );
}

function StaffSheet({ state, outlets, brands, onClose }: { state: SheetState; outlets: Outlet[]; brands: Brand[]; onClose: () => void }) {
  const qc = useQueryClient();
  const { me } = useSession();
  const staff = state?.mode === "edit" ? state.staff : null;
  const form = useForm<Values>({ resolver: zodResolver(Schema), defaultValues: defaults(staff) });
  const reset = form.reset;
  useEffect(() => {
    if (state) reset(defaults(state.mode === "edit" ? state.staff : null));
  }, [state, reset]);

  const pinAction = form.watch("pin_action");
  const name = form.watch("name");
  const email = form.watch("email");

  const save = useMutation<Staff, ApiError, Values>({
    mutationFn: async (v) => {
      const body: StaffPatch = {
        name: v.name.trim(),
        initials: v.initials.trim() ? v.initials.trim().toUpperCase() : null,
        email: v.email.trim() || null,
        role: v.role,
        outlet_ids: v.outlet_ids,
        brand_ids: v.brand_ids,
      };
      if (v.pin_action === "set") body.pin = v.pin;
      if (v.pin_action === "remove") body.pin = null;
      if (staff) {
        body.active = v.active;
        return (await req(api.PATCH("/v1/staff/{id}", { params: { path: { id: staff.id } }, body }))).data;
      }
      const { active: _active, ...create } = body;
      return (await req(api.POST("/v1/staff", { body: { ...create, name: body.name!, role: body.role! } }))).data;
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["staff"] });
      onClose();
    },
  });

  return (
    <Sheet
      isOpen={state !== null}
      onOpenChange={(open) => !open && onClose()}
      isDismissable={!save.isPending}
      title={staff ? staff.name : "New staff member"}
      description={staff ? `${ROLE_LABEL[staff.role]}${staff.has_login ? " · has a back-office login" : ""}` : "Give them a role, the outlets they work at and, for the POS, a PIN."}
      footer={
        <>
          <Button variant="quiet" onPress={onClose} isDisabled={save.isPending}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="staff-form" isPending={save.isPending}>
            {staff ? "Save changes" : "Add staff member"}
          </Button>
        </>
      }
    >
      <form id="staff-form" noValidate onSubmit={form.handleSubmit((v) => save.mutate(v))} className="flex flex-col gap-8">
        <FormSection>
          <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
            <RhfTextField control={form.control} name="name" label="Name" autoFocus={!staff} />
            <RhfTextField control={form.control} name="initials" label="Initials" placeholder={initialsOf(name, "")} maxLength={3} description="On chips and receipts." />
          </div>
          <RhfTextField control={form.control} name="email" label="Email" type="email" inputMode="email" description="Needed for a back-office login. Leave empty for POS-only staff." />
          <RhfSelect control={form.control} name="role" label="Role" items={ROLES.map((r) => ({ id: r, label: ROLE_LABEL[r], description: ROLE_HINT[r] }))} />
        </FormSection>

        <FormSection title="Where they work" hint="Nothing ticked means every outlet, or every brand.">
          <RhfCheckboxGroup control={form.control} name="outlet_ids" label="Outlets" columns={2} options={outlets.map((o) => ({ id: o.id, label: o.name }))} emptyHint="No outlets yet; this person will have access to all of them." />
          <RhfCheckboxGroup control={form.control} name="brand_ids" label="Brands" columns={2} options={brands.map((b) => ({ id: b.id, label: b.name }))} emptyHint="No brands yet." />
        </FormSection>

        <FormSection title="POS PIN" hint="Six digits. It is stored hashed and never shown again.">
          {staff ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="mr-2 text-ink-2">{staff.has_pin ? "A PIN is set." : "No PIN yet."}</span>
              <Button variant={pinAction === "set" ? "primary" : "secondary"} onPress={() => form.setValue("pin_action", pinAction === "set" ? "keep" : "set", { shouldDirty: true })}>
                {pinAction === "set" ? "Keep the current PIN" : staff.has_pin ? "Set a new PIN" : "Set a PIN"}
              </Button>
              {staff.has_pin ? (
                <Button variant={pinAction === "remove" ? "destructive" : "quiet"} onPress={() => form.setValue("pin_action", pinAction === "remove" ? "keep" : "remove", { shouldDirty: true })}>
                  {pinAction === "remove" ? "Removing PIN on save" : "Remove PIN"}
                </Button>
              ) : null}
            </div>
          ) : null}
          {pinAction === "set" ? (
            <RhfTextField control={form.control} name="pin" label={staff ? "New PIN" : "PIN (optional)"} type="password" inputMode="numeric" autoComplete="off" maxLength={6} numeric className="sm:max-w-[200px]" />
          ) : null}
        </FormSection>

        {staff ? (
          <FormSection title="Access">
            <RhfSwitch control={form.control} name="active" description="Inactive staff cannot sign in anywhere; their history stays.">
              Active
            </RhfSwitch>
          </FormSection>
        ) : null}

        {staff && me.role === "admin" ? <AccessSection staff={staff} emailUnsaved={email.trim() !== (staff.email ?? "")} /> : null}

        <InlineError error={save.error} />
      </form>
    </Sheet>
  );
}
