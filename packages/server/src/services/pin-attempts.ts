import { withOwnTransaction } from "../db/client.js";
import { AppError } from "../lib/errors.js";

/**
 * Wrong-PIN lockout: 5 wrong PINs lock the scope for 30
 * seconds. The scope is the station, so wrong sign-in PINs and wrong manager
 * approval PINs on one iPad add up on one counter; off a station (a back-office
 * approval request) it is the requesting staff member. The counter is in Postgres and every write commits on its own, so it holds
 * across API machines and survives the refused request's rollback.
 */
export const PIN_MAX_FAILURES = 5;
export const PIN_LOCK_SECONDS = 30;

/**
 * How many attempts lock a scope, for how long, and what the locked message names. Back-office passwords use the same
 * counter. With `delay`, each attempt after the first `after` also holds the scope for a doubling pause (2, 4, 8 ...
 * seconds, at most `maxSeconds`), so the rate of guesses stays bounded without a long lock anyone could trigger.
 */
export type AttemptLimits = { maxFailures: number; lockSeconds: number; what: string; delay?: { after: number; maxSeconds: number } };
const PIN_LIMITS: AttemptLimits = { maxFailures: PIN_MAX_FAILURES, lockSeconds: PIN_LOCK_SECONDS, what: "wrong PINs" };

export function pinScope(p: { stationId?: string; id: string }): string {
  return p.stationId ? `station:${p.stationId}` : `staff:${p.id}`;
}

function locked(retry: number, what: string): AppError {
  return new AppError("rate_limited", `Too many ${what}`, { remedy: `Try again in ${retry} seconds.`, details: { retry_after_seconds: retry } });
}

/**
 * Count this PIN attempt before the PIN is checked, and throw `rate_limited` while the scope is locked. The fifth
 * attempt locks the scope and starts a fresh count, so a burst of concurrent guesses gets five tries, not one each.
 */
export async function takePinAttempt(merchantId: string, scope: string, limits: AttemptLimits = PIN_LIMITS): Promise<{ lockedNow: boolean }> {
  const r = await withOwnTransaction(async (sql) => {
    // Make sure the row exists and lock it, so concurrent attempts are counted one after another.
    await sql`insert into pin_attempts (merchant_id, scope) values (${merchantId}, ${scope}) on conflict do nothing`;
    const [row] = await sql<{ failures: number; retry: number | null }[]>`select failures, case when locked_until > now() then ceil(extract(epoch from locked_until - now()))::int end as retry from pin_attempts where merchant_id = ${merchantId} and scope = ${scope} for update`;
    if (row!.retry != null) return { retry: row!.retry, lockedNow: false };
    const n = row!.failures + 1;
    const lock = n >= limits.maxFailures;
    const pause = !lock && limits.delay && n > limits.delay.after ? Math.min(2 ** (n - limits.delay.after), limits.delay.maxSeconds) : 0;
    const until = lock ? sql`now() + make_interval(secs => ${limits.lockSeconds})` : pause ? sql`now() + make_interval(secs => ${pause})` : sql`locked_until`;
    await sql`update pin_attempts set failures = ${lock ? 0 : n}, locked_until = ${until}, updated_at = now() where merchant_id = ${merchantId} and scope = ${scope}`;
    return { retry: null, lockedNow: lock };
  });
  if (r.retry != null) throw locked(Math.max(1, r.retry), limits.what);
  return { lockedNow: r.lockedNow };
}

/**
 * A right PIN clears the count but never a lock: otherwise anyone who knows one PIN could sign in between guesses and
 * keep guessing manager PINs for ever.
 */
export async function clearPinFailures(merchantId: string, scope: string): Promise<void> {
  await withOwnTransaction(
    (sql) => sql`delete from pin_attempts where merchant_id = ${merchantId} and scope = ${scope} and (locked_until is null or locked_until <= now())`,
  );
  await withOwnTransaction((sql) => sql`update pin_attempts set failures = 0 where merchant_id = ${merchantId} and scope = ${scope}`);
}
