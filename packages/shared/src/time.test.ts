import { describe, expect, it } from "vitest";
import { isoToZonedInput, zonedInputToIso, zonedToUtc } from "./index.js";

/**
 * Pricing-rule dates are typed in the merchant's zone, whatever zone the
 * browser is in: a happy hour from 17:00 in Berlin starts at 17:00 Berlin
 * time for a manager editing it from Singapore.
 */
describe("datetime-local values in the merchant's zone", () => {
  it("converts a wall-clock value in the merchant's zone to the instant, in summer and winter time", () => {
    expect(zonedInputToIso("2026-07-01T17:00", "Europe/Berlin")).toBe("2026-07-01T15:00:00.000Z");
    expect(zonedInputToIso("2026-01-15T17:00", "Europe/Berlin")).toBe("2026-01-15T16:00:00.000Z");
    expect(zonedInputToIso("2026-01-15T09:30", "America/New_York")).toBe("2026-01-15T14:30:00.000Z");
    expect(zonedInputToIso("2026-01-01T00:00", "Asia/Tokyo")).toBe("2025-12-31T15:00:00.000Z");
  });

  it("shows a stored instant as the wall clock in the merchant's zone", () => {
    expect(isoToZonedInput("2026-07-01T15:00:00.000Z", "Europe/Berlin")).toBe("2026-07-01T17:00");
    expect(isoToZonedInput("2025-12-31T15:00:00.000Z", "Asia/Tokyo")).toBe("2026-01-01T00:00");
    expect(isoToZonedInput("2026-01-15T14:30:00.000Z", "America/New_York")).toBe("2026-01-15T09:30");
  });

  it("round-trips, and empty or malformed input gives nothing", () => {
    for (const tz of ["Europe/Berlin", "America/New_York", "Asia/Singapore", "Australia/Adelaide"]) expect(isoToZonedInput(zonedInputToIso("2026-03-20T08:15", tz)!, tz)).toBe("2026-03-20T08:15");
    expect(zonedInputToIso("", "Europe/Berlin")).toBeUndefined();
    expect(zonedInputToIso("tomorrow", "Europe/Berlin")).toBeUndefined();
    expect(isoToZonedInput(null, "Europe/Berlin")).toBe("");
    expect(isoToZonedInput("not a date", "Europe/Berlin")).toBe("");
  });
});

describe("zonedToUtc at daylight saving changes", () => {
  it("maps a wall-clock time in the spring-forward gap to the first valid instant after the gap", () => {
    // 02:00 → 03:00 local: every time from 02:00 to 02:59 is the instant the clocks change.
    expect(zonedToUtc("2026-03-29", "02:30", "Europe/Berlin").toISOString()).toBe("2026-03-29T01:00:00.000Z");
    expect(zonedToUtc("2026-03-29", "02:00", "Europe/Berlin").toISOString()).toBe("2026-03-29T01:00:00.000Z");
    expect(zonedToUtc("2026-03-08", "02:30", "America/New_York").toISOString()).toBe("2026-03-08T07:00:00.000Z");
    expect(zonedInputToIso("2026-03-29T02:30", "Europe/Berlin")).toBe("2026-03-29T01:00:00.000Z");
    // Lord Howe Island moves by 30 minutes: 02:00 → 02:30.
    expect(zonedToUtc("2026-10-04", "02:15", "Australia/Lord_Howe").toISOString()).toBe("2026-10-03T15:30:00.000Z");
  });

  it("maps a wall-clock time in the fall-back overlap to its first occurrence", () => {
    expect(zonedToUtc("2026-10-25", "02:30", "Europe/Berlin").toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(zonedToUtc("2026-11-01", "01:30", "America/New_York").toISOString()).toBe("2026-11-01T05:30:00.000Z");
    // Either side of the change is unambiguous.
    expect(zonedToUtc("2026-10-25", "01:59", "Europe/Berlin").toISOString()).toBe("2026-10-24T23:59:00.000Z");
    expect(zonedToUtc("2026-10-25", "03:00", "Europe/Berlin").toISOString()).toBe("2026-10-25T02:00:00.000Z");
  });
});
