"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Badge, Button, Icon, InlineError, MoneyField, PercentField, Sheet, TagsField, TextField, useLocale, FieldsLocked, useFieldsLocked } from "@sail/ui";
import { zonedInputToIso } from "@sail/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { CHANNELS, CHANNEL_LABEL, ORDER_TYPES, ORDER_TYPE_LABEL, REPORT_CLASSES, REPORT_CLASS_LABEL, ROLES, ROLE_LABEL, slugKey } from "@/components/backoffice/labels";
import { ProductSearch } from "@/components/backoffice/ProductSearch";
import { Warnings } from "@/components/backoffice/Warnings";
import { productName, useProductsById } from "@/components/backoffice/products";
import { taxClassItems, useTaxClasses } from "@/components/backoffice/tax-classes";
import { FormSection, RhfCheckboxGroup, RhfSelect, RhfSwitch, RhfTextField } from "@/components/forms/fields";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Brand, Category, CustomerGroup, Outlet, PricingRuleVersion } from "@/lib/api/types";
import { keys } from "@/lib/query";
import type { RuleRow } from "./RulesView";
import { emptyForm, formFrom, NONE, RuleFormSchema, toBody, type RuleForm } from "./rule-form";
import { useFreshErrors } from "@/lib/fresh-errors";
import { useCan } from "@/lib/can";
import { useRecheckErrors } from "@/lib/recheck-errors";

export type RuleSheetState = { mode: "create"; kind: "fee" | "discount" } | { mode: "edit"; row: RuleRow } | null;

const STATUS_LABEL: Record<PricingRuleVersion["status"], string> = { active: "Active", scheduled: "Scheduled", superseded: "Superseded", archived: "Archived" };

/**
 * The rule editor: every field of PricingRuleSchema with plain-language labels.
 * Saving always creates a new version (effective now or at a chosen time); the
 * register returns validation warnings for the resulting active set.
 */
export function RuleSheet({ state, onClose, outlets, brands, categories, groups, allRules }: { state: RuleSheetState; onClose: () => void; outlets: Outlet[]; brands: Brand[]; categories: Category[]; groups: CustomerGroup[]; allRules: RuleRow[] }) {
  const { dayClock, timeZone } = useLocale();
  const qc = useQueryClient();
  const row = state?.mode === "edit" ? state.row : null;
  const form = useForm<RuleForm>({ resolver: zodResolver(RuleFormSchema), defaultValues: state?.mode === "edit" ? formFrom(state.row.current, timeZone) : emptyForm(state?.mode === "create" ? state.kind : "fee") });
  useRecheckErrors(form);
  const [saved, setSaved] = useState<{ version: PricingRuleVersion; warnings: string[] } | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [reason, setReason] = useState("");
  const [showVersions, setShowVersions] = useState(false);
  const reset = form.reset;
  useEffect(() => {
    if (!state) return;
    reset(state.mode === "edit" ? formFrom(state.row.current, timeZone) : emptyForm(state.kind));
    setSaved(null);
    setArchiving(false);
    setReason("");
    setShowVersions(false);
  }, [state, reset, timeZone]);

  const kind = useWatch({ control: form.control, name: "kind" });
  const calc = useWatch({ control: form.control, name: "calc" });
  const valueType = useWatch({ control: form.control, name: "value_type" });
  const scopeType = useWatch({ control: form.control, name: "scope_type" });
  const formTaxClassId = useWatch({ control: form.control, name: "tax_class_id" });
  const taxClasses = useTaxClasses(state !== null);
  const application = useWatch({ control: form.control, name: "application" });
  const effective = useWatch({ control: form.control, name: "effective" });
  const name = useWatch({ control: form.control, name: "name" });
  const scopeProducts = useWatch({ control: form.control, name: "scope_product_ids" });
  const exclProducts = useWatch({ control: form.control, name: "excl_product_ids" });
  const { byId } = useProductsById([...(scopeProducts ?? []), ...(exclProducts ?? [])]);

  // A new rule's key follows its name until the person edits the key.
  const keyTouched = form.formState.dirtyFields.rule_key;
  useEffect(() => {
    if (!row && !keyTouched) form.setValue("rule_key", slugKey(name ?? ""));
  }, [name, row, keyTouched, form]);

  // Level follows the calculation for discounts.
  useEffect(() => {
    if (calc === "fixed_per_order") form.setValue("level", "order");
    if (calc === "fixed_per_unit") form.setValue("level", "line");
  }, [calc, form]);

  const settle = async () => {
    await qc.invalidateQueries({ queryKey: keys.pricingRules });
    await qc.invalidateQueries({ queryKey: keys.pricingValidation });
  };
  const save = useMutation<{ data: PricingRuleVersion; warnings: string[] }, ApiError, RuleForm>({
    mutationFn: (v) => req(api.POST("/v1/pricing-rules", { body: { rule_key: v.rule_key.trim(), body: toBody(v, timeZone) as unknown as Record<string, unknown>, effective_from: v.effective === "at" ? zonedInputToIso(v.effective_at, timeZone) : undefined, note: v.note.trim() || null } })),
    onSuccess: async (r) => {
      await settle();
      if (r.warnings.length) setSaved({ version: r.data, warnings: r.warnings });
      else onClose();
    },
  });
  const archive = useMutation<unknown, ApiError, void>({
    mutationFn: () => req(api.POST("/v1/pricing-rules/{rule_key}/archive", { params: { path: { rule_key: row!.rule_key } }, body: { reason: reason.trim() || undefined } })),
    onSuccess: async () => {
      await settle();
      onClose();
    },
  });
  const busy = save.isPending || archive.isPending;

  const categoryOptions = useMemo(() => {
    const byId = new Map(categories.map((c) => [c.id, c]));
    return categories.filter((c) => !c.archived).map((c) => ({ id: c.id, label: c.parent_id ? `${byId.get(c.parent_id)?.name ?? ""} › ${c.name}` : c.name }));
  }, [categories]);
  const otherRules = allRules.filter((r) => r.rule_key !== row?.rule_key && r.current.status !== "archived");
  const isPercent = calc === "percent";

  const amountField = (fieldName: "amount" | "min" | "max", labelText: string) => (
    <Controller
      control={form.control}
      name={fieldName}
      render={({ field, fieldState }) =>
        isPercent ? (
          <PercentField label={labelText} value={field.value} onChange={field.onChange} onBlur={field.onBlur} isInvalid={!!fieldState.error} errorMessage={fieldState.error?.message} />
        ) : (
          <MoneyField label={labelText} value={field.value} onChange={field.onChange} onBlur={field.onBlur} isInvalid={!!fieldState.error} errorMessage={fieldState.error?.message} />
        )
      }
    />
  );

  const mayEdit = useCan("pricing_rules.create_version");
  useFreshErrors(state, form.watch(), save, archive);
  return (
    <FieldsLocked locked={!mayEdit.ok}>
    <Sheet
      isOpen={state !== null}
      onOpenChange={(open) => !open && onClose()}
      isDismissable={!busy}
      width="lg"
      title={row ? row.body.name : state?.mode === "create" && state.kind === "fee" ? "New fee" : "New discount"}
      description={
        row ? (
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="text-caption">{row.rule_key}</span>
            <Badge tone={row.current.status === "active" ? "paid" : row.current.status === "scheduled" ? "sent" : row.current.status === "archived" ? "alert" : "neutral"}>
              {STATUS_LABEL[row.current.status]} · v{row.current.version}
            </Badge>
            {row.body.seeded ? <Badge>Seeded</Badge> : null}
            <Button variant="quiet" className="min-h-8 max-sm:min-h-11 px-2 text-caption" onPress={() => setShowVersions((v) => !v)}>
              {showVersions ? "Hide" : "Show"} {row.versions.length} {row.versions.length === 1 ? "version" : "versions"}
            </Button>
          </span>
        ) : (
          "Every change saves as a new version. Orders already priced keep their snapshot."
        )
      }
      footer={
        saved ? (
          <Button variant="primary" onPress={onClose}>
            Done
          </Button>
        ) : archiving ? (
          <>
            <TextField aria-label="Reason for archiving" placeholder="Reason (shown in the audit log)" value={reason} onChange={setReason} className="mr-auto min-w-[260px] flex-1" />
            <Button variant="quiet" onPress={() => setArchiving(false)} isDisabled={busy}>
              Keep rule
            </Button>
            <Button variant="destructive" onPress={() => archive.mutate()} isPending={archive.isPending}>
              Archive {row?.body.name}
            </Button>
          </>
        ) : (
          <>
            {row && row.current.status !== "archived" && mayEdit.ok ? (
              <Button variant="destructive" onPress={() => setArchiving(true)} isDisabled={busy} className="mr-auto">
                Archive rule…
              </Button>
            ) : null}
            <Button variant="quiet" onPress={onClose} isDisabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form="rule-form" isPending={save.isPending} isDisabled={!mayEdit.ok || archive.isPending}>
              {effective === "at" ? "Save as new version, scheduled" : row ? "Save as new version, effective now" : "Add rule, effective now"}
            </Button>
          </>
        )
      }
    >
      {saved ? (
        <div className="flex flex-col gap-4">
          <p className="text-ink">
            Saved as version {saved.version.version}, {saved.version.status === "scheduled" ? `scheduled for ${dayClock(saved.version.effective_from)}` : "effective now"}.
          </p>
          <p className="text-ink-2">The register checked the resulting rule set:</p>
          <Warnings warnings={saved.warnings} tone={saved.warnings.some((w) => w.startsWith("blocking")) ? "blocking" : "advisory"} />
        </div>
      ) : (
        <form id="rule-form" noValidate onSubmit={form.handleSubmit((v) => save.mutate(v))} className="flex flex-col gap-8">
          {row && showVersions ? (
            <FormSection variant="label" title="Versions">
              <ul className="flex flex-col">
                {row.versions.map((v) => (
                  <li key={v.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2 hairline-b last:border-b-0">
                    <span className="tabular text-ink">v{v.version}</span>
                    <Badge tone={v.status === "active" ? "paid" : v.status === "scheduled" ? "sent" : v.status === "archived" ? "alert" : "neutral"}>{STATUS_LABEL[v.status]}</Badge>
                    <span className="tabular text-caption text-ink-2">from {dayClock(v.effective_from)}</span>
                    {v.note ? <span className="text-caption text-ink-2">· {v.note}</span> : null}
                    {v.created_by ? <span className="text-caption text-ink-2">· by {v.created_by}</span> : null}
                  </li>
                ))}
              </ul>
            </FormSection>
          ) : null}

          <FormSection>
            <div className="grid gap-4 sm:grid-cols-[1fr_220px]">
              <RhfTextField control={form.control} name="name" label="Name" placeholder={kind === "fee" ? "Service charge" : "Staff meal"} description="Shown on bills and receipts." autoFocus={!row} />
              <RhfTextField control={form.control} name="rule_key" label="Key" mono isDisabled={!!row} description={row ? "Fixed once created." : "Stable id across versions."} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <RhfSelect
                control={form.control}
                name="kind"
                label="Kind"
                isDisabled={!!row}
                items={[
                  { id: "fee", label: "Fee", description: "Adds to the bill: service charge, deposit, delivery." },
                  { id: "discount", label: "Discount", description: "Takes off the bill: promotions, comps, staff meals." },
                ]}
              />
              <RhfSelect
                control={form.control}
                name="report_class"
                label="Reports as"
                description="How it appears in sales reports."
                items={REPORT_CLASSES.map((c) => ({ id: c, label: REPORT_CLASS_LABEL[c]! }))}
              />
            </div>
          </FormSection>

          <FormSection variant="label" title="Amount">
            <div className="grid gap-4 sm:grid-cols-2">
              <RhfSelect
                control={form.control}
                name="calc"
                label="Calculated as"
                items={[
                  { id: "percent", label: "A percentage", description: kind === "fee" ? "Of each line after discounts." : "Of the eligible amount." },
                  { id: "fixed_per_order", label: "A fixed amount per order" },
                  { id: "fixed_per_unit", label: "A fixed amount per unit", description: "Multiplied by quantity." },
                ]}
              />
              <RhfSelect
                control={form.control}
                name="value_type"
                label="Value"
                items={[
                  { id: "fixed", label: "Fixed", description: "The same every time." },
                  { id: "open", label: "Keyed in within a range", description: "Staff enter the value when applying it." },
                ]}
              />
            </div>
            {valueType === "fixed" ? (
              <div className="grid gap-4 sm:grid-cols-2">{amountField("amount", isPercent ? "Percentage" : "Amount")}</div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                {amountField("min", isPercent ? "Minimum percentage" : "Minimum amount")}
                {amountField("max", isPercent ? "Maximum percentage" : "Maximum amount")}
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              {kind === "discount" ? (
                <RhfSelect
                  control={form.control}
                  name="level"
                  label="Applied at"
                  isDisabled={calc !== "percent"}
                  description={calc === "percent" ? "Line: each eligible line. Order: the eligible subtotal, spread across lines." : "Set by the calculation."}
                  items={[
                    { id: "line", label: "Each line" },
                    { id: "order", label: "The whole order" },
                  ]}
                />
              ) : null}
              <Controller
                control={form.control}
                name="cap"
                render={({ field, fieldState }) => <MoneyField label="Cap per order" value={field.value} onChange={field.onChange} onBlur={field.onBlur} placeholder="No cap" description="The most this rule can add or take off one order." isInvalid={!!fieldState.error} errorMessage={fieldState.error?.message} />}
              />
            </div>
            {kind === "fee" ? (
              <RhfSelect
                control={form.control}
                name="tax_class_id"
                label="Tax class"
                placeholder="Choose a tax class"
                description="The tax charged on this fee. Discounts take the tax class of the lines they reduce."
                items={[{ id: NONE, label: "Not taxed", description: "For a deposit, for example." }, ...taxClassItems(taxClasses.data ?? [], formTaxClassId === NONE ? null : formTaxClassId)]}
                className="sm:max-w-[360px]"
              />
            ) : null}
          </FormSection>

          <FormSection variant="label" title="Applies to" hint="Which lines the rule looks at. Exclusions win over the scope.">
            <RhfSelect
              control={form.control}
              name="scope_type"
              label="Scope"
              items={[
                { id: "all", label: "Everything" },
                { id: "categories", label: "Categories", description: "Includes their sub-categories." },
                { id: "products", label: "Specific products" },
                { id: "tags", label: "Products with a tag" },
                { id: "deposit", label: "Deposit items" },
              ]}
              className="sm:max-w-[360px]"
            />
            {scopeType === "categories" ? <RhfCheckboxGroup control={form.control} name="scope_category_ids" aria-label="Categories in scope" options={categoryOptions} columns={2} emptyHint="No categories yet. Add them under Menu › Categories." /> : null}
            {scopeType === "products" ? <ProductList control={form} name="scope_product_ids" byId={byId} label="Products in scope" /> : null}
            {scopeType === "tags" ? <Controller control={form.control} name="scope_tags" render={({ field, fieldState }) => <TagsField label="Tags" value={field.value} onChange={field.onChange} isInvalid={!!fieldState.error} errorMessage={fieldState.error?.message} />} /> : null}

            <details className="group">
              <summary className="cursor-default text-body text-ink-2 underline-offset-4 hover:underline">Exclusions</summary>
              <div className="mt-3 flex flex-col gap-4">
                <RhfCheckboxGroup control={form.control} name="excl_category_ids" label="Excluded categories" options={categoryOptions} columns={2} emptyHint="No categories yet." />
                <ProductList control={form} name="excl_product_ids" byId={byId} label="Excluded products" />
                <Controller control={form.control} name="excl_tags" render={({ field }) => <TagsField label="Excluded tags" value={field.value} onChange={field.onChange} />} />
              </div>
            </details>
          </FormSection>

          <FormSection variant="label" title="Conditions" hint="All ticked conditions must hold. Leave a group unticked to not check it.">
            <div className="grid gap-6 sm:grid-cols-2">
              <RhfCheckboxGroup control={form.control} name="cond_order_types" label="Order types" options={ORDER_TYPES.map((t) => ({ id: t, label: ORDER_TYPE_LABEL[t]! }))} />
              <RhfCheckboxGroup control={form.control} name="cond_channels" label="Channels" options={CHANNELS.map((c) => ({ id: c, label: CHANNEL_LABEL[c]! }))} />
              <RhfCheckboxGroup control={form.control} name="cond_outlet_ids" label="Only at these outlets" options={outlets.map((o) => ({ id: o.id, label: o.name }))} emptyHint="No outlets yet." />
              <RhfCheckboxGroup control={form.control} name="cond_excluded_outlet_ids" label="Never at these outlets" options={outlets.map((o) => ({ id: o.id, label: o.name }))} emptyHint="No outlets yet." />
              <RhfCheckboxGroup control={form.control} name="cond_brand_ids" label="Brands" options={brands.map((b) => ({ id: b.id, label: b.name }))} emptyHint="No brands yet." />
              <RhfCheckboxGroup control={form.control} name="cond_customer_group_ids" label="Customer in any of these groups" options={groups.filter((g) => !g.archived).map((g) => ({ id: g.id, label: g.name }))} emptyHint="No customer groups yet. Add them under Customers & groups." />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Controller
                control={form.control}
                name="min_spend_amount"
                render={({ field, fieldState }) => <MoneyField label="Minimum spend" value={field.value} onChange={field.onChange} onBlur={field.onBlur} placeholder="None" description="Measured before discounts." isInvalid={!!fieldState.error} errorMessage={fieldState.error?.message} />}
              />
              <RhfSelect
                control={form.control}
                name="min_spend_basis"
                label="Minimum spend counts"
                items={[
                  { id: "order", label: "The whole order" },
                  { id: "scoped", label: "Only lines in scope" },
                ]}
              />
              <RhfTextField control={form.control} name="active_from" label="Active from" type="datetime-local" numeric description="Empty: no start." />
              <RhfTextField control={form.control} name="active_to" label="Active until" type="datetime-local" numeric description="Empty: no end." />
            </div>
          </FormSection>

          {/* Stacking is about discounts: a fee's form leaves it out (live-test E-L21). */}
          <FormSection variant="label" title="Order of evaluation" hint={kind === "fee" ? "Lower priority runs first." : "Lower priority runs first. An exclusive discount stops later discounts on the lines it touched."}>
            <div className="grid gap-4 sm:grid-cols-2">
              <RhfTextField control={form.control} name="priority" label="Priority" numeric inputMode="numeric" />
              {kind === "fee" ? null : (
                <RhfSelect
                  control={form.control}
                  name="stacking"
                  label="Stacking"
                  items={[
                    { id: "stackable", label: "Stacks with other discounts" },
                    { id: "exclusive", label: "Exclusive", description: "No later discount on the same lines." },
                  ]}
                />
              )}
            </div>
          </FormSection>

          <FormSection variant="label" title="How it is applied">
            <RhfSelect
              control={form.control}
              name="application"
              label="Application"
              items={[
                { id: "auto", label: "Automatic", description: "Applied by the register whenever the conditions hold." },
                { id: "manual", label: "Manual", description: "Staff apply it to an order, with the controls below." },
              ]}
              className="sm:max-w-[360px]"
            />
            {application === "manual" ? (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <RhfSelect control={form.control} name="min_role" label="Minimum role to apply" items={[{ id: NONE, label: "Choose a role" }, ...ROLES.map((r) => ({ id: r, label: ROLE_LABEL[r]! }))]} />
                </div>
                <div className="grid gap-x-6 sm:grid-cols-2">
                  <RhfSwitch control={form.control} name="override_allowed" description="A lower role may apply it with manager approval.">
                    Manager approval can unlock it
                  </RhfSwitch>
                  <RhfSwitch control={form.control} name="reason_required" description="Staff must give a reason, kept in the audit log.">
                    Reason required
                  </RhfSwitch>
                </div>
                <div className="grid gap-6 sm:grid-cols-2">
                  <RhfCheckboxGroup control={form.control} name="disables_report_classes" label="Switches off fees reported as" description="For waivers: a service-charge waiver switches off the service charge." options={REPORT_CLASSES.map((c) => ({ id: c, label: REPORT_CLASS_LABEL[c]! }))} />
                  <RhfCheckboxGroup control={form.control} name="disables_rule_ids" label="Switches off these rules" options={otherRules.map((r) => ({ id: r.rule_key, label: r.body.name }))} emptyHint="No other rules." />
                </div>
              </>
            ) : null}
          </FormSection>

          <FormSection variant="label" title="Effective" hint="When this version starts applying to new orders.">
            <div className="grid gap-4 sm:grid-cols-2">
              <RhfSelect
                control={form.control}
                name="effective"
                label="Takes effect"
                items={[
                  { id: "now", label: "Now" },
                  { id: "at", label: "At a scheduled time" },
                ]}
              />
              {effective === "at" ? <RhfTextField control={form.control} name="effective_at" label="Scheduled for" type="datetime-local" numeric /> : null}
            </div>
            <RhfTextField control={form.control} name="note" label="Note" placeholder="Why this version exists" description="Kept with the version." />
          </FormSection>

          {mayEdit.reason ? <p className="text-body text-ink-2">{mayEdit.reason}</p> : null}

          <InlineError error={save.error ?? archive.error} />
        </form>
      )}
    </Sheet>
    </FieldsLocked>
  );
}

function ProductList({ control, name, byId, label }: { control: ReturnType<typeof useForm<RuleForm>>; name: "scope_product_ids" | "excl_product_ids"; byId: ReturnType<typeof useProductsById>["byId"]; label: string }) {
  const locked = useFieldsLocked();
  return (
    <Controller
      control={control.control}
      name={name}
      render={({ field, fieldState }) => (
        <div className="flex flex-col gap-2">
          <span className="text-caption text-ink-2">{label}</span>
          {field.value.length ? (
            <ul className="flex flex-wrap gap-1.5">
              {field.value.map((id) => (
                <li key={id} className="inline-flex h-8 max-sm:h-11 items-center gap-1 rounded-chip bg-surface-2 pr-1 pl-3 text-caption text-ink">
                  {productName(byId, id)}
                  <Button variant="quiet" iconOnly aria-label={`Remove ${productName(byId, id)}`} isDisabled={locked} className="min-h-6 min-w-6 max-sm:min-h-11 max-sm:min-w-11 rounded-full" onPress={() => field.onChange(field.value.filter((x) => x !== id))}>
                    <Icon icon={X} size={12} />
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          <ProductSearch exclude={field.value} keepQuery onPick={(p) => field.onChange([...field.value, p.id])} className="max-w-[480px]" />
          {fieldState.error ? <span className="text-caption text-status-alert">{fieldState.error.message}</span> : null}
        </div>
      )}
    />
  );
}
