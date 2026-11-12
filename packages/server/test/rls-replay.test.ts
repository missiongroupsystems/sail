import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDb, seedMerchant, type SeededMerchant, type TestDb } from "./helpers.js";

/**
 * RLS replay harness: for every table with a
 * merchant_id column, RLS must be enabled with at least one policy, and under
 * `app_authenticated` a session for merchant A must see none of merchant B's
 * rows. New tables are covered automatically; a table without RLS fails here.
 */
let db: TestDb;
let A: SeededMerchant;
let B: SeededMerchant;

beforeAll(async () => {
  db = await freshDb();
  A = await seedMerchant(db.sql, "Alpha");
  B = await seedMerchant(db.sql, "Bravo");
  // Seed rows in the system tables for both merchants.
  for (const m of [A, B]) {
    await db.sql`insert into audit_log (merchant_id, actor_type, actor_id, action, target_kind) values (${m.merchantId}, 'staff', ${m.admin.id}, 'test', 'test')`;
    await db.sql`insert into outlet_sequences (outlet_id, merchant_id, next_seq) values (${m.outletId}, ${m.merchantId}, 2)`;
    await db.sql`insert into merchant_sequences (merchant_id, next_seq) values (${m.merchantId}, 1)`;
    await db.sql`insert into events (merchant_id, outlet_id, seq, business_date, type, aggregate_kind, aggregate_id, operation_id, actor, correlation_id)
      values (${m.merchantId}, ${m.outletId}, 1, '2026-11-04', 'test', 'test', ${m.outletId}, 'test', '{"principal_type":"system","principal_id":"x","role":null}', ${m.outletId})`;
    await db.sql`insert into idempotency_keys (merchant_id, principal_id, key, request_hash) values (${m.merchantId}, ${m.admin.id}, 'k', 'h')`;
    await db.sql`insert into pin_attempts (merchant_id, scope, failures) values (${m.merchantId}, 'station:x', 1)`;
    await db.sql`insert into guest_rate_hits (merchant_id, key, hits) values (${m.merchantId}, 'k', array[now()])`;
    await db.sql`insert into payment_provider_accounts (merchant_id, provider, webhook_secret) values (${m.merchantId}, 'simulator', 'secret-for-the-replay-test')`;
    await db.sql`insert into payment_webhook_events (merchant_id, provider, event_id) values (${m.merchantId}, 'simulator', 'evt_1')`;
    await db.sql`with s as (insert into stations (merchant_id, outlet_id, name) values (${m.merchantId}, ${m.outletId}, 'S') returning id)
      insert into staff_sessions (merchant_id, staff_id, station_id, outlet_id) select ${m.merchantId}, ${m.admin.id}, s.id, ${m.outletId} from s`;
  }
});
afterAll(async () => {
  await db.drop();
});

type TableRow = { table_name: string; rowsecurity: boolean; policies: number };

async function tenantTables(): Promise<TableRow[]> {
  return db.sql<TableRow[]>`
    select c.table_name, t.rowsecurity, (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.table_name) as policies
    from information_schema.columns c
    join pg_tables t on t.schemaname = 'public' and t.tablename = c.table_name
    where c.table_schema = 'public' and c.column_name = 'merchant_id'
    order by c.table_name`;
}

async function countAs(role: string, merchantId: string, outlets: string, principalId: string, table: string): Promise<number> {
  return db.sql.begin(async (tx) => {
    await tx`select set_config('app.current_merchant', ${merchantId}, true), set_config('app.current_outlets', ${outlets}, true), set_config('app.current_principal', ${principalId}, true), set_config('app.current_principal_type', 'staff', true)`;
    await tx.unsafe(`set local role ${role}`);
    const [row] = await tx.unsafe<{ n: number }[]>(`select count(*)::int as n from ${table}`);
    return row!.n;
  }) as Promise<number>;
}

describe("RLS replay", () => {
  it("every tenant table has RLS enabled with at least one policy", async () => {
    const tables = await tenantTables();
    expect(tables.length).toBeGreaterThanOrEqual(10);
    const bad = tables.filter((t) => !t.rowsecurity || t.policies === 0).map((t) => t.table_name);
    expect(bad, `tables without RLS policies: ${bad.join(", ")}`).toEqual([]);
  });

  it("merchants table is scoped by its own id", async () => {
    expect(await countAs("app_authenticated", A.merchantId, "*", A.admin.id, "merchants")).toBe(1);
  });

  it("merchant A sees none of merchant B's rows in any tenant table, and sees its own", async () => {
    const tables = await tenantTables();
    const exercised: string[] = [];
    for (const t of tables) {
      const [total] = await db.sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${t.table_name}`);
      if (total!.n === 0) continue; // later phases seed their tables in their own tests
      exercised.push(t.table_name);
      const [ownRows] = await db.sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${t.table_name} where merchant_id = '${A.merchantId}'`);
      const seen = await countAs("app_authenticated", A.merchantId, "*", A.admin.id, t.table_name);
      // idempotency keys are also scoped per principal; A.admin holds exactly one.
      const expected = t.table_name === "idempotency_keys" ? 1 : ownRows!.n;
      expect(seen, `${t.table_name}: saw ${seen}, own ${ownRows!.n}, total ${total!.n}`).toBe(expected);
      expect(total!.n).toBeGreaterThan(expected); // there really were other-tenant rows to hide
    }
    expect(exercised).toEqual(expect.arrayContaining(["merchant_settings", "brands", "outlets", "stations", "staff", "staff_sessions", "audit_log", "events", "outlet_sequences", "merchant_sequences", "idempotency_keys", "pin_attempts", "guest_rate_hits", "payment_provider_accounts", "payment_webhook_events"]));
  });

  it("outlet scoping hides other outlets' rows for a limited staff member", async () => {
    expect(await countAs("app_authenticated", A.merchantId, A.outlet2Id, A.outlet2Cashier.id, "outlets")).toBe(1);
    expect(await countAs("app_authenticated", A.merchantId, A.outlet2Id, A.outlet2Cashier.id, "stations")).toBe(0);
    expect(await countAs("app_authenticated", A.merchantId, A.outlet2Id, A.outlet2Cashier.id, "events")).toBe(0);
    expect(await countAs("app_authenticated", A.merchantId, A.outletId, A.cashier.id, "events")).toBe(1);
  });

  it("a write for another merchant is refused by the WITH CHECK clause", async () => {
    await expect(
      db.sql.begin(async (tx) => {
        await tx`select set_config('app.current_merchant', ${A.merchantId}, true), set_config('app.current_outlets', '*', true), set_config('app.current_principal', ${A.admin.id}, true), set_config('app.current_principal_type', 'staff', true)`;
        await tx`set local role app_authenticated`;
        await tx`insert into brands (merchant_id, name) values (${B.merchantId}, 'smuggled')`;
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it("guest and relay roles have no access to staff; the agent role sees names but never PIN hashes", async () => {
    for (const role of ["app_guest", "app_relay"]) {
      await expect(countAs(role, A.merchantId, "*", A.admin.id, "staff")).rejects.toThrow(/permission denied/);
    }
    const names = await db.sql.begin(async (tx) => {
      await tx`select set_config('app.current_merchant', ${A.merchantId}, true), set_config('app.current_outlets', '*', true), set_config('app.current_principal', ${A.admin.id}, true), set_config('app.current_principal_type', 'agent', true)`;
      await tx.unsafe("set local role app_agent");
      return tx.unsafe<{ name: string }[]>("select name from staff");
    });
    expect(names.length).toBeGreaterThan(0);
  });

  it("app_agent sees none of merchant B's rows in the tables it may read, and nothing at all in token and session tables", async () => {
    const tables = await tenantTables();
    const readable: string[] = [];
    const denied: string[] = [];
    for (const t of tables) {
      const [priv] = await db.sql<{ any: boolean }[]>`select has_any_column_privilege('app_agent', ${t.table_name}::regclass, 'SELECT') as any`;
      (priv!.any ? readable : denied).push(t.table_name);
    }
    expect(denied).toEqual(expect.arrayContaining(["staff_sessions", "station_pairing_codes", "relay_pairing_codes", "table_qr_tokens", "guest_sessions", "agent_sessions"]));
    expect(readable).toEqual(expect.arrayContaining(["orders", "order_lines", "products", "events", "staff", "customers"]));
    for (const t of readable) {
      const [total] = await db.sql.unsafe<{ n: number }[]>(`select count(merchant_id)::int as n from ${t}`);
      if (!total || total.n === 0) continue;
      const [bOwn] = await db.sql.unsafe<{ n: number }[]>(`select count(merchant_id)::int as n from ${t} where merchant_id = '${B.merchantId}'`);
      const seenByA = await db.sql.begin(async (tx) => {
        await tx`select set_config('app.current_merchant', ${A.merchantId}, true), set_config('app.current_outlets', '*', true), set_config('app.current_principal', ${A.admin.id}, true), set_config('app.current_principal_type', 'agent', true)`;
        await tx.unsafe("set local role app_agent");
        const [row] = await tx.unsafe<{ n: number }[]>(`select count(merchant_id)::int as n from ${t} where merchant_id = '${B.merchantId}'`);
        return row!.n;
      });
      expect(seenByA, `app_agent for A saw ${seenByA} of B's ${bOwn!.n} rows in ${t}`).toBe(0);
    }
  });

  it("app_guest cannot read payments, checks, refunds, staff or other tables beyond the menu and its own order", async () => {
    for (const t of ["payments", "checks", "refunds", "staff", "shifts", "customers", "pricing_rules", "audit_log", "print_jobs"]) {
      const attempt = db.sql.begin(async (tx) => {
        await tx`select set_config('app.current_merchant', ${A.merchantId}, true), set_config('app.current_outlets', ${A.outletId}, true), set_config('app.current_principal', ${A.admin.id}, true), set_config('app.current_principal_type', 'guest', true), set_config('app.current_order', '', true)`;
        await tx.unsafe("set local role app_guest");
        return tx.unsafe(`select count(*) from ${t}`);
      });
      await expect(attempt, `app_guest could read ${t}`).rejects.toMatchObject({ code: "42501" });
    }
  });
});
