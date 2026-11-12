import { withOwnTransaction } from "../db/client.js";
import { AppError } from "../lib/errors.js";

/**
 * Wrong-PIN lockout (scope doc 4.1): 5 wrong PINs on a station lock it for
 * 30 seconds. The counter is in Postgres and every write commits on its own, so it holds
 * across API machines and survives the refused request's rollback.
 */
export const PIN_MAX_FAILURES = 5;
export const PIN_LOCK_SECONDS = 30;

export function pinScope(p: { stationId: string }): string {
  return `station:${p.stationId}`;
}

function locked(retry: number): AppError {
  return new AppError("rate_limited", "Too many wrong PINs", { remedy: `Try again in ${retry} seconds.`, details: { retry_after_seconds: retry } });
}

/** Throws `rate_limited` while the scope is locked. */
export async function assertPinNotLocked(merchantId: string, scope: string): Promise<void> {
  const [row] = await withOwnTransaction((sql) => sql<{ retry: number }[]>`select ceil(extract(epoch from locked_until - now()))::int as retry from pin_attempts where merchant_id = ${merchantId} and scope = ${scope} and locked_until > now()`);
  if (row) throw locked(Math.max(1, row.retry));
}

/** Count a wrong PIN; the fifth locks the scope and starts a fresh count. */
export async function recordPinFailure(merchantId: string, scope: string): Promise<void> {
  await withOwnTransaction(
    (sql) => sql`
      insert into pin_attempts as a (merchant_id, scope, failures) values (${merchantId}, ${scope}, 1)
      on conflict (merchant_id, scope) do update set
        failures = case when a.failures + 1 >= ${PIN_MAX_FAILURES} then 0 else a.failures + 1 end,
        locked_until = case when a.failures + 1 >= ${PIN_MAX_FAILURES} then now() + make_interval(secs => ${PIN_LOCK_SECONDS}) else a.locked_until end,
        updated_at = now()`,
  );
}

/** A right PIN clears the count. */
export async function clearPinFailures(merchantId: string, scope: string): Promise<void> {
  await withOwnTransaction((sql) => sql`delete from pin_attempts where merchant_id = ${merchantId} and scope = ${scope}`);
}
