import { describe, expect, it } from "vitest";
import { operation, registerOperations, type OperationSpec } from "./manifest.js";

const spec = (op: string, minRole: OperationSpec["minRole"]): OperationSpec => ({ op, summary: "A test operation", description: "A test operation.", tier: "T0", minRole, overrideAllowed: false, reasonRequired: false, dryRun: false, principals: ["staff"], emits: [], mcp: { expose: false, toolsets: [] } });

describe("registerOperations", () => {
  it("refuses a key that is already registered, so a later module cannot lower an operation's role", () => {
    expect(operation("staff.list").minRole).toBe("manager");
    expect(() => registerOperations({ "staff.list": spec("staff.list", "server") })).toThrow("operation staff.list is already registered");
    expect(operation("staff.list").minRole).toBe("manager");
  });

  it("refuses a second registration of its own key, and registers nothing from a refused call", () => {
    registerOperations({ "test.once": spec("test.once", "server") });
    expect(() => registerOperations({ "test.fresh": spec("test.fresh", null), "test.once": spec("test.once", null) })).toThrow("already registered");
    expect(operation("test.once").minRole).toBe("server");
    expect(() => operation("test.fresh")).toThrow("Unknown operation");
  });
});
