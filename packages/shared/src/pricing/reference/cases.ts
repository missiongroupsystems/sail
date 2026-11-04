import { BASKET_CASES } from "./cases-baskets.js";
import { BOUNDARY_CASES } from "./cases-boundaries.js";
import { CONDITION_CASES } from "./cases-conditions.js";
import { CORE_CASES } from "./cases-core.js";
import { DISCOUNT_CASES } from "./cases-discounts.js";
import { FEE_CASES } from "./cases-fees.js";
import { FREEZE_CHANGE_CASES } from "./cases-freeze-changes.js";
import { FREEZE_CASES } from "./cases-freeze.js";
import { HAWKER_CASES } from "./cases-hawker.js";
import { INCLUSIVE_CASES } from "./cases-inclusive.js";
import { MANUAL_CASES } from "./cases-manual.js";
import { ORDER_TYPE_CASES } from "./cases-order-types.js";
import { PRESET_CASES } from "./cases-presets.js";
import { QUANTITY_CASES } from "./cases-quantities.js";
import type { RefCase } from "./dsl.js";

export * from "./dsl.js";

/** Every reference case, without the vitest runner (importable at runtime, for example by the server's simulator tests). */
export const ALL_CASES: RefCase[] = [
  ...CORE_CASES,
  ...DISCOUNT_CASES,
  ...FEE_CASES,
  ...CONDITION_CASES,
  ...MANUAL_CASES,
  ...FREEZE_CASES,
  ...BASKET_CASES,
  ...INCLUSIVE_CASES,
  ...ORDER_TYPE_CASES,
  ...QUANTITY_CASES,
  ...HAWKER_CASES,
  ...BOUNDARY_CASES,
  ...PRESET_CASES,
  ...FREEZE_CHANGE_CASES,
];
