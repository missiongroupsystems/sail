import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", migrate: "src/db/migrate.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  sourcemap: true,
  clean: true,
  splitting: false,
  // Bundle the workspace package so the image needs no TypeScript at runtime.
  noExternal: ["@sail/shared"],
});
