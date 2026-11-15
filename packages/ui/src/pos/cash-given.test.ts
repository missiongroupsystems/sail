import { describe, expect, it } from "vitest";
import { likelyTendered } from "./cash-given";

const EUR = [5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1].map((cents) => ({ cents }));
const SGD = [10000, 5000, 1000, 500, 200, 100, 50, 20, 10, 5].map((cents) => ({ cents }));

describe("cash given buttons", () => {
  it("offer the usual note: €20 for a bill of €10.00 (C-3)", () => {
    expect(likelyTendered(1000, EUR)).toEqual([1100, 1200, 1500, 2000]);
  });

  it("keep the nearest round-ups and add the next single note when it is not among them", () => {
    expect(likelyTendered(1394, SGD)).toEqual([1400, 1500, 2000, 5000]);
    expect(likelyTendered(4747, SGD)).toEqual([5000, 10000]);
  });
});
