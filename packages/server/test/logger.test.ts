import { describe, expect, it } from "vitest";
import { processRole } from "../src/logger.js";

/** One machine can run the API, the worker and the MCP adapter side by side (examples/preview), so each log line must name its process. */
describe("the logger's role", () => {
  it("comes from the --role flag, which index.ts reads after the logger is built", () => {
    expect(processRole(["node", "dist/index.js", "--role=worker"], {})).toBe("worker");
    expect(processRole(["node", "dist/index.js", "--role=mcp"], { SAIL_ROLE: "app" })).toBe("mcp");
  });

  it("falls back to SAIL_ROLE, then to the API", () => {
    expect(processRole(["node", "dist/index.js"], { SAIL_ROLE: "worker" })).toBe("worker");
    expect(processRole(["node", "dist/index.js"], {})).toBe("app");
  });
});
