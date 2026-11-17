import { describe, expect, it } from "vitest";
import { phoneSearchDigits, toE164 } from "./phone.js";

describe("mobile numbers in E.164", () => {
  it("adds the merchant's country to a national number, with or without its trunk 0", () => {
    expect(toE164("(555) 555-0123", "en-US")).toBe("+15555550123");
    expect(toE164("1 555 555 0123", "en-US")).toBe("+15555550123");
    expect(toE164("9123 4567", "en-SG")).toBe("+6591234567");
    expect(toE164("0171 234 5678", "de-DE")).toBe("+491712345678");
    expect(toE164("07700 900123", "en-GB")).toBe("+447700900123");
  });
  it("keeps a number's own country code", () => {
    expect(toE164("+65 9123 4567", "en-US")).toBe("+6591234567");
    expect(toE164("0044 7700 900123", "en-US")).toBe("+447700900123");
  });
  it("searches on any three or more digits, with or without the country code", () => {
    expect(phoneSearchDigits("55", "en-US")).toEqual([]);
    expect(phoneSearchDigits("555", "en-US")).toEqual(["555"]);
    expect(phoneSearchDigits("+1 555 555", "en-US")).toEqual(["1555555", "555555"]);
    expect(phoneSearchDigits("0171 23", "de-DE")).toEqual(["017123", "17123"]);
  });
});
