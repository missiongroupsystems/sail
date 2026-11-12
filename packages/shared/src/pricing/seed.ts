import type { OrderType } from "../domain.js";
import type { PricingRuleInput } from "./schemas.js";

/**
 * Seed rules: every new merchant starts with the manual
 * discounts below, plus the service charge and deposit its region preset
 * names, all editable. IDs are stable `seed:` keys so the database seed and the
 * reference set agree. The service-charge waiver switches off every fee in the
 * `service_charge` reporting class for the order.
 */
export const SEED_RULE_IDS = {
  serviceCharge: "seed:service-charge",
  containerDeposit: "seed:container-deposit",
  percentOffBill: "seed:percent-off-bill",
  amountOffBill: "seed:amount-off-bill",
  percentOffItem: "seed:percent-off-item",
  staffMeal: "seed:staff-meal",
  managerComp: "seed:manager-comp",
  serviceChargeWaiver: "seed:service-charge-waiver",
} as const;

/** What a region preset contributes to the seed rules. Amounts are in the currency's minor units. */
export type SeedRuleOptions = {
  service_charge: { name: string; bps: number; order_types: OrderType[]; tax_class_id: string | null } | null;
  deposit: { name: string; amount: number; tax_class_id: string | null } | null;
  /** Upper bound of the open "Amount off bill" value. */
  amount_off_bill_max: number;
  /** Cap of "% off item" on one order. */
  item_discount_cap: number;
};

export function seedRules(opts: SeedRuleOptions): PricingRuleInput[] {
  const fees: PricingRuleInput[] = [];
  if (opts.service_charge) {
    fees.push({
      id: SEED_RULE_IDS.serviceCharge,
      kind: "fee",
      name: opts.service_charge.name,
      calc: "percent",
      value: { type: "fixed", amount: opts.service_charge.bps },
      scope: { type: "all" },
      conditions: { order_types: opts.service_charge.order_types },
      priority: 100,
      application: "auto",
      tax_class_id: opts.service_charge.tax_class_id,
      report_class: "service_charge",
      seeded: true,
    });
  }
  if (opts.deposit) {
    fees.push({
      id: SEED_RULE_IDS.containerDeposit,
      kind: "fee",
      name: opts.deposit.name,
      calc: "fixed_per_unit",
      value: { type: "fixed", amount: opts.deposit.amount },
      scope: { type: "deposit" },
      conditions: {},
      priority: 110,
      application: "auto",
      tax_class_id: opts.deposit.tax_class_id,
      report_class: "deposit",
      seeded: true,
    });
  }
  return [...fees, ...DISCOUNTS(opts)];
}

const DISCOUNTS = (opts: SeedRuleOptions): PricingRuleInput[] => [
  {
    id: SEED_RULE_IDS.percentOffBill,
    kind: "discount",
    name: "% off bill",
    calc: "percent",
    level: "order",
    value: { type: "open", min: 1, max: 10_000 },
    scope: { type: "all" },
    priority: 50,
    application: "manual",
    min_role: "manager",
    override_allowed: true,
    reason_required: false,
    report_class: "promo",
    seeded: true,
  },
  {
    id: SEED_RULE_IDS.amountOffBill,
    kind: "discount",
    name: "Amount off bill",
    calc: "fixed_per_order",
    level: "order",
    value: { type: "open", min: 1, max: opts.amount_off_bill_max },
    scope: { type: "all" },
    priority: 60,
    application: "manual",
    min_role: "manager",
    override_allowed: true,
    reason_required: false,
    report_class: "promo",
    seeded: true,
  },
  {
    id: SEED_RULE_IDS.percentOffItem,
    kind: "discount",
    name: "% off item",
    calc: "percent",
    level: "line",
    value: { type: "open", min: 1, max: 5000 },
    scope: { type: "all" },
    cap: opts.item_discount_cap,
    priority: 20,
    application: "manual",
    min_role: "cashier",
    override_allowed: true,
    reason_required: false,
    report_class: "promo",
    seeded: true,
  },
  {
    id: SEED_RULE_IDS.staffMeal,
    kind: "discount",
    name: "Staff meal",
    calc: "percent",
    level: "line",
    value: { type: "fixed", amount: 5000 },
    scope: { type: "all" },
    priority: 30,
    application: "manual",
    min_role: "cashier",
    override_allowed: true,
    reason_required: true,
    report_class: "staff_meal",
    seeded: true,
  },
  {
    id: SEED_RULE_IDS.managerComp,
    kind: "discount",
    name: "Manager comp",
    calc: "percent",
    level: "line",
    value: { type: "fixed", amount: 10_000 },
    scope: { type: "all" },
    stacking: "exclusive",
    priority: 10,
    application: "manual",
    min_role: "manager",
    override_allowed: true,
    reason_required: true,
    report_class: "comp",
    seeded: true,
  },
  {
    id: SEED_RULE_IDS.serviceChargeWaiver,
    kind: "discount",
    name: "Service charge waiver",
    calc: "fixed_per_order",
    level: "order",
    value: { type: "fixed", amount: 0 },
    scope: { type: "all" },
    priority: 90,
    application: "manual",
    min_role: "manager",
    override_allowed: true,
    reason_required: true,
    report_class: "other",
    disables: { report_classes: ["service_charge"] },
    seeded: true,
  },
];
