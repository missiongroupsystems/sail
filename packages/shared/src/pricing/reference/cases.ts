import { BASKET_CASES } from "./cases-baskets.js";
import { CONDITION_CASES } from "./cases-conditions.js";
import { CORE_CASES } from "./cases-core.js";
import { DISCOUNT_CASES } from "./cases-discounts.js";
import { FEE_CASES } from "./cases-fees.js";
import { FREEZE_CASES } from "./cases-freeze.js";
import { MANUAL_CASES } from "./cases-manual.js";
import type { RefCase } from "./dsl.js";

export * from "./dsl.js";

/** Every reference case, without the vitest runner (importable at runtime, for example by the server's simulator tests). */
export const ALL_CASES: RefCase[] = [...CORE_CASES, ...DISCOUNT_CASES, ...FEE_CASES, ...CONDITION_CASES, ...MANUAL_CASES, ...FREEZE_CASES, ...BASKET_CASES];
