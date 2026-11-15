import { defineConfig } from "tsup";

export default defineConfig({
  // The card-terminal simulator is built too, so an image can run it next to the API for a demo (examples/preview).
  entry: { index: "src/index.ts", migrate: "src/db/migrate.ts", "payment-simulator": "scripts/payment-simulator.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  sourcemap: true,
  clean: true,
  splitting: false,
  // Bundle the workspace package so the image needs no TypeScript at runtime.
  noExternal: ["@sail/shared"],
});
