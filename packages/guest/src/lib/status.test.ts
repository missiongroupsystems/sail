import { describe, expect, it } from "vitest";
import { lineStatusLabel, lineStatusTone, roundStage } from "./status";

describe("roundStage", () => {
  it("keeps round 2 Preparing while the order is ready from round 1's bump (final2 C-1)", () => {
    const order = { status: "ready" as const };
    expect(roundStage({ status: "fired", kitchen_done: true }, order)).toBe("done");
    expect(roundStage({ status: "fired", kitchen_done: false }, order)).toBe("preparing");
    expect(roundStage({ status: "accepted", kitchen_done: false }, order)).toBe("accepted");
  });

  it("is Done by the round's own bump, or once the order is completed", () => {
    expect(roundStage({ status: "fired", kitchen_done: true }, { status: "fired" })).toBe("done");
    expect(roundStage({ status: "fired", kitchen_done: false }, { status: "completed" })).toBe("done");
    expect(roundStage({ status: "fired", kitchen_done: false }, { status: "fired" })).toBe("preparing");
  });

  it("shows Sent while waiting and Not accepted when rejected, whatever the order says", () => {
    expect(roundStage({ status: "pending" }, { status: "ready" })).toBe("sent");
    expect(roundStage({ status: "rejected" }, { status: "completed" })).toBe("rejected");
  });
});

describe("line status", () => {
  it("labels round 2's sent line Preparing on a ready order until its own ticket is bumped", () => {
    const order = { status: "ready" as const };
    expect(lineStatusLabel({ status: "fired", kitchen_done: false }, order)).toBe("Preparing");
    expect(lineStatusTone({ status: "fired", kitchen_done: false }, order)).toBe("sent");
    expect(lineStatusLabel({ status: "fired", kitchen_done: true }, order)).toBe("Done");
    expect(lineStatusTone({ status: "fired", kitchen_done: true }, order)).toBe("paid");
    expect(lineStatusLabel({ status: "fired" }, { status: "completed" })).toBe("Done");
  });
});
