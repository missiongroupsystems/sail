// A downstream's own migrate file, bundled like entry.ts: Sail's migrations from SAIL_FOLDER (a copy of Sail's
// packages/server/drizzle in the image), or found next to the runner when it is unset.
import { runMigrations } from "@sail/server";

const r = await runMigrations(process.env.DATABASE_URL!, { folder: process.env.SAIL_FOLDER || undefined });
console.log(JSON.stringify(r));
