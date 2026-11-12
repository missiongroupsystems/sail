"use client";

import { Badge, Button, Checkbox, CheckboxGroup, DescriptionList, EmptyState, Icon, InlineError, Money, MoneyField, PercentField, SectionHeading, Select, taxRows, TextField } from "@sail/ui";
import { useMutation } from "@tanstack/react-query";
import { Minus, Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { CHANNELS, CHANNEL_LABEL, ORDER_TYPES, ORDER_TYPE_LABEL, label } from "@/components/backoffice/labels";
import { ProductSearch } from "@/components/backoffice/ProductSearch";
import { Warnings } from "@/components/backoffice/Warnings";
import { req, type ApiError } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Brand, CustomerGroup, Outlet, PricingRuleVersion, PricingSimulation, Product } from "@/lib/api/types";
import type { Scope } from "@/lib/cookies";
import { bodyOf } from "../rules/rule-form";

type BasketLine = { line_id: string; product: Product; quantity: number; open_price: number | null };
type Manual = { application_id: string; rule_id: string; entered_value: number | null; reason: string };
type TaxMode = "merchant" | "inclusive" | "exclusive";

const OUTCOME_TONE = { applied: "paid", skipped: "neutral", info: "seated", frozen: "sent" } as const;

/**
 * The pricing simulator: a sample basket through the live rule set, with the
 * register's step-by-step trace. Every figure here is the register's.
 */
export function SimulatorView({ outlets, brands, groups, activeRules, rulesError, scope, merchantTaxMode }: { outlets: Outlet[]; brands: Brand[]; groups: CustomerGroup[]; activeRules: PricingRuleVersion[]; rulesError?: { message: string; remedy?: string } | null; scope: Scope; merchantTaxMode: "inclusive" | "exclusive" }) {
  const [outletId, setOutletId] = useState<string | null>(scope.outletId ?? outlets[0]?.id ?? null);
  const [brandId, setBrandId] = useState<string | null>(scope.brandId ?? brands[0]?.id ?? null);
  const [orderType, setOrderType] = useState<string>("dine_in");
  const [channel, setChannel] = useState<string>("pos");
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [taxMode, setTaxMode] = useState<TaxMode>("merchant");
  const [at, setAt] = useState("");
  const [lines, setLines] = useState<BasketLine[]>([]);
  const [manuals, setManuals] = useState<Manual[]>([]);

  const manualRules = useMemo(() => activeRules.map((v) => ({ v, body: bodyOf(v) })).filter((r) => r.body.application === "manual"), [activeRules]);

  const simulate = useMutation<PricingSimulation, ApiError>({
    mutationFn: () =>
      req(
        api.POST("/v1/pricing/simulate", {
          body: {
            outlet_id: outletId!,
            brand_id: brandId!,
            order_type: orderType as (typeof ORDER_TYPES)[number],
            channel: channel as (typeof CHANNELS)[number],
            customer_group_ids: groupIds,
            lines: lines.map((l) => ({ line_id: l.line_id, product_id: l.product.id, quantity: l.quantity, open_price: l.open_price })),
            manual_applications: manuals.map((m) => ({ application_id: m.application_id, rule_id: m.rule_id, entered_value: m.entered_value, reason: m.reason || null })),
            ...(taxMode !== "merchant" ? { tax_mode: taxMode } : {}),
            ...(at ? { at: new Date(at).toISOString() } : {}),
          },
        }),
      ).then((r) => r.data),
  });

  const addLine = (p: Product) =>
    setLines((prev) => {
      const existing = prev.find((l) => l.product.id === p.id);
      if (existing) return prev.map((l) => (l === existing ? { ...l, quantity: l.quantity + 1 } : l));
      return [...prev, { line_id: crypto.randomUUID(), product: p, quantity: 1, open_price: null }];
    });
  const setQty = (id: string, d: number) => setLines((prev) => prev.map((l) => (l.line_id === id ? { ...l, quantity: Math.max(1, l.quantity + d) } : l)));
  const lineName = (id: string) => lines.find((l) => l.line_id === id)?.product.name ?? id.slice(0, 8);

  const result = simulate.data;
  const ready = outletId && brandId && lines.length > 0;

  return (
    <div className="grid gap-x-12 gap-y-10 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <section className="flex flex-col gap-6">
        <SectionHeading title="Order" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Select label="Outlet" selectedKey={outletId} onSelectionChange={setOutletId} items={outlets.map((o) => ({ id: o.id, label: o.name }))} />
          <Select label="Brand" selectedKey={brandId} onSelectionChange={setBrandId} items={brands.map((b) => ({ id: b.id, label: b.name }))} />
          <Select label="Order type" selectedKey={orderType} onSelectionChange={(k) => k && setOrderType(k)} items={ORDER_TYPES.map((t) => ({ id: t, label: ORDER_TYPE_LABEL[t]! }))} />
          <Select label="Channel" selectedKey={channel} onSelectionChange={(k) => k && setChannel(k)} items={CHANNELS.map((c) => ({ id: c, label: CHANNEL_LABEL[c]! }))} />
          <Select
            label="Tax mode"
            selectedKey={taxMode}
            onSelectionChange={(k) => k && setTaxMode(k as TaxMode)}
            items={[
              { id: "merchant", label: `Merchant setting (${merchantTaxMode === "inclusive" ? "tax included" : "tax added"})` },
              { id: "inclusive", label: "Tax included in prices" },
              { id: "exclusive", label: "Tax added at the bill" },
            ]}
          />
          <TextField label="Price as at" type="datetime-local" numeric value={at} onChange={setAt} description="Empty: now. Try a scheduled version." />
        </div>
        {groups.length ? (
          <CheckboxGroup label="Customer in groups" value={groupIds} onChange={setGroupIds} columns={2}>
            {groups.filter((g) => !g.archived).map((g) => (
              <Checkbox key={g.id} value={g.id}>
                {g.name}
              </Checkbox>
            ))}
          </CheckboxGroup>
        ) : null}

        <SectionHeading title="Basket" aside={`${lines.reduce((n, l) => n + l.quantity, 0)} items`} />
        {lines.length ? (
          <ul className="flex flex-col">
            {lines.map((l) => (
              <li key={l.line_id} className="flex flex-wrap items-center gap-2 py-2 hairline-b">
                <span className="min-w-0 flex-1 truncate text-ink">{l.product.name}</span>
                {l.product.open_price ? <MoneyField aria-label={`Open price for ${l.product.name}`} value={l.open_price} onChange={(c) => setLines((prev) => prev.map((x) => (x.line_id === l.line_id ? { ...x, open_price: c } : x)))} placeholder="price" className="w-[120px]" /> : <Money cents={l.product.price} className="text-ink-2" />}
                <span className="inline-flex items-center gap-1">
                  <Button variant="quiet" iconOnly aria-label={`One less ${l.product.name}`} onPress={() => setQty(l.line_id, -1)} isDisabled={l.quantity <= 1}>
                    <Icon icon={Minus} size={16} />
                  </Button>
                  <span className="w-6 text-center tabular">{l.quantity}</span>
                  <Button variant="quiet" iconOnly aria-label={`One more ${l.product.name}`} onPress={() => setQty(l.line_id, 1)}>
                    <Icon icon={Plus} size={16} />
                  </Button>
                </span>
                <Button variant="quiet" iconOnly aria-label={`Remove ${l.product.name}`} onPress={() => setLines((prev) => prev.filter((x) => x.line_id !== l.line_id))}>
                  <Icon icon={X} size={16} />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <ProductSearch label="Add to basket" brandId={brandId} keepQuery onPick={addLine} />

        <SectionHeading title="Manual rules" aside={manualRules.length ? `${manualRules.length} available` : "none active"} />
        {rulesError ? <InlineError error={rulesError} /> : null}
        {manuals.map((m, i) => {
          const rule = manualRules.find((r) => r.v.rule_key === m.rule_id);
          const open = rule?.body.value.type === "open";
          const percent = rule?.body.calc === "percent";
          return (
            <div key={m.application_id} className="grid gap-3 rounded-tile hairline p-3 sm:grid-cols-[1fr_140px_1fr_auto]">
              <Select aria-label="Manual rule" selectedKey={m.rule_id} onSelectionChange={(k) => k && setManuals((prev) => prev.map((x, j) => (j === i ? { ...x, rule_id: k } : x)))} items={manualRules.map((r) => ({ id: r.v.rule_key, label: r.body.name }))} />
              {open ? (
                percent ? (
                  <PercentField aria-label="Entered percentage" value={m.entered_value} onChange={(v) => setManuals((prev) => prev.map((x, j) => (j === i ? { ...x, entered_value: v } : x)))} />
                ) : (
                  <MoneyField aria-label="Entered amount" value={m.entered_value} onChange={(v) => setManuals((prev) => prev.map((x, j) => (j === i ? { ...x, entered_value: v } : x)))} />
                )
              ) : (
                <span className="self-center text-caption text-ink-2">Fixed value</span>
              )}
              <TextField aria-label="Reason" placeholder="Reason" value={m.reason} onChange={(v) => setManuals((prev) => prev.map((x, j) => (j === i ? { ...x, reason: v } : x)))} />
              <Button variant="quiet" iconOnly aria-label="Remove manual rule" onPress={() => setManuals((prev) => prev.filter((_, j) => j !== i))}>
                <Icon icon={X} size={16} />
              </Button>
            </div>
          );
        })}
        {manualRules.length ? (
          <Button onPress={() => setManuals((prev) => [...prev, { application_id: crypto.randomUUID(), rule_id: manualRules[0]!.v.rule_key, entered_value: null, reason: "" }])} className="self-start">
            <Icon icon={Plus} size={16} /> Apply a manual rule
          </Button>
        ) : null}

        <div className="flex items-center gap-3 pt-2">
          <Button variant="primary" size="lg" isDisabled={!ready} isPending={simulate.isPending} onPress={() => simulate.mutate()}>
            Price this basket
          </Button>
          <span className="text-caption text-ink-2">Writes nothing. The register prices it with the live rules.</span>
        </div>
        <InlineError error={simulate.error} />
      </section>

      <section className="flex flex-col gap-8">
        {!result ? (
          <EmptyState title="No result yet" hint="Build a basket on the left and tap Price this basket." />
        ) : (
          <>
            <div>
              <SectionHeading title="Totals" aside={<Badge tone={result.pricing_status === "frozen" ? "sent" : "paid"}>{result.pricing_status}</Badge>} />
              <DescriptionList
                className="mt-2"
                items={[
                  { term: "Subtotal", detail: <Money cents={result.totals.subtotal} />, numeric: true },
                  { term: "Discounts", detail: <Money cents={result.totals.discount_total} />, numeric: true },
                  { term: "Net subtotal", detail: <Money cents={result.totals.net_subtotal} />, numeric: true },
                  { term: "Fees", detail: <Money cents={result.totals.fee_total} />, numeric: true },
                  ...taxRows(result.totals.taxes, result.totals.tax_mode).before.map((t) => ({ term: t.label, detail: <Money cents={t.amount} />, numeric: true })),
                  { term: <span className="text-ink">Total</span>, detail: <Money cents={result.totals.total} size="heading" />, numeric: true },
                  ...taxRows(result.totals.taxes, result.totals.tax_mode).after.map((t) => ({ term: t.label, detail: <Money cents={t.amount} />, numeric: true })),
                ]}
              />
              <Warnings warnings={result.warnings} className="mt-3" />
            </div>

            <div>
              <SectionHeading title="Lines" />
              <div className="overflow-x-auto">
                <table className="mt-2 w-full text-body">
                  <thead>
                    <tr className="text-left text-caption text-ink-2">
                      <th className="py-1 font-medium hairline-b">Line</th>
                      <th className="py-1 text-right font-medium hairline-b">Qty</th>
                      <th className="py-1 text-right font-medium hairline-b">Unit</th>
                      <th className="py-1 text-right font-medium hairline-b">Base</th>
                      <th className="py-1 text-right font-medium hairline-b">Discount</th>
                      <th className="py-1 text-right font-medium hairline-b">Fees</th>
                      <th className="py-1 text-right font-medium hairline-b">Tax</th>
                      <th className="py-1 text-right font-medium hairline-b">Total</th>
                    </tr>
                  </thead>
                  <tbody className="tabular">
                    {result.lines.map((l) => (
                      <tr key={l.line_id} className="hairline-b">
                        <td className="py-1.5 text-ink">{lineName(l.line_id)}</td>
                        <td className="py-1.5 text-right">{l.quantity}</td>
                        <td className="py-1.5 text-right"><Money cents={l.unit_price + l.modifiers_per_unit} /></td>
                        <td className="py-1.5 text-right"><Money cents={l.base_amount} /></td>
                        <td className="py-1.5 text-right"><Money cents={l.discount_amount} /></td>
                        <td className="py-1.5 text-right"><Money cents={l.fee_amount} /></td>
                        <td className="py-1.5 text-right"><Money cents={l.tax_on_net + l.tax_on_fees} /></td>
                        <td className="py-1.5 text-right text-ink"><Money cents={l.total} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <SectionHeading title="Adjustments" aside={`${result.adjustments.length}`} />
              {result.adjustments.length === 0 ? (
                <p className="mt-2 text-ink-2">No fee or discount applied.</p>
              ) : (
                <ul className="mt-2 flex flex-col">
                  {result.adjustments.map((a, i) => (
                    <li key={`${a.rule_id}-${a.manual_application_id ?? i}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 hairline-b">
                      <span className="text-ink">{a.rule_name}</span>
                      <Badge tone={a.kind === "fee" ? "sent" : "seated"}>{a.kind}</Badge>
                      <span className="text-caption text-ink-2">
                        {a.level} · v{a.rule_version} · {label({}, a.report_class)}
                        {a.capped ? " · capped" : ""}
                        {a.frozen ? " · frozen" : ""}
                        {a.manual_application_id ? " · manual" : ""}
                      </span>
                      <span className="ml-auto inline-flex flex-col items-end">
                        <Money cents={a.total} signed />
                        {a.tax_total ? <span className="text-caption text-ink-2">Tax <Money cents={a.tax_total} size="caption" /></span> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <SectionHeading title="Trace" aside="step by step" />
              <ol className="mt-2 flex flex-col gap-4">
                {result.trace.map((step) => (
                  <li key={step.step}>
                    <p className="text-line text-ink">
                      <span className="mr-2 tabular text-ink-2">{step.step}.</span>
                      {step.title}
                    </p>
                    <ul className="mt-1 flex flex-col">
                      {step.entries.map((e, i) => (
                        <li key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5 pl-6 hairline-b last:border-b-0">
                          <Badge tone={OUTCOME_TONE[e.outcome]}>{e.outcome}</Badge>
                          {e.rule_name ? <span className="text-ink">{e.rule_name}</span> : null}
                          <span className="min-w-0 flex-1 text-ink-2">{e.detail}</span>
                          {e.amount !== undefined ? <Money cents={e.amount} signed className="text-ink-2" /> : null}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
