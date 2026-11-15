import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Generate or check the committed OpenAPI spec.
 * `check` fails when the spec built from the code differs from openapi.json,
 * so an unreviewed contract change fails CI.
 */
process.env.DATABASE_URL ??= "postgres://localhost:5432/sail";
process.env.NODE_ENV ??= "development";

const { buildApp } = await import("../src/app.js");
await import("../src/modules.js");

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "..", "openapi.json");
const mode = process.argv[2] ?? "check";

const app = buildApp();
const res = await app.request("/openapi.json");
const doc = (await res.json()) as Record<string, unknown>;
const json = JSON.stringify(doc, null, 2) + "\n";

if (mode === "write") {
  writeFileSync(target, json);
  console.log(`wrote ${target} (${Object.keys((doc.paths as object) ?? {}).length} paths)`);
} else {
  let existing = "";
  try {
    existing = readFileSync(target, "utf8");
  } catch {
    console.error("openapi.json is missing; run `pnpm openapi:generate` and commit it");
    process.exit(1);
  }
  if (existing !== json) {
    console.error("openapi.json is out of date with the routes. Run `pnpm openapi:generate`, review the diff and commit it.");
    process.exit(1);
  }
  console.log("openapi.json is up to date");
}
