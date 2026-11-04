import { CORE_CASES } from "./cases-core.js";
import type { RefCase } from "./dsl.js";

export * from "./dsl.js";
export { runRefCase } from "./runner.js";

/** Every reference case. New files are appended here as the set grows (≥ 60 by v0.2, ≥ 150 by v0.9). */
export const ALL_CASES: RefCase[] = [...CORE_CASES];
