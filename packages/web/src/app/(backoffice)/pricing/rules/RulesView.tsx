"use client";

import { Badge, Button, DataTable, EmptyState, Icon, InlineError, Money, type DataTableColumn } from "@sail/ui";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Info } from "lucide-react";
import { useMemo, useState } from "react";
import { label, REPORT_CLASS_LABEL, ROLE_LABEL } from "@/components/backoffice/labels";
import { req } from "@/lib/api";
import { api } from "@/lib/api.browser";
import type { Brand, Category, CustomerGroup, Outlet, PricingRuleVersion, PricingValidationWarning } from "@/lib/api/types";
import { formatBps, formatDayClock } from "@/lib/format";
import { keys } from "@/lib/query";
import { RuleSheet, type RuleSheetState } from "./RuleSheet";
import { bodyOf, type RuleBody } from "./rule-form";

export type RuleRow = { rule_key: string; current: PricingRuleVersion; versions: PricingRuleVersion[]; body: RuleBody };

const STATUS_ORDER: Record<PricingRuleVersion["status"], number> = { active: 0, scheduled: 1, superseded: 2, archived: 3 };

/** One row per rule key: the active version if there is one, else the newest scheduled, else the newest of the rest. */
export function groupVersions(versions: PricingRuleVersion[]): RuleRow[] {
  const byKey = new Map<string, PricingRuleVersion[]>();
  for (const v of versions) byKey.set(v.rule_key, [...(byKey.get(v.rule_key) ?? []), v]);
  return Array.from(byKey.entries())
    .map(([rule_key, list]) => {
      const sorted = list.slice().sort((a, b) => b.version - a.version);
      const current = sorted.slice().sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.version - a.version)[0]!;
      return { rule_key, current, versions: sorted, body: bodyOf(current) };
    })
    .sort((a, b) => (a.body.kind === b.body.kind ? a.body.priority - b.body.priority || a.body.name.localeCompare(b.body.name) : a.body.kind === "fee" ? -1 : 1));
}

export function describeValue(b: RuleBody): string {
  const unit = (n: number) => (b.calc === "percent" ? formatBps(n) : undefined);
  if (b.value.type === "open") {
    const lo = b.value.min;
    const hi = b.value.max;
    return b.calc === "percent" ? `${formatBps(lo)}–${formatBps(hi)}, keyed in` : `keyed in`;
  }
  const amt = b.value.amount;
  if (b.calc === "percent") return unit(amt)!;
  return b.calc === "fixed_per_unit" ? "per unit" : "per order";
}

function statusBadge(v: PricingRuleVersion) {
  switch (v.status) {
    case "active":
      return <Badge tone="paid">Active</Badge>;
    case "scheduled":
      return <Badge tone="sent">Scheduled</Badge>;
    case "superseded":
      return <Badge>Superseded</Badge>;
    case "archived":
      return <Badge tone="alert">Archived</Badge>;
  }
}

export function describeScope(b: RuleBody, categories: Category[]): string {
  switch (b.scope.type) {
    case "all":
      return "Everything";
    case "bcrs":
      return "BCRS items";
    case "tags":
      return `Tags: ${b.scope.tags.join(", ")}`;
    case "products":
      return `${b.scope.product_ids.length} ${b.scope.product_ids.length === 1 ? "product" : "products"}`;
    case "categories": {
      const names = b.scope.category_ids.map((id) => categories.find((c) => c.id === id)?.name ?? "?");
      return names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ");
    }
  }
}

export function RulesView({ initialVersions, outlets, brands, categories, groups }: { initialVersions: PricingRuleVersion[]; outlets: Outlet[]; brands: Brand[]; categories: Category[]; groups: CustomerGroup[] }) {
  const [sheet, setSheet] = useState<RuleSheetState>(null);
  const [showArchived, setShowArchived] = useState(false);

  const versions = useQuery({
    queryKey: keys.pricingRules,
    queryFn: () => req(api.GET("/v1/pricing-rules")).then((r) => r.data),
    initialData: initialVersions,
  });
  const validation = useQuery({
    queryKey: keys.pricingValidation,
    queryFn: () => req(api.POST("/v1/pricing-rules/validate", { body: {} })).then((r) => r.data.warnings),
    staleTime: 30_000,
  });

  const rows = useMemo(() => groupVersions(versions.data).filter((r) => showArchived || r.current.status !== "archived"), [versions.data, showArchived]);
  const archivedCount = useMemo(() => groupVersions(versions.data).filter((r) => r.current.status === "archived").length, [versions.data]);
  const fees = rows.filter((r) => r.body.kind === "fee").length;

  const columns: DataTableColumn<RuleRow>[] = [
    {
      key: "name",
      header: "Rule",
      isRowHeader: true,
      render: (r) => (
        <span>
          <span className="text-ink">{r.body.name}</span>
          <span className="ml-2 font-mono text-caption text-ink-2">{r.rule_key}</span>
        </span>
      ),
    },
    { key: "kind", header: "Kind", render: (r) => (r.body.kind === "fee" ? <Badge tone="sent">Fee</Badge> : <Badge tone="seated">Discount</Badge>) },
    {
      key: "value",
      header: "Value",
      numeric: true,
      render: (r) =>
        r.body.calc === "percent" || r.body.value.type === "open" ? (
          <span>{describeValue(r.body)}</span>
        ) : (
          <span>
            <Money cents={r.body.value.amount} /> <span className="text-caption text-ink-2">{describeValue(r.body)}</span>
          </span>
        ),
    },
    { key: "scope", header: "Applies to", render: (r) => <span className="text-ink-2">{describeScope(r.body, categories)}</span> },
    {
      key: "application",
      header: "How",
      render: (r) => (r.body.application === "auto" ? <span className="text-ink-2">Automatic</span> : <span className="text-ink-2">Manual · {label(ROLE_LABEL, r.body.min_role)}+</span>),
    },
    { key: "report_class", header: "Reports as", render: (r) => <span className="text-ink-2">{label(REPORT_CLASS_LABEL, r.body.report_class)}</span> },
    { key: "priority", header: "Priority", numeric: true, render: (r) => r.body.priority },
    {
      key: "status",
      header: "Status",
      render: (r) => (
        <span className="inline-flex items-center gap-2">
          {statusBadge(r.current)}
          <span className="text-caption text-ink-2 tabular">
            v{r.current.version} · {r.current.status === "scheduled" ? "from " : ""}
            {formatDayClock(r.current.effective_from)}
          </span>
        </span>
      ),
    },
  ];

  const warnings = validation.data ?? [];
  const blocking = warnings.filter((w) => w.severity === "blocking");
  const advisory = warnings.filter((w) => w.severity === "advisory");

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-ink-2 tabular">
          {fees} {fees === 1 ? "fee" : "fees"} · {rows.length - fees} {rows.length - fees === 1 ? "discount" : "discounts"}
          {archivedCount ? (
            <>
              {" · "}
              <Button variant="quiet" className="min-h-0 px-1 py-0 text-body text-ink-2 underline underline-offset-4" onPress={() => setShowArchived((v) => !v)}>
                {showArchived ? "hide" : "show"} {archivedCount} archived
              </Button>
            </>
          ) : null}
        </p>
        <div className="flex items-center gap-2">
          <Button onPress={() => setSheet({ mode: "create", kind: "discount" })}>Add discount</Button>
          <Button variant="primary" onPress={() => setSheet({ mode: "create", kind: "fee" })}>
            Add fee
          </Button>
        </div>
      </div>

      <ValidationPanel blocking={blocking} advisory={advisory} rows={rows} isPending={validation.isPending} error={validation.error} onOpen={(key) => { const r = rows.find((x) => x.rule_key === key); if (r) setSheet({ mode: "edit", row: r }); }} />

      <DataTable
        aria-label="Pricing rules"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.rule_key}
        onRowAction={(r) => setSheet({ mode: "edit", row: r })}
        rowClassName={(r) => (r.current.status === "archived" ? "text-ink-2" : undefined)}
        emptyState={<EmptyState variant="quiet" title="No pricing rules" hint="Tap Add fee or Add discount. The service charge and GST deposit usually come first." />}
      />
      <InlineError error={versions.error} className="mt-4" />

      <RuleSheet state={sheet} onClose={() => setSheet(null)} outlets={outlets} brands={brands} categories={categories} groups={groups} allRules={groupVersions(versions.data)} />
    </>
  );
}

function ValidationPanel({ blocking, advisory, rows, isPending, error, onOpen }: { blocking: PricingValidationWarning[]; advisory: PricingValidationWarning[]; rows: RuleRow[]; isPending: boolean; error: Error | null; onOpen: (ruleKey: string) => void }) {
  const [open, setOpen] = useState(true);
  const nameOf = (id: string) => rows.find((r) => r.rule_key === id)?.body.name ?? id;
  if (isPending) return <p className="mb-4 text-caption text-ink-2">Checking the active rule set…</p>;
  if (error) return <InlineError error={error} className="mb-4" />;
  const total = blocking.length + advisory.length;
  return (
    <div className="mb-4 rounded-tile hairline">
      <div className="flex flex-wrap items-center gap-3 px-4 py-2.5">
        <span className="text-caption uppercase tracking-[0.06em] text-ink-2">Checks</span>
        {total === 0 ? (
          <span className="text-ink">No issues in the active rule set</span>
        ) : (
          <>
            {blocking.length ? (
              <span className="inline-flex items-center gap-1 text-status-alert">
                <Icon icon={AlertTriangle} size={16} /> {blocking.length} blocking
              </span>
            ) : null}
            {advisory.length ? (
              <span className="inline-flex items-center gap-1 text-ink-2">
                <Icon icon={Info} size={16} /> {advisory.length} advisory
              </span>
            ) : null}
            <Button variant="quiet" className="ml-auto" onPress={() => setOpen((v) => !v)}>
              {open ? "Hide" : "Show"}
            </Button>
          </>
        )}
      </div>
      {open && total ? (
        <ul className="flex flex-col hairline-t">
          {[...blocking, ...advisory].map((w, i) => (
            <li key={`${w.code}-${i}`} className="flex flex-wrap items-start gap-3 px-4 py-2 hairline-b last:border-b-0">
              <Icon icon={w.severity === "blocking" ? AlertTriangle : Info} size={16} className={`mt-0.5 ${w.severity === "blocking" ? "text-status-alert" : "text-ink-2"}`} />
              <span className="min-w-0 flex-1">
                <span className="text-ink">{w.message}</span>
                <span className="ml-2 font-mono text-caption text-ink-2">{w.code}</span>
                {w.product_ids?.length ? <span className="ml-2 text-caption text-ink-2">{w.product_ids.length} products</span> : null}
              </span>
              <span className="flex flex-wrap gap-1">
                {w.rule_ids.map((id) => (
                  <Button key={id} variant="quiet" className="min-h-8 px-2 text-caption" onPress={() => onOpen(id)}>
                    {nameOf(id)}
                  </Button>
                ))}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
