import { describe, expect, it } from "vitest";
import { ALL_CASES } from "./index.js";
import { runRefCase } from "./runner.js";
import type { Coverage } from "./dsl.js";

describe("pricing reference set", () => {
  it("has unique case IDs", () => {
    const ids = ALL_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const c of ALL_CASES) {
    it(`${c.id}: ${c.title}`, () => {
      runRefCase(c);
    });
  }

  it("meets the size target for this phase", () => {
    expect(ALL_CASES.length).toBeGreaterThanOrEqual(Number(process.env.SAIL_REFERENCE_MIN ?? 60));
  });

  it("covers every feature in the coverage list", () => {
    const required: Coverage[] = [
      "base_price",
      "order_type_price",
      "open_price",
      "modifiers",
      "quantity",
      "line_percent",
      "line_fixed_per_unit",
      "order_percent",
      "order_fixed",
      "exclusive",
      "stackable",
      "cap",
      "min_spend_scoped",
      "min_spend_order",
      "customer_group",
      "order_type_condition",
      "channel_condition",
      "outlet_condition",
      "brand_condition",
      "date_range",
      "scope_all",
      "scope_categories",
      "scope_products",
      "scope_tags",
      "scope_bcrs",
      "exclusions",
      "fee_percent",
      "fee_fixed_per_unit",
      "fee_fixed_per_order",
      "fee_gst_applicable",
      "fee_not_gst_applicable",
      "fee_no_compounding",
      "tax_inclusive",
      "tax_exclusive",
      "manual_fixed",
      "manual_open",
      "manual_lines",
      "waiver",
      "freeze",
      "rounding",
      "seed_rules",
    ];
    const covered = new Set(ALL_CASES.flatMap((c) => c.covers));
    const missing = required.filter((r) => !covered.has(r));
    expect(missing, `uncovered: ${missing.join(", ")}`).toEqual([]);
  });
});
