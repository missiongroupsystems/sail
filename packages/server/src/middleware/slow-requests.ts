import type { MiddlewareHandler } from "hono";
import postgres, { type Sql } from "postgres";
import { config } from "../config.js";
import type { AppEnv } from "../lib/context.js";
import { logger } from "../logger.js";
import { admissionGate } from "./pipeline.js";

let diag: Sql | null = null;
/** A connection of its own: when the request pool is exhausted, the snapshot must still be readable. */
function diagnostics(): Sql {
  if (!diag) {
    const cfg = config();
    diag = postgres(cfg.LISTEN_DATABASE_URL ?? cfg.DATABASE_URL, { max: 1, prepare: false, idle_timeout: 30, connect_timeout: 5, onnotice: () => {} });
  }
  return diag;
}

/** What the database is doing right now: its sessions other than idle ones, and the locks it has not granted, with who blocks them. */
export async function databaseSnapshot(sql: Sql = diagnostics()) {
  return sql.begin(async (t) => {
    await t`set local statement_timeout = 2000`;
    const sessions = await t`
      select pid, state, wait_event_type, wait_event, pg_blocking_pids(pid) as blocked_by,
        round(extract(epoch from now() - xact_start) * 1000) as xact_ms,
        round(extract(epoch from now() - query_start) * 1000) as query_ms,
        left(query, 300) as query
      from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid() and state is distinct from 'idle'
      order by xact_start nulls last`;
    const waiting = await t`
      select l.pid, l.locktype, l.mode, c.relname as relation, l.transactionid::text as transaction_id
      from pg_locks l left join pg_class c on c.oid = l.relation
      where not l.granted`;
    const idle = await t`select count(*)::int as n from pg_stat_activity where datname = current_database() and state = 'idle'`;
    return { sessions: [...sessions], waiting_locks: [...waiting], idle_connections: idle[0]?.n ?? 0 };
  });
}

/**
 * Diagnostics, off unless SLOW_REQUEST_LOG_MS is set: a request still unanswered after that long is logged once, with
 * the admission gate's counters and a snapshot of the database, so a request that hangs leaves a trace of why.
 */
export const slowRequests: MiddlewareHandler<AppEnv> = async (c, next) => {
  const after = config().SLOW_REQUEST_LOG_MS;
  if (!after) return next();
  const started = Date.now();
  const timer = setTimeout(() => {
    const gate = admissionGate();
    const base = { method: c.req.method, path: c.req.path, requestId: c.get("requestId"), open_ms: Date.now() - started, gate: { in_flight: gate.inFlight, waiting: gate.waiting, rejected: gate.rejected, timed_out: gate.timedOut } };
    databaseSnapshot()
      .then((db) => logger.warn({ ...base, db }, "slow request"))
      .catch((err: unknown) => logger.warn({ ...base, db_error: String(err) }, "slow request"));
  }, after);
  timer.unref();
  try {
    await next();
  } finally {
    clearTimeout(timer);
    const ms = Date.now() - started;
    if (ms >= after) logger.warn({ method: c.req.method, path: c.req.path, requestId: c.get("requestId"), status: c.res.status, ms }, "slow request answered");
  }
};
