/**
 * The migrate entry: `pnpm db:migrate` and, in Sail's image, `node dist/migrate.js`. Sail's migrations, then the sets
 * named in SAIL_MIGRATIONS. Kept apart from the runner so importing the runner (from `@sail/server`) never runs it.
 */
import { migrationSetsFromEnv, runMigrations } from "./migrate.js";

const url = process.env.MIGRATE_DATABASE_URL ?? process.env.LISTEN_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("Set MIGRATE_DATABASE_URL (a 5432 session connection)");
  process.exit(1);
}
runMigrations(url, { log: console.log, sets: migrationSetsFromEnv() })
  .then((r) => {
    console.log(`migrated: ${r.applied} applied, ${r.total} total`);
    for (const s of r.sets) console.log(`migrated (${s.schema}): ${s.applied} applied, ${s.total} total`);
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
