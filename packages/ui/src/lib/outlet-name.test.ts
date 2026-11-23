import { describe, expect, it } from "vitest";
import { outletOwnName } from "./outlet-name";

describe("outletOwnName", () => {
  it("drops a clean brand prefix", () => {
    expect(outletOwnName("Quay Coffee · Dock", "Quay Coffee")).toBe("Dock");
  });
  it("keeps a name that only starts with the brand's words", () => {
    expect(outletOwnName("Quay Coffee Dock", "Quay Coffee")).toBe("Quay Coffee Dock");
    expect(outletOwnName("Quay Coffeehouse · Dock", "Quay Coffee")).toBe("Quay Coffeehouse · Dock");
  });
  it("keeps another brand's name, a bare brand name and a name with nothing after the prefix", () => {
    expect(outletOwnName("Harbour Noodles · Pier", "Quay Coffee")).toBe("Harbour Noodles · Pier");
    expect(outletOwnName("Quay Coffee", "Quay Coffee")).toBe("Quay Coffee");
    expect(outletOwnName("Quay Coffee ·  ", "Quay Coffee")).toBe("Quay Coffee ·  ");
  });
  it("keeps the name when no brand is in view", () => {
    expect(outletOwnName("Quay Coffee · Dock", null)).toBe("Quay Coffee · Dock");
  });
});
