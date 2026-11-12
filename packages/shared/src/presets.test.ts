import { describe, expect, it } from "vitest";
import { currencyExponent } from "./money.js";
import { PricingRuleSchema } from "./pricing/schemas.js";
import { SEED_RULE_IDS } from "./pricing/seed.js";
import { presetSeedRules, REGION_PRESET_KEYS, REGION_PRESETS } from "./presets.js";

describe("region presets", () => {
  for (const key of REGION_PRESET_KEYS) {
    const p = REGION_PRESETS[key];
    it(`${key}: is consistent data`, () => {
      expect(p.key).toBe(key);
      const codes = p.tax_classes.map((c) => c.code);
      expect(new Set(codes).size).toBe(codes.length);
      expect(codes).toContain(p.default_tax_class);
      for (const t of [p.service_charge?.tax_class, p.deposit?.tax_class]) if (t != null) expect(codes).toContain(t);
      if (p.currency) expect(currencyExponent(p.currency)).toBeGreaterThanOrEqual(0);
      expect([...p.cash_denominations].sort((a, b) => b - a)).toEqual(p.cash_denominations);
      if (p.cash_rounding_increment != null && p.cash_denominations.length) expect(p.cash_denominations.every((d) => d % p.cash_rounding_increment! === 0)).toBe(true);
      const ids = Object.fromEntries(codes.map((c) => [c, `id-${c}`]));
      for (const r of presetSeedRules(p, ids)) expect(PricingRuleSchema.safeParse(r).success).toBe(true);
    });
  }

  it("sg keeps today's seed: a 10% dine-in service charge taxed at GST 9%, an untaxed 10-cent container deposit, then the six manual discounts", () => {
    const rules = presetSeedRules(REGION_PRESETS.sg, { standard: "std" });
    expect(rules.map((r) => r.id)).toEqual([
      SEED_RULE_IDS.serviceCharge,
      SEED_RULE_IDS.containerDeposit,
      SEED_RULE_IDS.percentOffBill,
      SEED_RULE_IDS.amountOffBill,
      SEED_RULE_IDS.percentOffItem,
      SEED_RULE_IDS.staffMeal,
      SEED_RULE_IDS.managerComp,
      SEED_RULE_IDS.serviceChargeWaiver,
    ]);
    expect(rules[0]).toMatchObject({ value: { amount: 1000 }, conditions: { order_types: ["dine_in"] }, tax_class_id: "std" });
    expect(rules[1]).toMatchObject({ value: { amount: 10 }, scope: { type: "deposit" }, tax_class_id: null });
    expect(REGION_PRESETS.sg.tax_classes).toEqual([{ code: "standard", name: "Standard-rated", components: [{ name: "GST 9%", bps: 900 }] }]);
    expect(REGION_PRESETS.sg.tax_rounding).toBe("per_line");
  });

  it("only presets that name a service charge or deposit seed one", () => {
    for (const key of ["us", "eu-vat", "jp", "blank"] as const) {
      const rules = presetSeedRules(REGION_PRESETS[key], Object.fromEntries(REGION_PRESETS[key].tax_classes.map((c) => [c.code, c.code])));
      expect(rules.some((r) => r.kind === "fee")).toBe(false);
    }
  });
});
