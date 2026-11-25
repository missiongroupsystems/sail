// A downstream set-up script at its smallest, for test/ext-setup-script.test.ts: it writes through Sail's pool, then
// closes it, and so ends on its own, with no process.exit.
import { closePool, withTransaction } from "@sail/server";

const [row] = await withTransaction(({ sql }) => sql<{ n: number }[]>`select count(*)::int as n from merchants`);
console.log(JSON.stringify({ merchants: row!.n }));
await closePool();
