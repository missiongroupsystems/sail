import { AsyncLocalStorage } from "node:async_hooks";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { config } from "../config.js";
import * as schema from "./schema/index.js";

export type Db = PostgresJsDatabase<typeof schema>;

export type RequestTx = {
  sql: TransactionSql;
  db: Db;
  /** Principal context applied with set_config for this transaction. */
  principal: { type: string; id: string; merchantId: string | null } | null;
};

const als = new AsyncLocalStorage<RequestTx>();

let pool: Sql | null = null;

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
    });
  }
  return pool;
}

/** A dedicated session connection (5432) for LISTEN, session advisory locks and migrations. */
export function sessionConnection(): Sql {
  const cfg = config();
  const url = cfg.LISTEN_DATABASE_URL ?? cfg.DATABASE_URL;
  return postgres(url, { max: 1, prepare: false, onnotice: () => {} });
}

export async function closePool() {
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
    // Drizzle's postgres-js driver reads `client.options` (parsers/serializers); a
    // TransactionSql has none, so borrow the pool's options for the handle.
    const client = Object.assign(t, { options: (sql as unknown as { options: unknown }).options }) as unknown as Sql;
    const ctx: RequestTx = { sql: t, db: drizzle(client, { schema }), principal };
    return als.run(ctx, () => fn(ctx));
  }) as Promise<T>;
}

export function currentTx(): RequestTx {
  const ctx = als.getStore();
  if (!ctx) throw new Error("No request transaction in this async context. Did the RLS middleware run?");
  return ctx;
}

export function maybeTx(): RequestTx | undefined {
  return als.getStore();
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
