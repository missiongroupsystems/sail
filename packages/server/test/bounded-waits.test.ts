import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/modules.js";
import { buildApp } from "../src/app.js";
import { withTransaction } from "../src/db/client.js";
import { databaseSnapshot } from "../src/middleware/slow-requests.js";
import type { TransactionSql } from "postgres";
import { api, freshDb, seedMerchant, type SeededMerchant, type TestDb } from "./helpers.js";

/**
 * No request waits without end on a lock. The availability-rule delete appends a merchant-level event, which takes the
 * merchant's sequence row lock; with that lock held elsewhere the delete used to wait for as long as the holder kept it,
 * and the back office got no answer (the E-N3 end-to-end hang). Now it is cut off after DB_LOCK_TIMEOUT_MS with a 503,
 * nothing is changed, and the same request succeeds once the lock is free.
 */
let db: TestDb;
let m: SeededMerchant;
let call: ReturnType<typeof api>["call"];
const LOCK_MS = 400;

beforeAll(async () => {
  db = await freshDb({ DB_LOCK_TIMEOUT_MS: String(LOCK_MS), DB_STATEMENT_TIMEOUT_MS: "1500" });
  m = await seedMerchant(db.sql, "Waits");
  call = api(buildApp()).call;
});
afterAll(async () => db.drop());

/** Hold `lockSql` in a transaction on a connection of the test's own until the returned release is called. */
async function hold(lockSql: (t: TransactionSql) => Promise<unknown>) {
  let release!: () => void;
  let locked!: () => void;
  const isLocked = new Promise<void>((r) => (locked = r));
  const done = db.sql.begin(async (t) => {
    await lockSql(t);
    locked();
    await new Promise<void>((r) => (release = r));
  });
  await isLocked;
  return async () => {
    release();
    await done;
  };
}

/** Fails the test, rather than hanging it, when `p` takes longer than `ms`. */
function within<T>(ms: number, p: Promise<T>): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms))]);
}

async function newRule() {
  const product = randomUUID();
  expect((await call("POST", "/v1/products", { token: m.admin.token, body: { id: product, name: `Kopi ${product.slice(0, 4)}`, price: 180 } })).status).toBe(201);
  const r = await call<{ data: { id: string } }>("POST", "/v1/availability-rules", { token: m.admin.token, body: { target_kind: "product", target_id: product, start_time: "22:00", end_time: "02:00" } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data.id;
}

describe("bounded waits", () => {
  it("an availability-rule delete waiting on the merchant's sequence lock answers 503 and changes nothing; the same request then succeeds", async () => {
    const id = await newRule();
    const release = await hold((t) => t`select 1 from merchant_sequences where merchant_id = ${m.merchantId} for update`);
    const key = randomUUID();
    const started = Date.now();
    let blocked;
    try {
      blocked = await within(5_000, call<{ code: string }>("DELETE", `/v1/availability-rules/${id}`, { token: m.admin.token, body: {}, idempotencyKey: key }));
    } finally {
      await release();
    }
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(503);
    expect(blocked.body.code).toBe("overloaded");
    expect(Date.now() - started).toBeGreaterThanOrEqual(LOCK_MS - 50);
    const list = await call<{ data: { id: string }[] }>("GET", "/v1/availability-rules", { token: m.admin.token });
    expect(list.body.data.map((r) => r.id)).toContain(id);
    const retried = await within(5_000, call("DELETE", `/v1/availability-rules/${id}`, { token: m.admin.token, body: {}, idempotencyKey: key }));
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
  });

  it("a write waiting on a row lock held outside the API answers 503, for any operation", async () => {
    const id = await newRule();
    const release = await hold((t) => t`select 1 from availability_rules where id = ${id} for update`);
    try {
      const patched = await within(5_000, call<{ code: string }>("PATCH", `/v1/availability-rules/${id}`, { token: m.admin.token, body: { start_time: "21:00" } }));
      expect(patched.status, JSON.stringify(patched.body)).toBe(503);
    } finally {
      await release();
    }
  });

  it("a statement running past the statement timeout is cancelled, in the worker's transactions too", async () => {
    await expect(within(5_000, withTransaction((t) => t.sql`select pg_sleep(3)`))).rejects.toMatchObject({ code: "57014" });
    const release = await hold((t) => t`select 1 from merchant_sequences where merchant_id = ${m.merchantId} for update`);
    try {
      await expect(within(5_000, withTransaction((t) => t.sql`select 1 from merchant_sequences where merchant_id = ${m.merchantId} for update`))).rejects.toMatchObject({ code: "55P03" });
    } finally {
      await release();
    }
  });

  it("the slow-request snapshot names the session that blocks a waiting one", async () => {
    const release = await hold((t) => t`select 1 from merchant_sequences where merchant_id = ${m.merchantId} for update`);
    try {
      const waiter = withTransaction((t) => t.sql`select 1 from merchant_sequences where merchant_id = ${m.merchantId} for update`).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 150));
      const snap = await databaseSnapshot(db.sql);
      const blocked = snap.sessions.find((s) => (s.blocked_by as number[]).length > 0);
      expect(blocked, JSON.stringify(snap)).toBeDefined();
      expect(snap.waiting_locks.length).toBeGreaterThan(0);
      await waiter;
    } finally {
      await release();
    }
  });
});
