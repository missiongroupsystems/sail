import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import "../src/modules.js";
import { buildApp } from "../src/app.js";
import { poolRetirementsForTests, setTxStallForTests, txDeadlineMs } from "../src/db/client.js";
import { admissionGate } from "../src/middleware/pipeline.js";
import { api, freshDb, seedMerchant, type SeededMerchant, type TestDb } from "./helpers.js";

/**
 * Review 5, V7: a request's transaction has a deadline on the client side of the database. A COMMIT whose reply is lost
 * (here: the transaction held just before its commit, or its reply held just after) used to keep its admission slot and
 * pool connection until the HTTP client gave up. Now it answers 503 `overloaded` at lock + statement timeout + margin,
 * frees the slot, ends the session if it is still in that transaction, and a retry with the same key gives the one
 * answer: replayed when the commit landed, done afresh when it did not.
 */
let db: TestDb;
let m: SeededMerchant;
let call: ReturnType<typeof api>["call"];

beforeAll(async () => {
  db = await freshDb({ DB_LOCK_TIMEOUT_MS: "400", DB_STATEMENT_TIMEOUT_MS: "1500" });
  m = await seedMerchant(db.sql, "Deadline");
  call = api(buildApp()).call;
});
afterEach(() => setTxStallForTests(null));
afterAll(async () => db.drop());

const product = (id: string, key: string) => call<{ code?: string; message?: string; remedy?: string }>("POST", "/v1/products", { token: m.admin.token, body: { id, name: `Kopi ${id.slice(0, 6)}`, price: 180 }, idempotencyKey: key });
const count = async (id: string) => (await db.sql<{ n: number }[]>`select count(*)::int as n from products where id = ${id}`)[0]!.n;
const markedSessions = async () => (await db.sql<{ n: number }[]>`select count(*)::int as n from pg_stat_activity where datname = current_database() and application_name like 'sail-tx-%' and state <> 'idle'`)[0]!.n;

describe("V7: a request transaction past its deadline answers 503 and leaves nothing half done", () => {
  const ms = () => txDeadlineMs();

  it("held before its commit (its code still running): 503 at the deadline, the slot freed, its next step refused and the transaction rolled back; the same key then does it once", async () => {
    expect(ms()).toBe(400 + 1500 + 5000);
    const id = randomUUID();
    const key = randomUUID();
    setTxStallForTests({ at: "before_commit", ms: ms() + 3_000 });
    const t0 = performance.now();
    const r = await product(id, key);
    const took = performance.now() - t0;
    setTxStallForTests(null);
    expect(r.status, JSON.stringify(r.body)).toBe(503);
    expect(r.body.code).toBe("overloaded");
    expect(r.body.remedy).toMatch(/Try again/);
    expect(took).toBeGreaterThanOrEqual(ms() - 50);
    expect(took).toBeLessThan(ms() + 2_500);
    expect(admissionGate().inFlight).toBe(0);
    // Its code is still running (held): the transaction stays open until that code's next step, which is refused, and
    // it rolls back on its own connection. Meanwhile other requests are served.
    expect((await call("GET", "/v1/products", { token: m.admin.token })).status).toBe(200);
    const until = performance.now() + 6_000;
    while ((await markedSessions()) > 0 && performance.now() < until) await new Promise((r) => setTimeout(r, 100));
    expect(await markedSessions()).toBe(0);
    expect(await count(id)).toBe(0);
    // The pool hands out working connections afterwards.
    for (let i = 0; i < 4; i++) expect((await call("GET", "/v1/products", { token: m.admin.token })).status).toBe(200);
    const retry = await product(id, key);
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    expect(retry.headers.get("idempotent-replayed")).not.toBe("true");
    expect(await count(id)).toBe(1);
  });

  it("its reply held after the commit: 503 at the deadline; the write and its idempotency row landed, so the same key replays the answer", async () => {
    const id = randomUUID();
    const key = randomUUID();
    setTxStallForTests({ at: "after_commit", ms: ms() + 3_000 });
    const r = await product(id, key);
    setTxStallForTests(null);
    expect(r.status, JSON.stringify(r.body)).toBe(503);
    expect(admissionGate().inFlight).toBe(0);
    expect(await count(id)).toBe(1);
    const retry = await product(id, key);
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
    expect(await count(id)).toBe(1);
    // A session another request is using is never ended: the held one had committed, so its marker was reset.
    expect((await call("GET", "/v1/products", { token: m.admin.token })).status).toBe(200);
  });

  it("its COMMIT sent but unanswered: 503 at the deadline, the session still in that transaction is ended, nothing kept; the same key then does it once", async () => {
    // A deferred trigger keeps the COMMIT of a "Slow" product waiting well past the deadline.
    await db.sql.unsafe(`
      create or replace function test_slow_commit() returns trigger language plpgsql as $$ begin if NEW.name like 'Slow %' then perform pg_sleep(30); end if; return null; end $$;
      create constraint trigger test_slow_commit after insert on products deferrable initially deferred for each row execute function test_slow_commit();`);
    try {
      const id = randomUUID();
      const key = randomUUID();
      setTxStallForTests({ at: "slow_commit", ms: 0 });
      const t0 = performance.now();
      const r = await call<{ code?: string }>("POST", "/v1/products", { token: m.admin.token, body: { id, name: `Slow ${id.slice(0, 6)}`, price: 180 }, idempotencyKey: key });
      setTxStallForTests(null);
      expect(r.status, JSON.stringify(r.body)).toBe(503);
      expect(performance.now() - t0).toBeLessThan(ms() + 2_500);
      expect(admissionGate().inFlight).toBe(0);
      // Ended at once, not when the trigger would have finished.
      const until = performance.now() + 2_000;
      while ((await markedSessions()) > 0 && performance.now() < until) await new Promise((res) => setTimeout(res, 50));
      expect(await markedSessions()).toBe(0);
      expect(await count(id)).toBe(0);
      for (let i = 0; i < 6; i++) expect((await call("GET", "/v1/products", { token: m.admin.token })).status).toBe(200);
      await db.sql.unsafe(`drop trigger test_slow_commit on products`);
      const retry = await call("POST", "/v1/products", { token: m.admin.token, body: { id, name: `Slow ${id.slice(0, 6)}`, price: 180 }, idempotencyKey: key });
      expect(retry.status, JSON.stringify(retry.body)).toBe(201);
      expect(await count(id)).toBe(1);
    } finally {
      await db.sql.unsafe(`drop trigger if exists test_slow_commit on products; drop function if exists test_slow_commit()`);
    }
  });

  it("its commit landed and only the reply is lost (no session left in that transaction): the request pool is retired, so the stuck connection is closed rather than kept", async () => {
    await db.sql.unsafe(`
      create or replace function test_slow_commit() returns trigger language plpgsql as $$ begin if NEW.name like 'Lost %' then perform pg_sleep(9); end if; return null; end $$;
      create constraint trigger test_slow_commit after insert on products deferrable initially deferred for each row execute function test_slow_commit();`);
    try {
      const before = poolRetirementsForTests();
      const id = randomUUID();
      setTxStallForTests({ at: "lost_reply", ms: 0 });
      const r = await call("POST", "/v1/products", { token: m.admin.token, body: { id, name: `Lost ${id.slice(0, 6)}`, price: 180 }, idempotencyKey: randomUUID() });
      setTxStallForTests(null);
      expect(r.status, JSON.stringify(r.body)).toBe(503);
      expect(admissionGate().inFlight).toBe(0);
      expect(poolRetirementsForTests()).toBe(before + 1);
      // A new pool serves the next requests at once.
      for (let i = 0; i < 4; i++) expect((await call("GET", "/v1/products", { token: m.admin.token })).status).toBe(200);
    } finally {
      await new Promise((res) => setTimeout(res, 3_000));
      await db.sql.unsafe(`drop trigger if exists test_slow_commit on products; drop function if exists test_slow_commit()`);
    }
  });

  it("an ordinary request is not affected", async () => {
    const id = randomUUID();
    expect((await product(id, randomUUID())).status).toBe(201);
    expect(admissionGate().inFlight).toBe(0);
  });
});
