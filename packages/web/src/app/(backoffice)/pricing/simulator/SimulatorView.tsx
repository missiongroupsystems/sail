"use client";

import { zonedInputToIso } from "@sail/shared";
import { Badge, Button, Checkbox, CheckboxGroup, EmptyState, Icon, InlineError, Money, MoneyField, Panel, PercentField, Select, taxRows, TextField, useLocale, ValueRows, kindTone, DateField } from "@sail/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Minus, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
  const { timeZone } = useLocale();
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
            ...(at ? { at: zonedInputToIso(at, timeZone) } : {}),
          },
        }),
      ).then((r) => r.data),
    onMutate: () => {
      pricedFor.current = inputs;
    },
  });

  const addLine = (p: Product) =>
    setLines((prev) => {
      const existing = prev.find((l) => l.product.id === p.id);
      if (existing) return prev.map((l) => (l === existing ? { ...l, quantity: l.quantity + 1 } : l));
      return [...prev, { line_id: crypto.randomUUID(), product: p, quantity: 1, open_price: null }];
    });
  const setQty = (id: string, d: number) => setLines((prev) => prev.map((l) => (l.line_id === id ? { ...l, quantity: Math.max(1, l.quantity + d) } : l)));
  const lineName = (id: string) => lines.find((l) => l.line_id === id)?.product.name ?? "a removed line";
  // A result belongs to the basket it was priced for: any change to the basket or the options clears it (E-N5).
  const inputs = JSON.stringify([outletId, brandId, orderType, channel, groupIds, lines.map((l) => [l.line_id, l.product.id, l.quantity, l.open_price]), manuals, taxMode, at]);
  const resetSim = simulate.reset;
  const pricedFor = useRef<string | null>(null);
  useEffect(() => {
    if (pricedFor.current !== null && pricedFor.current !== inputs) {
      pricedFor.current = null;
      resetSim();
    }
  }, [inputs, resetSim]);
  const taxClasses = useQuery({ queryKey: ["tax-classes", "simulator"], queryFn: () => req(api.GET("/v1/tax-classes")).then((r) => r.data as unknown as { id: string; name: string; rates?: { id: string; name: string }[] }[]), staleTime: 300_000 });
  // The register's trace names lines and rates by id; people read the basket's names (live-test E-L11, F-9).
  const taxNames = new Map((taxClasses.data ?? []).flatMap((c) => [[c.id, c.name] as const, ...(c.rates ?? []).map((r) => [r.id, r.name] as const)]));
  const named = (text: string) => text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (id) => lines.find((l) => l.line_id === id)?.product.name ?? taxNames.get(id) ?? "a line");

  const result = simulate.data;
  const ready = outletId && brandId && lines.length > 0;

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <div className="flex min-w-0 flex-col gap-6">
        <Panel title="Order">
          <div className="flex flex-col gap-4 py-2">
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
                  { id: "merchant", label: `Merchant (${merchantTaxMode === "inclusive" ? "included" : "added"})` },
                  { id: "inclusive", label: "Tax included in prices" },
                  { id: "exclusive", label: "Tax added at the bill" },
                ]}
              />
              <DateField label="Price as at" type="datetime" size="md" value={at} onChange={setAt} placeholder="Now" description="Empty: now. Try a scheduled version." />
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
          </div>
        </Panel>

        <Panel title="Basket" body="flush" aside={`${lines.reduce((n, l) => n + l.quantity, 0)} items`}>
          {lines.length ? (
            <ul className="flex flex-col divide-y divide-rule-subtle border-b border-rule-subtle">
              {lines.map((l) => (
                <li key={l.line_id} className="flex flex-wrap items-center gap-2 px-5 py-2">
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
          <div className="px-5 py-4">
            <ProductSearch label="Add to basket" brandId={brandId} keepQuery onPick={addLine} />
          </div>
        </Panel>

        <Panel title="Manual rules" aside={manualRules.length ? `${manualRules.length} available` : "none active"}>
          <div className="flex flex-col gap-3 py-2">
            {rulesError ? <InlineError error={rulesError} /> : null}
            {manuals.map((m, i) => {
              const rule = manualRules.find((r) => r.v.rule_key === m.rule_id);
              const open = rule?.body.value.type === "open";
              const percent = rule?.body.calc === "percent";
              return (
                // The reason gets its own full-width row: squeezed into the rule's row it was 18px wide (E-N6).
                <div key={m.application_id} className="grid gap-3 rounded-[12px] border border-rule p-3 sm:grid-cols-[minmax(0,1fr)_140px_auto]">
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
                  <Button variant="quiet" iconOnly aria-label="Remove manual rule" onPress={() => setManuals((prev) => prev.filter((_, j) => j !== i))}>
                    <Icon icon={X} size={16} />
                  </Button>
                  <TextField aria-label="Reason" placeholder="Reason" value={m.reason} onChange={(v) => setManuals((prev) => prev.map((x, j) => (j === i ? { ...x, reason: v } : x)))} className="sm:col-span-3" />
                </div>
              );
            })}
            {manualRules.length ? (
              <Button onPress={() => setManuals((prev) => [...prev, { application_id: crypto.randomUUID(), rule_id: manualRules[0]!.v.rule_key, entered_value: null, reason: "" }])} className="self-start">
                <Icon icon={Plus} size={16} /> Apply a manual rule
              </Button>
            ) : manuals.length === 0 && !rulesError ? (
              <p className="text-ink-2">No manual rule is active.</p>
            ) : null}
          </div>
        </Panel>

        <div className="flex items-center gap-3 pt-2">
          <Button variant="primary" size="lg" isDisabled={!ready} isPending={simulate.isPending} onPress={() => simulate.mutate()}>
            Price this basket
          </Button>
          <span className="text-caption text-ink-2">Writes nothing. The register prices it with the live rules.</span>
        </div>
        <InlineError error={simulate.error} />
      </div>

      <div className="flex min-w-0 flex-col gap-6">
        {!result ? (
          <EmptyState title="No result yet" hint={lines.length ? "Tap Price this basket for the register's figures for it as it is now." : "Build a basket and tap Price this basket."} />
        ) : (
          <>
            <Panel title="Totals" aside={<Badge tone={result.pricing_status === "frozen" ? "sent" : "paid"}>{result.pricing_status}</Badge>}>
              <ValueRows
                rows={[
                  { label: "Subtotal", value: <Money cents={result.totals.subtotal} /> },
                  { label: "Discounts", value: <Money cents={result.totals.discount_total} /> },
                  { label: "Net subtotal", value: <Money cents={result.totals.net_subtotal} /> },
                  { label: "Fees", value: <Money cents={result.totals.fee_total} /> },
                  ...taxRows(result.totals.taxes, result.totals.tax_mode).before.map((t) => ({ key: t.key, label: t.label, value: <Money cents={t.amount} /> })),
                  { label: <span className="font-heading text-[15px] font-semibold">Total</span>, value: <Money cents={result.totals.total} size="heading" />, strong: true },
                  ...taxRows(result.totals.taxes, result.totals.tax_mode).after.map((t) => ({ key: t.key, label: t.label, value: <Money cents={t.amount} /> })),
                ]}
              />
              <Warnings warnings={result.warnings} className="mt-3 mb-2" />
            </Panel>

            <Panel title="Lines" body="flush">
              <div className="overflow-x-auto">
                <table className="w-full text-body [&_tr>*:first-child]:pl-5 [&_tr>*:last-child]:pr-5 [&_td]:px-2 [&_th]:px-2">
                  <thead>
                    <tr className="text-left text-[14px]">
                      <th className="h-10 border-b border-rule-subtle font-medium text-ink-2">Line</th>
                      <th className="h-10 border-b border-rule-subtle text-right font-medium text-ink-2">Qty</th>
                      <th className="h-10 border-b border-rule-subtle text-right font-medium text-ink-2">Unit</th>
                      <th className="h-10 border-b border-rule-subtle text-right font-medium text-ink-2">Base</th>
                      <th className="h-10 border-b border-rule-subtle text-right font-medium text-ink-2">Discount</th>
                      <th className="h-10 border-b border-rule-subtle text-right font-medium text-ink-2">Fees</th>
                      <th className="h-10 border-b border-rule-subtle text-right font-medium text-ink-2">Tax</th>
                      <th className="h-10 border-b border-rule-subtle text-right font-medium text-ink-2">Total</th>
                    </tr>
                  </thead>
                  <tbody className="tabular">
                    {result.lines.map((l) => (
                      <tr key={l.line_id} className="border-b border-rule-subtle last:border-b-0">
                        <td className="py-3 text-ink">{lineName(l.line_id)}</td>
                        <td className="py-3 text-right">{l.quantity}</td>
                        <td className="py-3 text-right"><Money cents={l.unit_price + l.modifiers_per_unit} /></td>
                        <td className="py-3 text-right"><Money cents={l.base_amount} /></td>
                        <td className="py-3 text-right"><Money cents={l.discount_amount} /></td>
                        <td className="py-3 text-right"><Money cents={l.fee_amount} /></td>
                        <td className="py-3 text-right"><Money cents={l.tax_on_net + l.tax_on_fees} /></td>
                        <td className="py-3 text-right text-ink"><Money cents={l.total} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>

            <Panel title="Adjustments" body="flush" aside={`${result.adjustments.length}`}>
              {result.adjustments.length === 0 ? (
                <p className="px-5 py-4 text-ink-2">No fee or discount applied.</p>
              ) : (
                <ul className="flex flex-col divide-y divide-rule-subtle">
                  {result.adjustments.map((a, i) => (
                    <li key={`${a.rule_id}-${a.manual_application_id ?? i}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-2.5">
                      <span className="text-ink">{a.rule_name}</span>
                      <Badge tone={kindTone(a.kind)}>{a.kind}</Badge>
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
            </Panel>

            <Panel title="Trace" aside="step by step">
              <ol className="flex flex-col gap-4 py-2">
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
                          <span className="min-w-0 flex-1 text-ink-2">{named(e.detail)}</span>
                          {e.amount !== undefined ? <Money cents={e.amount} signed className="text-ink-2" /> : null}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
            </Panel>
          </>
        )}
      </div>
    </div>
  );
}
