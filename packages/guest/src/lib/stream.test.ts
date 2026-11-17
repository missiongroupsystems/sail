import { describe, expect, it } from "vitest";
import { changeType } from "./stream";

describe("changeType", () => {
  it("reads the event type of a change frame, so stock changes refetch the menu (final2 C-2)", () => {
    expect(changeType(JSON.stringify({ seq: 4, type: "stock.sold_out", aggregate_kind: "product" }))).toBe("stock.sold_out");
    expect(changeType(JSON.stringify({ seq: 5, type: "round.accepted" }))).toBe("round.accepted");
    expect(changeType("not json")).toBe("");
    expect(changeType("null")).toBe("");
  });
});
