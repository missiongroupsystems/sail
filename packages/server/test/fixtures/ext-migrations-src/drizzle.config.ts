import { defineConfig } from "drizzle-kit";

// Regenerates the fixture's migrations: pnpm --filter @sail/server exec drizzle-kit generate --config test/fixtures/ext-migrations-src/drizzle.config.ts
export default defineConfig({
  dialect: "postgresql",
  schema: "./test/fixtures/ext-migrations-src/schema.ts",
  out: "./test/fixtures/ext-migrations",
  schemaFilter: ["ext_fixture"],
});
