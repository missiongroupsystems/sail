import { describe, expect, it } from "vitest";
import { soldOutText } from "./sold-out";

const clock = (iso: string) => new Date(iso).toISOString().slice(11, 16);

describe("sold-out wording", () => {
  it("reads 'until restored' for the register's 'indefinite', and never formats it as a time", () => {
    // E-H1: formatting "indefinite" as a date threw and took the Sold out page down.
    const format = (iso: string) => {
      if (Number.isNaN(Date.parse(iso))) throw new RangeError("Invalid time value");
      return clock(iso);
    };
    expect(soldOutText({ sold_out: true, sold_out_until: "indefinite" }, format)).toBe("Sold out until restored");
    expect(soldOutText({ sold_out: true, sold_out_until: null }, format)).toBe("Sold out until restored");
  });

  it("names the time for a sold-out with an end, and says nothing for an available item", () => {
    expect(soldOutText({ sold_out: true, sold_out_until: "2026-11-13T21:30:00.000Z" }, clock)).toBe("Sold out until 21:30");
    expect(soldOutText({ sold_out: false, sold_out_until: null }, clock)).toBe("");
  });
});
