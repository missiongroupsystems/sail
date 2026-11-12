"use client";

import { AmountPad, Badge, Button, Checkbox, Money, ReasonPicker, Sheet, Skeleton, useLocale } from "@sail/ui";
import { useEffect, useState } from "react";
import { Button as AriaButton } from "react-aria-components";
import type { ManualRule, OrderSnapshot } from "../api/types";
import type { useOrderActions } from "../hooks/useOrderActions";
import { describeRuleValue } from "../lib/format";
import { usePos } from "./PosContext";

const RANK: Record<string, number> = { server: 10, cashier: 20, manager: 30, finance: 40, admin: 50 };
const QUICK_REASONS = ["Guest complaint", "Staff", "Promotion", "Goodwill", "Manager's discretion"];

export type DiscountSheetProps = {
  isOpen: boolean;
  onClose: () => void;
  order: OrderSnapshot;
  rules: ManualRule[] | undefined;
  actions: ReturnType<typeof useOrderActions>;
};

/**
 * Discount: the manual rules with names and ranges; rules above
 * the role show a Manager approval badge instead of being hidden. Then the
 * value (open rules), the reason (when required), and Apply.
 */
export function DiscountSheet({ isOpen, onClose, order, rules, actions }: DiscountSheetProps) {
  const { money } = useLocale();
  const { staff, offline } = usePos();
  const [rule, setRule] = useState<ManualRule | null>(null);
  const [digits, setDigits] = useState("");
  const [reason, setReason] = useState<string | null>(null);
  const [lineIds, setLineIds] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setRule(null);
      setDigits("");
      setReason(null);
      setLineIds(null);
    }
  }, [isOpen]);

  const live = order.lines.filter((l) => l.status !== "voided" && !l.optimistic);
  const value = rule?.value.type === "open" ? Number(digits || "0") : null;
  const inRange = !rule || rule.value.type === "fixed" || (value !== null && value >= rule.value.min && value <= rule.value.max);
  const needsReason = Boolean(rule?.reason_required) && !reason;
  const needsLines = rule?.level === "line" && lineIds !== null && lineIds.size === 0;
  const canApply = rule && inRange && !needsReason && !needsLines && !busy && !offline;
  const above = (r: ManualRule) => (RANK[staff.role] ?? 0) < (RANK[r.min_role] ?? 0);

  const apply = async () => {
    if (!rule) return;
    setBusy(true);
    const snap = await actions.applyDiscount(rule, rule.value.type === "open" ? value : null, reason, lineIds && lineIds.size ? [...lineIds] : null);
    setBusy(false);
    if (snap) onClose();
  };

  return (
    <Sheet
      isOpen={isOpen}
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={rule ? rule.name : "Discount"}
      description={rule ? describeRuleValue(rule, money) : "Manual rules the register allows on this order"}
      isDismissable={!busy}
      footer={
        rule ? (
          <>
            <Button variant="quiet" size="lg" onPress={() => setRule(null)} isDisabled={busy} className="mr-auto">
              Back to the list
            </Button>
            <Button variant="primary" size="lg" isDisabled={!canApply} isPending={busy} onPress={apply}>
              {offline ? "Offline" : !inRange ? `Enter ${describeRuleValue(rule, money)}` : needsReason ? "Pick a reason" : `Apply ${rule.name}`}
              {above(rule) && inRange && !needsReason && !offline ? <span className="ml-1 rounded-chip bg-[color-mix(in_srgb,var(--status-bill)_14%,transparent)] px-2 text-caption text-status-bill">Manager approval</span> : null}
            </Button>
          </>
        ) : undefined
      }
    >
      {!rules ? (
        <Skeleton lines={4} />
      ) : !rule ? (
        rules.length === 0 ? (
          <p className="text-body text-ink-2">No manual discounts are set up. Add pricing rules in the back office.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rules.map((r) => (
              <li key={r.rule_key}>
                <AriaButton
                  onPress={() => {
                    setRule(r);
                    setDigits("");
                    setReason(null);
                    setLineIds(r.level === "line" ? new Set(live.map((l) => l.id)) : null);
                  }}
                  className="press pos-touch flex min-h-16 w-full items-center justify-between gap-3 rounded-tile bg-surface-2 px-4 text-left outline-none data-[pressed]:scale-[0.98] data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-status-seated"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-line text-ink">{r.name}</span>
                    <span className="block text-caption text-ink-2 tabular">
                      {describeRuleValue(r, money)}
                      {r.kind === "fee" ? " · fee" : ""}
                      {r.reason_required ? " · reason required" : ""}
                    </span>
                  </span>
                  {above(r) ? <Badge tone="bill">Manager approval</Badge> : null}
                </AriaButton>
              </li>
            ))}
          </ul>
        )
      ) : (
        <div className="flex flex-col gap-6">
          {rule.value.type === "open" ? (
            <div className="flex justify-center">
              <AmountPad digits={digits} onChange={setDigits} mode={rule.calc === "percent" ? "percent" : "cents"} hint={`Between ${describeRuleValue(rule, money)}`} />
            </div>
          ) : null}
          {rule.level === "line" && lineIds ? (
            <section>
              <h3 className="mb-2 text-line text-ink">Which items?</h3>
              <div className="flex flex-col gap-1">
                {live.map((l) => (
                  <Checkbox
                    key={l.id}
                    isSelected={lineIds.has(l.id)}
                    onChange={(on) => {
                      const next = new Set(lineIds);
                      if (on) next.add(l.id);
                      else next.delete(l.id);
                      setLineIds(next);
                    }}
                  >
                    <span className="flex w-full items-center justify-between gap-3 text-line">
                      <span>
                        {l.quantity} {l.name}
                      </span>
                      <Money cents={l.amounts.base} />
                    </span>
                  </Checkbox>
                ))}
              </div>
            </section>
          ) : null}
          {rule.reason_required ? (
            <section>
              <h3 className="mb-2 text-line text-ink">Reason</h3>
              {reason ? (
                <div className="flex items-center justify-between gap-3 rounded-tile bg-surface-2 px-4 py-3">
                  <span className="text-line text-ink">{reason}</span>
                  <Button variant="quiet" size="md" onPress={() => setReason(null)}>
                    Change
                  </Button>
                </div>
              ) : (
                <ReasonPicker reasons={QUICK_REASONS.map((r) => ({ id: r, name: r }))} onPick={(r) => setReason(r.text)} />
              )}
            </section>
          ) : null}
        </div>
      )}
    </Sheet>
  );
}
