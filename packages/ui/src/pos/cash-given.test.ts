import { describe, expect, it } from "vitest";
import { likelyTendered } from "./cash-given";

const EUR = [5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1].map((cents) => ({ cents }));
const USD = [10000, 5000, 2000, 1000, 500, 100, 25, 10, 5, 1].map((cents) => ({ cents }));
const SGD = [10000, 5000, 1000, 500, 200, 100, 50, 20, 10, 5].map((cents) => ({ cents }));

describe("cash given buttons", () => {
  it("offer the usual note: €20 for a bill of €10.00 (C-3)", () => {
    expect(likelyTendered(1000, EUR)).toEqual([1100, 1200, 1500, 2000]);
  });

  it("keep the nearest round-ups and add the next single note when it is not among them", () => {
    expect(likelyTendered(1394, SGD)).toEqual([1400, 1500, 2000, 5000]);
    expect(likelyTendered(4747, SGD)).toEqual([4800, 5000, 10000]);
  });

  it("offer the next whole unit for an amount with cents: €17 for €16.22, not only €18 (review 4 U7)", () => {
    expect(likelyTendered(1622, EUR)).toEqual([1700, 1800, 2000]);
  });

  it("meet a whole amount with whole units: $3 and $5 for $2.00, never $2.25 (review 3, S8)", () => {
    expect(likelyTendered(200, USD)).toEqual([300, 500, 1000]);
    expect(likelyTendered(137, USD)).toEqual([150, 200, 500]);
  });
});
