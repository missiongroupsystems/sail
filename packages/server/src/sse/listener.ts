import type { ListenMeta, Sql } from "postgres";
import { sessionConnection } from "../db/client.js";
import { logger } from "../logger.js";

/**
 * LISTEN on one dedicated session connection (port 5432) and fan each
 * notification out to in-process SSE subscribers.
 * pg_notify is not durable: after the connection drops and recovers, every
 * subscriber receives `resync` and catches up from the event log.
 */
export type Notification =
  | { kind: "event"; merchant_id: string; outlet_id: string | null; seq: number; type: string; aggregate_kind: string; aggregate_id: string }
  | { kind: "print_job"; merchant_id: string; outlet_id: string; job_id: string; status: string; printer_id: string | null; relay_hint: string | null }
  | { kind: "resync" };

type Subscriber = (n: Notification) => void;

const subscribers = new Map<string, Set<Subscriber>>();
let sql: Sql | null = null;
let listenMeta: ListenMeta | null = null;
let connectCount = 0;

export function channelKeys(n: Notification): string[] {
  if (n.kind === "resync") return [...subscribers.keys()];
  if (n.kind === "print_job") return [`relay:${n.outlet_id}`, `outlet:${n.outlet_id}`];
  const keys = [`merchant:${n.merchant_id}`];
  if (n.outlet_id) keys.push(`outlet:${n.outlet_id}`);
  if (n.aggregate_kind === "order") keys.push(`order:${n.aggregate_id}`);
  return keys;
}

export function subscribe(key: string, fn: Subscriber): () => void {
  let set = subscribers.get(key);
  if (!set) {
    set = new Set();
    subscribers.set(key, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) subscribers.delete(key);
  };
}

export function subscriberCount(): number {
  let n = 0;
  for (const s of subscribers.values()) n += s.size;
  return n;
}

/** Deliver a notification to every matching subscriber (also used by tests and by the in-process fast path). */
export function broadcast(n: Notification) {
  const seen = new Set<Subscriber>();
  for (const key of channelKeys(n)) {
    const set = subscribers.get(key);
    if (!set) continue;
    for (const fn of set) {
      if (seen.has(fn)) continue;
      seen.add(fn);
      try {
        fn(n);
      } catch (e) {
        logger.warn({ err: e }, "subscriber threw");
      }
    }
  }
}

export async function startListener(): Promise<void> {
  if (sql) return;
  sql = sessionConnection();
  listenMeta = await sql.listen(
    "sail_events",
    (payload) => {
      try {
        const n = JSON.parse(payload) as Notification;
        broadcast(n);
      } catch (e) {
        logger.warn({ err: e, payload }, "bad notification payload");
      }
    },
    () => {
      connectCount++;
      if (connectCount > 1) {
        logger.warn("LISTEN connection re-established; sending resync to all streams");
        broadcast({ kind: "resync" });
      } else {
        logger.info("LISTEN sail_events established");
      }
    },
  );
}

export async function stopListener(): Promise<void> {
  if (listenMeta) {
    try {
      await listenMeta.unlisten();
    } catch {
      /* ignore */
    }
    listenMeta = null;
  }
  if (sql) {
    await sql.end({ timeout: 2 });
    sql = null;
  }
  connectCount = 0;
}

/**
 * The backend PID of the LISTEN connection, for tests that kill it. postgres.js
 * opens a dedicated connection for `listen`, so look it up in pg_stat_activity.
 */
export async function listenerPid(): Promise<number | null> {
  if (!sql) return null;
  const rows = await sql<{ pid: number }[]>`
    select pid from pg_stat_activity
    where datname = current_database() and pid <> pg_backend_pid() and query ilike ${"%listen%sail_events%"}
    order by backend_start desc limit 1`;
  return rows[0]?.pid ?? null;
}

export function listenerConnectCount() {
  return connectCount;
}
