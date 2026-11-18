import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { config } from "../config.js";
import * as schema from "./schema/index.js";
import type { MoneyEffect } from "./schema/index.js";

export type Db = PostgresJsDatabase<typeof schema>;

export type RequestTx = {
  sql: TransactionSql;
  db: Db;
  /** Principal context applied with set_config for this transaction. */
  principal: { type: string; id: string; merchantId: string | null } | null;
  /** Dry run: the transaction will be rolled back; events skip sequence allocation and emit nothing. */
  dryRun: boolean;
  /** Set once `settleInvariants` has run: the money tables must not be written again in this transaction. */
  settled: boolean;
  /**
   * A proposal being executed: its order must still be at the version the approver saw (checked by `lockOrder`), and
   * its money effect, when it has one, must still be what the approver was shown (checked by `defineOp`).
   */
  pinnedOrder: { orderId: string; version: number; effect: MoneyEffect | null } | null;
};

const als = new AsyncLocalStorage<RequestTx>();

let pool: Sql | null = null;

/**
 * Money amounts and their sums are bigint (int8) columns. postgres.js reads int8 as a string; here it is a number,
 * which is exact up to 2^53, and an int8 above that is an error rather than a rounded amount. API input stays far
 * below it (`MAX_AMOUNT`), so only a sum of billions of maximum orders could reach it.
 */
export const PG_TYPES = {
  int8: {
    to: 20,
    from: [20],
    serialize: (x: number) => String(x),
    parse: (x: string) => {
      const n = Number(x);
      if (!Number.isSafeInteger(n)) throw new RangeError(`int8 ${x} is beyond the safe integer range`);
      return n;
    },
  },
};

/** The transaction-pooler connection (6543). `prepare: false` because prepared statements break on the pooler. */
export function pool6543(): Sql {
  if (!pool) {
    const cfg = config();
    pool = postgres(cfg.DATABASE_URL, {
      max: cfg.DB_POOL_MAX,
      prepare: false,
      idle_timeout: 30,
      connect_timeout: 10,
      onnotice: () => {},
      types: PG_TYPES,
    });
  }
  return pool;
}

/** A dedicated session connection (5432) for LISTEN, session advisory locks and migrations. */
export function sessionConnection(): Sql {
  const cfg = config();
  const url = cfg.LISTEN_DATABASE_URL ?? cfg.DATABASE_URL;
  return postgres(url, { max: 1, prepare: false, onnotice: () => {}, types: PG_TYPES });
}

export async function closePool() {
  if (control) {
    await control.end({ timeout: 5 });
    control = null;
  }
  if (pool) {
    await pool.end({ timeout: 5 });
    pool = null;
  }
}

/** For tests: swap the pool. */
export function setPoolForTests(sql: Sql | null) {
  pool = sql;
}

/**
 * Run `fn` inside one transaction bound to the async context, so `db()` and
 * `tx()` inside route handlers and services resolve to it.
 */
export async function withTransaction<T>(fn: (ctx: RequestTx) => Promise<T>, principal: RequestTx["principal"] = null): Promise<T> {
  const sql = pool6543();
  return sql.begin(async (t) => {
    await boundWaits(t);
    // Drizzle's postgres-js driver reads `client.options` (parsers/serializers); a
    // TransactionSql has none, so borrow the pool's options for the handle.
    const client = Object.assign(t, { options: (sql as unknown as { options: unknown }).options }) as unknown as Sql;
    const ctx: RequestTx = { sql: t, db: drizzle(client, { schema }), principal, dryRun: false, settled: false, pinnedOrder: null };
    return als.run(ctx, () => fn(ctx));
  }) as Promise<T>;
}

/**
 * Run `fn` in a short transaction of its own, as the connection owner, that
 * commits whatever happens to the request around it. For counters a refused
 * request must still record (wrong PINs, rate-limit hits).
 */
export async function withOwnTransaction<T>(fn: (sql: TransactionSql) => Promise<T>): Promise<T> {
  return pool6543().begin(async (t) => {
    await boundWaits(t);
    return fn(t);
  }) as Promise<T>;
}

/**
 * No transaction waits without end: a lock held elsewhere (another request, the worker, a session outside the API)
 * fails this one after DB_LOCK_TIMEOUT_MS (55P03), and a statement running past DB_STATEMENT_TIMEOUT_MS is cancelled
 * (57014). The request then answers 503 `overloaded`. Local to the transaction, so the pooler's connection is left as
 * it was.
 */
async function boundWaits(t: TransactionSql, marker?: string) {
  const cfg = config();
  if (marker) await t`select set_config('lock_timeout', ${`${cfg.DB_LOCK_TIMEOUT_MS}ms`}, true), set_config('statement_timeout', ${`${cfg.DB_STATEMENT_TIMEOUT_MS}ms`}, true), set_config('application_name', ${marker}, true)`;
  else await t`select set_config('lock_timeout', ${`${cfg.DB_LOCK_TIMEOUT_MS}ms`}, true), set_config('statement_timeout', ${`${cfg.DB_STATEMENT_TIMEOUT_MS}ms`}, true)`;
}

/**
 * How long past its lock and statement timeouts a request's transaction may run before the request gives up on it
 * (review 5, V7). Those two bound what the database does; nothing bounded the round trip itself, so a COMMIT whose
 * reply a pooler lost held its admission slot and connection until the HTTP client gave up.
 */
export const TX_DEADLINE_MARGIN_MS = 5_000;
export function txDeadlineMs(): number {
  const cfg = config();
  return cfg.DB_LOCK_TIMEOUT_MS + cfg.DB_STATEMENT_TIMEOUT_MS + TX_DEADLINE_MARGIN_MS;
}

/** Thrown when a request's transaction is past its deadline: the request answers 503 `overloaded`. */
export class TxDeadlineError extends Error {
  constructor(readonly ms: number) {
    super(`transaction past its ${ms} ms deadline`);
  }
}

let control: Sql | null = null;
/** A connection of its own, so a transaction past its deadline can be ended even when the request pool is exhausted. */
function controlConnection(): Sql {
  if (!control) {
    const cfg = config();
    control = postgres(cfg.LISTEN_DATABASE_URL ?? cfg.DATABASE_URL, { max: 1, prepare: false, idle_timeout: 30, connect_timeout: 5, onnotice: () => {}, types: PG_TYPES });
  }
  return control;
}

/**
 * For tests: hold a request's transaction before its commit or after it (its reply late) for `ms`; or let its COMMIT run
 * past every timeout (`slow_commit`: the statement timeout is lifted for it, so a deferred trigger can keep it waiting).
 */
let stallForTests: { at: "before_commit" | "after_commit" | "slow_commit"; ms: number } | null = null;
export function setTxStallForTests(s: typeof stallForTests) {
  stallForTests = s;
}

/**
 * A request's transaction, raced against `txDeadlineMs()`. On expiry it throws `TxDeadlineError` at once (the caller
 * releases its admission slot and answers 503) and the transaction is abandoned:
 * - While its code still runs, its handles are swapped for ones that refuse, so its next query fails and postgres.js
 *   rolls it back on its own connection, which then goes back to the pool clean. The session is not ended under it:
 *   postgres.js would write that query or the rollback to a closed connection, or to the same connection reconnected
 *   for another request.
 * - Once its code is done and only the COMMIT (or ROLLBACK) reply is awaited (a reply a pooler lost), the session is
 *   ended if it is still in this transaction, found by the transaction's own `application_name`, which a commit or
 *   rollback resets, so a session a pooler has since given to another client is never touched. Ending it rolls back
 *   what had not committed and closes the connection, so the pool drops it rather than hand it on in an unknown state.
 * When the commit did land, the request's idempotency row landed with it, and a retry with the same key replays the
 * answer; when it did not, the retry does it afresh.
 */
export async function withRequestTransaction<T>(fn: (ctx: RequestTx) => Promise<T>): Promise<T> {
  const ms = txDeadlineMs();
  const marker = `sail-tx-${randomUUID()}`;
  const stall = stallForTests;
  const sql = pool6543();
  let ctx: RequestTx | null = null;
  let codeDone = false;
  let abandoned = false;
  const work = (sql.begin(async (t) => {
    try {
      await boundWaits(t, marker);
      const client = Object.assign(t, { options: (sql as unknown as { options: unknown }).options }) as unknown as Sql;
      ctx = { sql: t, db: drizzle(client, { schema }), principal: null, dryRun: false, settled: false, pinnedOrder: null };
      const out = await als.run(ctx, () => fn(ctx!));
      if (stall?.at === "before_commit") await new Promise((r) => setTimeout(r, stall.ms));
      if (stall?.at === "slow_commit") await t`select set_config('statement_timeout', '0', true)`;
      if (abandoned) throw new TxDeadlineError(ms);
      return out;
    } finally {
      codeDone = true;
    }
  }) as Promise<T>).then(async (out) => {
    if (stall?.at === "after_commit") await new Promise((r) => setTimeout(r, stall.ms));
    return out;
  });
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new TxDeadlineError(ms)), ms)));
  try {
    return await Promise.race([work, late]);
  } catch (e) {
    if (e instanceof TxDeadlineError) {
      abandoned = true;
      work.catch(() => {});
      if (ctx) refuseFurtherQueries(ctx, ms);
      if (codeDone) await endSession(marker);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Swap an abandoned transaction's handles for ones that throw, so code still running cannot write through it. */
function refuseFurtherQueries(ctx: RequestTx, ms: number) {
  const refuse = () => {
    throw new TxDeadlineError(ms);
  };
  ctx.db = new Proxy({} as Db, { get: refuse });
  ctx.sql = new Proxy(refuse as unknown as TransactionSql, { apply: refuse, get: refuse });
}

/** End the session still running the transaction marked `marker`, if any; at most two seconds, and never throws. */
async function endSession(marker: string) {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      controlConnection()`select pg_terminate_backend(pid) from pg_stat_activity where application_name = ${marker} and pid <> pg_backend_pid()`,
      new Promise((r) => (timer = setTimeout(r, 2_000))),
    ]);
  } catch {
    // The session is gone already, or the database is unreachable: either way nothing of it can be handed on.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fire the deferred invariant triggers (adjustment, order-total, allocation and
 * refund sums) now instead of at commit. Mutations call this after their last
 * money write and before they append events: the first event takes the outlet's
 * sequence lock until commit, so anything that runs at commit runs under that
 * lock and serialises every other writer at the outlet. Checking first keeps
 * the critical section to the appends and the commit itself.
 */
export async function settleInvariants(): Promise<void> {
  const t = currentTx();
  if (t.settled) return;
  t.settled = true;
  await t.sql`set constraints all immediate`;
}

/** Guard for code that writes the money tables: after `settleInvariants` those writes would bypass the deferred checks' batching and signal a sequencing bug. */
export function assertNotSettled(what: string) {
  if (als.getStore()?.settled) throw new Error(`${what} after settleInvariants(): write the money tables before appending events`);
}

export function currentTx(): RequestTx {
  const ctx = als.getStore();
  if (!ctx) throw new Error("No request transaction in this async context. Did the RLS middleware run?");
  return ctx;
}

export function maybeTx(): RequestTx | undefined {
  return als.getStore();
}

/** Mark the current request transaction as a dry run. */
export function markDryRun() {
  currentTx().dryRun = true;
}
export function isDryRun(): boolean {
  return als.getStore()?.dryRun ?? false;
}

/** The Drizzle handle for the current request transaction. */
export function db(): Db {
  return currentTx().db;
}

/** The raw postgres.js handle for the current request transaction. */
export function tx(): TransactionSql {
  return currentTx().sql;
}

export { schema };
