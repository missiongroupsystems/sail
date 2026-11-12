import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Generate or check the committed MCP tool manifest (vision 7.1): the tools an
 * agent can reach, derived from the OpenAPI spec and its x-sail manifest with no
 * logic of its own. `check` fails CI when a route's exposure changed without the
 * manifest being regenerated and reviewed.
 */
process.env.DATABASE_URL ??= "postgres://localhost:5432/sail";
process.env.NODE_ENV ??= "development";

const { buildApp } = await import("../src/app.js");
await import("../src/modules.js");
const { loadCatalog } = await import("../src/mcp/index.js");

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "..", "mcp-tools.json");
const mode = process.argv[2] ?? "check";

const catalog = await loadCatalog(buildApp());
const json = JSON.stringify({ generated_from: "openapi.json x-sail manifest", tools: catalog.map(({ name, op, method, path, tier, min_role, toolsets, emits, untrusted, description, inputSchema }) => ({ name, op, method, path, tier, min_role, toolsets, emits, untrusted, description, inputSchema })) }, null, 2) + "\n";

if (mode === "write") {
  writeFileSync(target, json);
  console.log(`wrote ${target} (${catalog.length} tools)`);
} else {
  let existing = "";
  try {
    existing = readFileSync(target, "utf8");
  } catch {
    console.error("mcp-tools.json is missing; run `pnpm manifest:generate` and commit it");
    process.exit(1);
  }
  if (existing !== json) {
    console.error("mcp-tools.json is out of date with the routes. Run `pnpm manifest:generate`, review the diff and commit it.");
    process.exit(1);
  }
  console.log("mcp-tools.json is up to date");
}
