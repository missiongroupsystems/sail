import { BASKET_CASES } from "./cases-baskets.js";
import { CONDITION_CASES } from "./cases-conditions.js";
import { CORE_CASES } from "./cases-core.js";
import { DISCOUNT_CASES } from "./cases-discounts.js";
import { FEE_CASES } from "./cases-fees.js";
import { FREEZE_CASES } from "./cases-freeze.js";
import { MANUAL_CASES } from "./cases-manual.js";
import type { RefCase } from "./dsl.js";

export * from "./dsl.js";
export { runRefCase } from "./runner.js";

/** Every reference case. New files are appended here as the set grows (≥ 60 by v0.2, ≥ 150 by v0.9). */
export const ALL_CASES: RefCase[] = [...CORE_CASES, ...DISCOUNT_CASES, ...FEE_CASES, ...CONDITION_CASES, ...MANUAL_CASES, ...FREEZE_CASES, ...BASKET_CASES];
