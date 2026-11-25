// A downstream's tsup config, as docs/extensions.md gives it, for test/ext-bundle.test.ts: run from the downstream's
// own folder, whose package.json names @sail/server only, so tsup itself leaves none of Sail's dependencies external.
import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// Sail's dependencies stay external (the image installs them); those of @sail/shared are among them.
const sail = JSON.parse(readFileSync("node_modules/@sail/server/package.json", "utf8")) as { dependencies: Record<string, string> };

export default defineConfig({
  entry: { server: "src/start.ts", migrate: "src/migrate.ts" },
  format: ["esm"],
  platform: "node",
  noExternal: ["@sail/server", "@sail/shared"],
  external: Object.keys(sail.dependencies).filter((d) => !d.startsWith("@sail/")),
});
