"use client";

import { Badge, Button, Checkbox, CheckboxGroup, DataTable, EmptyState, InlineError, Select, Sheet, TextField, type DataTableColumn } from "@sail/ui";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { CHANNELS, CHANNEL_LABEL, WEEKDAYS } from "@/components/backoffice/labels";
import { ProductSearch } from "@/components/backoffice/ProductSearch";
import { Warnings } from "@/components/backoffice/Warnings";
import { productName, useProductsById } from "@/components/backoffice/products";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { AvailabilityRule, MenuSummary, Outlet, Product } from "@/lib/api/types";
import { keys } from "@/lib/query";

type SheetState = { mode: "create" } | { mode: "edit"; rule: AvailabilityRule } | null;

type Form = {
  target_kind: "product" | "section";
  product: Product | null;
  section_id: string | null;
  outlet_ids: string[];
  channels: string[];
  days: string[];
  start_time: string;
  end_time: string;
};

const empty: Form = { target_kind: "product", product: null, section_id: null, outlet_ids: [], channels: [], days: [], start_time: "", end_time: "" };

function describeDays(days: number[]): string {
  if (days.length === 0 || days.length === 7) return "Every day";
  return WEEKDAYS.filter((d) => days.includes(d.id)).map((d) => d.label).join(", ");
}

/** Availability rules: when a product or section can be ordered, by outlet, channel, weekday and time window. */
export function AvailabilityView({ initialRules, outlets, menus }: { initialRules: AvailabilityRule[]; outlets: Outlet[]; menus: MenuSummary[] }) {
  const [sheet, setSheet] = useState<SheetState>(null);

  const rules = useQuery({
    queryKey: keys.availability,
    queryFn: () => req(api.GET("/v1/availability-rules")).then((r) => r.data),
    initialData: initialRules,
  });

  const menuDetails = useQueries({
    queries: menus.map((m) => ({ queryKey: keys.menu(m.id), queryFn: () => req(api.GET("/v1/menus/{id}", { params: { path: { id: m.id } } })).then((r) => r.data), staleTime: 60_000 })),
  });
  const sections = useMemo(() => {
    const out: { id: string; label: string }[] = [];
    menuDetails.forEach((q, i) => {
      const menu = q.data;
      if (!menu) return;
      const byId = new Map(menu.sections.map((s) => [s.id, s]));
      for (const s of menu.sections) {
        const parent = s.parent_id ? byId.get(s.parent_id) : null;
        out.push({ id: s.id, label: `${menus[i]!.name} › ${parent ? `${parent.name} › ` : ""}${s.name}` });
      }
    });
    return out;
  }, [menuDetails, menus]);
  const sectionLabel = useMemo(() => new Map(sections.map((s) => [s.id, s.label])), [sections]);
  const outletName = useMemo(() => new Map(outlets.map((o) => [o.id, o.name])), [outlets]);
  const { byId } = useProductsById(rules.data.filter((r) => r.target_kind === "product").map((r) => r.target_id));

  const columns: DataTableColumn<AvailabilityRule>[] = [
    {
      key: "target",
      header: "Applies to",
      isRowHeader: true,
      render: (r) => (
        <span>
          <Badge className="mr-2">{r.target_kind === "product" ? "Product" : "Section"}</Badge>
          <span className="text-ink">{r.target_kind === "product" ? productName(byId, r.target_id) : sectionLabel.get(r.target_id) ?? `Section ${r.target_id.slice(0, 8)}`}</span>
        </span>
      ),
    },
    { key: "outlets", header: "Outlets", render: (r) => <span className="text-ink-2">{r.outlet_ids.length ? r.outlet_ids.map((id) => outletName.get(id) ?? "Unknown").join(", ") : "All outlets"}</span> },
    { key: "channels", header: "Channels", render: (r) => <span className="text-ink-2">{r.channels.length ? r.channels.map((c) => CHANNEL_LABEL[c] ?? c).join(", ") : "All channels"}</span> },
    { key: "days", header: "Days", render: (r) => <span className="text-ink-2">{describeDays(r.days_of_week)}</span> },
    { key: "time", header: "Time", render: (r) => <span className="tabular text-ink-2">{r.start_time || r.end_time ? `${r.start_time ?? "open"} – ${r.end_time ?? "close"}` : "All day"}</span> },
  ];

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-ink-2">A rule limits when something can be ordered. Without a rule, an item is always available where its menu is live.</p>
        <Button variant="primary" onPress={() => setSheet({ mode: "create" })}>
          Add availability rule
        </Button>
      </div>
      <DataTable
        aria-label="Availability rules"
        columns={columns}
        rows={rules.data}
        rowKey={(r) => r.id}
        onRowAction={(r) => setSheet({ mode: "edit", rule: r })}
        emptyState={<EmptyState variant="quiet" title="No availability rules" hint="Everything on a live menu is available at all times. Tap Add availability rule for breakfast-only items and the like." />}
      />
      <InlineError error={rules.error} className="mt-4" />
      <RuleSheet state={sheet} outlets={outlets} sections={sections} byId={byId} onClose={() => setSheet(null)} />
    </>
  );
}

function RuleSheet({ state, outlets, sections, byId, onClose }: { state: SheetState; outlets: Outlet[]; sections: { id: string; label: string }[]; byId: Map<string, Product>; onClose: () => void }) {
  const qc = useQueryClient();
  const rule = state?.mode === "edit" ? state.rule : null;
  const [form, setForm] = useState<Form>(empty);
  const [warnings, setWarnings] = useState<string[]>([]);
  useEffect(() => {
    if (!state) return;
    setWarnings([]);
    if (state.mode === "edit") {
      const r = state.rule;
      setForm({
        target_kind: r.target_kind,
        product: null,
        section_id: r.target_kind === "section" ? r.target_id : null,
        outlet_ids: r.outlet_ids,
        channels: r.channels,
        days: r.days_of_week.map(String),
        start_time: r.start_time ?? "",
        end_time: r.end_time ?? "",
      });
    } else setForm(empty);
  }, [state]);
  // Product names can arrive after the sheet opens; fill the target in without touching the person's edits.
  useEffect(() => {
    if (state?.mode === "edit" && state.rule.target_kind === "product") {
      const p = byId.get(state.rule.target_id);
      if (p) setForm((f) => (f.product ? f : { ...f, product: p }));
    }
  }, [state, byId]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const body = {
    outlet_ids: form.outlet_ids,
    channels: form.channels as ("pos" | "scan_to_order")[],
    days_of_week: form.days.map(Number),
    start_time: form.start_time || null,
    end_time: form.end_time || null,
  };
  const targetId = form.target_kind === "product" ? form.product?.id ?? null : form.section_id;

  const save = useMutation<{ warnings: string[] }, ApiError>({
    mutationFn: () =>
      rule
        ? req(api.PATCH("/v1/availability-rules/{id}", { params: { path: { id: rule.id } }, body }))
        : req(api.POST("/v1/availability-rules", { body: { target_kind: form.target_kind, target_id: targetId!, ...body } })),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: keys.availability });
      if (r.warnings.length) setWarnings(r.warnings);
      else onClose();
    },
  });

  return (
    <Sheet
      isOpen={state !== null}
      onOpenChange={(open) => !open && onClose()}
      isDismissable={!save.isPending}
      title={rule ? "Availability rule" : "New availability rule"}
      description={rule ? "The target of a rule cannot change; add a new rule for another item." : "Choose what the rule applies to, then narrow where and when it can be ordered."}
      footer={
        <>
          <Button variant="quiet" onPress={onClose} isDisabled={save.isPending}>
            Cancel
          </Button>
          <Button variant="primary" isDisabled={!targetId} isPending={save.isPending} onPress={() => save.mutate()}>
            {rule ? "Save rule" : "Add rule"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        {!rule ? (
          <>
            <Select
              label="Applies to"
              selectedKey={form.target_kind}
              onSelectionChange={(k) => k && set("target_kind", k as Form["target_kind"])}
              items={[
                { id: "product", label: "A product" },
                { id: "section", label: "A menu section" },
              ]}
            />
            {form.target_kind === "product" ? (
              form.product ? (
                <div className="flex items-center justify-between gap-3 rounded-tile bg-surface-2 px-3 py-2">
                  <span className="text-ink">{form.product.name}</span>
                  <Button variant="quiet" onPress={() => set("product", null)}>
                    Change
                  </Button>
                </div>
              ) : (
                <ProductSearch label="Product" autoFocus onPick={(p) => set("product", p)} />
              )
            ) : (
              <Select label="Section" selectedKey={form.section_id} onSelectionChange={(k) => set("section_id", k)} items={sections.map((s) => ({ id: s.id, label: s.label }))} placeholder={sections.length ? "Choose a section" : "No menu sections yet"} />
            )}
          </>
        ) : (
          <p className="text-ink">{rule.target_kind === "product" ? productName(byId, rule.target_id) : sections.find((s) => s.id === rule.target_id)?.label ?? "Section"}</p>
        )}

        <CheckboxGroup label="Outlets" description="Leave every outlet unticked to apply the rule everywhere." value={form.outlet_ids} onChange={(v) => set("outlet_ids", v)} columns={2}>
          {outlets.map((o) => (
            <Checkbox key={o.id} value={o.id}>
              {o.name}
            </Checkbox>
          ))}
        </CheckboxGroup>
        <CheckboxGroup label="Channels" description="Unticked means both." value={form.channels} onChange={(v) => set("channels", v)} columns={2}>
          {CHANNELS.map((c) => (
            <Checkbox key={c} value={c}>
              {CHANNEL_LABEL[c]}
            </Checkbox>
          ))}
        </CheckboxGroup>
        <CheckboxGroup label="Days" description="Unticked means every day." value={form.days} onChange={(v) => set("days", v)} columns={2}>
          {WEEKDAYS.map((d) => (
            <Checkbox key={d.id} value={String(d.id)}>
              {d.label}
            </Checkbox>
          ))}
        </CheckboxGroup>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="From" type="time" numeric value={form.start_time} onChange={(v) => set("start_time", v)} description="Empty means from opening." />
          <TextField label="Until" type="time" numeric value={form.end_time} onChange={(v) => set("end_time", v)} description="Empty means until closing." />
        </div>
        <Warnings warnings={warnings} />
        <InlineError error={save.error} />
      </div>
    </Sheet>
  );
}
