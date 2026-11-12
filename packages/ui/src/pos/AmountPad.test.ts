import { describe, expect, it } from "vitest";
import { MAX_AMOUNT } from "@sail/shared";
import { padDigits } from "./AmountPad";

describe("the amount pad", () => {
  it("takes an amount up to the largest the register accepts, so a rupiah bill in the millions can be typed", () => {
    // Rp 15,000,000.00 is 1,500,000,000 minor units: ten digits, which a 9-digit pad refused.
    expect(padDigits("150000000", "0", "cents")).toBe("1500000000");
    expect(padDigits(String(MAX_AMOUNT / 10), "0", "cents")).toBe(String(MAX_AMOUNT));
    expect(padDigits(String(MAX_AMOUNT), "0", "cents")).toBeNull();
    expect(padDigits(String(MAX_AMOUNT / 10), "1", "cents")).toBeNull();
  });

  it("keeps a percentage to 9 digits, drops leading zeros and deletes the last digit", () => {
    expect(padDigits("123456789", "0", "percent")).toBeNull();
    expect(padDigits("0", "5", "cents")).toBe("5");
    expect(padDigits("125", "⌫", "cents")).toBe("12");
  });
});
