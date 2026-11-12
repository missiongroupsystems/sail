// Money amounts are bigint everywhere, and the migrations that made them so carry a live database forward.
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, describe, expect, inject, it } from "vitest";
import { migrationsFolder, runMigrations } from "../src/db/migrate.js";
import { freshDb, type TestDb } from "./helpers.js";
import { bootWorld, orderHelpers } from "./world.js";

/** A column whose name says it holds an amount in minor units (or a sum of them). */
const MONEY_NAME = /(amount|total|price|cents|(^|_)tax($|_)|(^|_)fee($|_)|discount|tip|float|variance|rounding|tendered|(^|_)change|paid|refunded|override|entered_value|denomination|increment|threshold|(^|_)base($|_)|(^|_)net($|_)|(^|_)gross($|_)|(^|_)value($|_)|(^|_)sales|cash)/;
/** Integer columns whose names look like money but are not, with the reason. */
const NOT_MONEY: Record<string, string> = {
  "merchant_settings.busy_mode_threshold": "a count of orders in the kitchen queue",
};
const NARROW = ["int2", "int4", "_int2", "_int4"];

type Col = { table_name: string; column_name: string; udt_name: string; comment: string | null };
const catalogue = (sql: postgres.Sql) => sql<Col[]>`
  select c.table_name, c.column_name, c.udt_name, col_description(cl.oid, c.ordinal_position) as comment
  from information_schema.columns c join pg_class cl on cl.relname = c.table_name join pg_namespace n on n.oid = cl.relnamespace and n.nspname = c.table_schema
  where c.table_schema = 'public' order by 1, 2`;
const isMoney = (c: Col) => MONEY_NAME.test(c.column_name) || /minor units/i.test(c.comment ?? "");

describe("every money amount is bigint", () => {
  let db: TestDb;
  afterAll(async () => db?.drop());

  it("no table or view column named or described as a money amount is narrower than bigint, and no sum check counts in integer", async () => {
    db = await freshDb();
    const cols = await catalogue(db.sql);
    const narrow = cols.filter((c) => isMoney(c) && NARROW.includes(c.udt_name) && !(`${c.table_name}.${c.column_name}` in NOT_MONEY));
    expect(narrow.map((c) => `${c.table_name}.${c.column_name} (${c.udt_name})`)).toEqual([]);
    // The walk sees the money columns it is meant to guard, base tables and report views alike.
    const wide = new Set(cols.filter((c) => isMoney(c) && c.udt_name === "int8").map((c) => `${c.table_name}.${c.column_name}`));
    for (const c of ["orders.total", "payments.amount", "refunds.total", "shifts.expected_cash_cents", "proposals.order_total", "payment_intents.pinned_check_total", "report_orders.net_sales", "report_voids.value"]) expect(wide, c).toContain(c);
    // A proposal's before and after figures are JSON numbers, which have no width to overflow.
    expect(cols.find((c) => c.table_name === "proposals" && c.column_name === "effect")?.udt_name).toBe("jsonb");
    // The deferred sum checks add amounts up in variables: none may be an integer.
    const fns = await db.sql<{ name: string; def: string }[]>`select p.proname as name, pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'sail' and p.prolang = (select oid from pg_language where lanname = 'plpgsql')`;
    expect(fns.length).toBeGreaterThan(0);
    expect(fns.filter((f) => /\b(integer|int4|int)\b/i.test(f.def)).map((f) => f.name)).toEqual([]);
  });
});

describe("a database at the last migration before the bigint change migrates forward with its data", () => {
  const admin = postgres(inject("pgAdminUrl"), { max: 1, onnotice: () => {} });
  const template = `fw_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  let db: TestDb | null = null;
  afterAll(async () => {
    await db?.drop();
    await admin.unsafe(`drop database if exists ${template} with (force)`);
    await admin.end({ timeout: 2 });
  });

  it("keeps every amount, report row and sum check, and takes amounts above 2^31 afterwards", async () => {
    // The journal up to the migration that drops the report views: the schema every deployment had before it.
    const folder = migrationsFolder();
    const journal = JSON.parse(readFileSync(join(folder, "meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
    const first = journal.entries.findIndex((e) => e.tag.endsWith("_money_bigint_drop_views"));
    expect(first).toBeGreaterThan(0);
    const last = journal.entries.findIndex((e) => e.tag.endsWith("_money_bigint_views"));
    const later = journal.entries.slice(last + 1).flatMap((e) =>
      readFileSync(join(folder, `${e.tag}.sql`), "utf8").split("--> statement-breakpoint").map((x) => x.trim()).filter(Boolean).map((stmt) => {
        const m = /^ALTER TABLE "(\w+)" ADD COLUMN "(\w+)" ([^;]+);?$/.exec(stmt);
        if (!m) throw new Error(`${e.tag}: this test only knows how to undo ADD COLUMN, not: ${stmt}`);
        return { table: m[1]!, column: m[2]!, def: m[3]! };
      }),
    );
    const before = mkdtempSync(join(tmpdir(), "sail-mig-"));
    try {
      mkdirSync(join(before, "meta"));
      writeFileSync(join(before, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, first) }));
      for (const e of journal.entries.slice(0, first)) copyFileSync(join(folder, `${e.tag}.sql`), join(before, `${e.tag}.sql`));
      await admin.unsafe(`create database ${template}`);
      const t = postgres(`postgres://postgres@127.0.0.1:${inject("pgPort")}/${template}`, { max: 1, onnotice: () => {} });
      await migrate(drizzle(t), { migrationsFolder: before });
      // The data is made by today's code, which reads the columns later migrations add: they are added for the seed and
      // dropped again before migrating, so the database migrated is the old schema with its rows.
      for (const c of later) await t.unsafe(`alter table "${c.table}" add column "${c.column}" ${c.def}`);
      await t.end({ timeout: 2 });
    } finally {
      rmSync(before, { recursive: true, force: true });
    }

    const world = await bootWorld(template);
    db = world.db;
    const { call, w } = world;
    expect((await catalogue(db.sql)).find((c) => c.table_name === "orders" && c.column_name === "total")?.udt_name).toBe("int4");

    // A day's trading: a shift, cash and card sales, a part refund, a voided line, and an agent's proposal with its money effect.
    const h = orderHelpers(call, w);
    expect((await call("POST", "/v1/shifts", { token: w.pins.cashier, body: { outlet_id: w.m.outletId, float_cents: 10000 } })).status).toBe(201);
    const cash = await h.orderWith(w.pins.cashier, [{ product_id: w.ids.laksa }, { product_id: w.ids.kopi, quantity: 2 }]);
    await h.fire(w.pins.cashier, cash.id);
    expect((await h.pay(w.pins.cashier, cash.checks[0]!.id, { tender_type_id: w.ids.cash, amount: cash.balance, tendered: cash.balance + 1000 })).status).toBe(200);
    const card = await h.paidOrder(w.pins.cashier, [{ product_id: w.ids.wine }]);
    expect((await call("POST", `/v1/checks/${card.checks[0]!.id}/refunds`, { token: w.pins.manager, body: { refund_id: randomUUID(), request: { kind: "amount", amount: 500 }, reason: "returned", print: false } })).status).toBe(201);
    const open = await h.orderWith(w.pins.server, [{ product_id: w.ids.laksa }, { product_id: w.ids.kopi }]);
    expect((await call("POST", `/v1/orders/${open.id}/lines/${open.lines[1]!.id}/void`, { token: w.pins.manager, body: { reason_text: "changed mind" } })).status).toBe(200);
    const ident = await call<{ data: { credential: string } }>("POST", "/v1/agent-identities", { token: w.m.admin.token, body: { name: "fw-agent", role: "server", toolsets: ["pos.order"], risk_ceiling: "T1" } });
    const agent = (await call<{ data: { agent_token: string } }>("POST", "/v1/agent-sessions", { body: { credential: ident.body.data.credential }, idempotencyKey: null })).body.data.agent_token;
    const proposed = await call("POST", `/v1/orders/${open.id}/lines/${open.lines[0]!.id}/void`, { token: agent, body: { reason_text: "not wanted" } });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(202);

    // Every row of every table and report view, as text: an int4 and an int8 holding the same amount print the same.
    const relations = await db.sql<{ name: string }[]>`select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'v') order by 1`;
    const snapshot = async () => {
      const out: Record<string, string | null> = {};
      for (const { name } of relations) {
        const drop = later.filter((c) => c.table === name).map((c) => `'${c.column}'`);
        const row = drop.length ? `(to_jsonb(t) - array[${drop.join(", ")}])::text` : "to_jsonb(t)::text";
        out[name] = (await db!.sql.unsafe<{ h: string | null }[]>(`select md5(string_agg(${row}, '|' order by ${row})) as h from "${name}" t`))[0]!.h;
      }
      return out;
    };
    const was = await snapshot();
    expect(was.payments).not.toBeNull();
    expect(was.proposals).not.toBeNull();

    const { closePool } = await import("../src/db/client.js");
    await closePool();
    for (const c of later) await db.sql.unsafe(`alter table "${c.table}" drop column "${c.column}"`);
    const r = await runMigrations(db.url);
    expect(r.applied).toBe(journal.entries.length - first);
    expect(await snapshot()).toEqual(was);
    const cols = await catalogue(db.sql);
    expect(cols.filter((c) => isMoney(c) && NARROW.includes(c.udt_name) && !(`${c.table_name}.${c.column_name}` in NOT_MONEY))).toEqual([]);
    const [trigger] = await db.sql<{ n: number }[]>`select count(*)::int as n from pg_trigger where tgname = 'orders_total_sum'`;
    expect(trigger!.n).toBe(1);
    // The recreated order-total check still refuses an order whose total disagrees with its lines.
    await expect(db.sql`update orders set total = total + 1 where id = ${cash.id}`).rejects.toThrow();

    // After the migration an amount above 2^31 is taken, paid and reported exactly.
    const big = randomUUID();
    expect((await call("POST", "/v1/products", { token: w.m.admin.token, body: { id: big, name: "Banquet", price: 3_000_000_000 } })).status).toBe(201);
    expect((await call("PATCH", `/v1/menus/${w.ids.menu}`, { token: w.m.admin.token, body: { sections: [{ name: "All", items: [{ product_id: w.ids.laksa }, { product_id: w.ids.kopi }, { product_id: w.ids.wine }, { product_id: w.ids.openItem }, { product_id: big }] }] } })).status).toBeLessThan(300);
    const paid = await h.paidOrder(w.pins.cashier, [{ product_id: big }]);
    expect(paid.totals.total).toBeGreaterThan(2 ** 31);
    const [stored] = await db.sql<{ total: number }[]>`select total from orders where id = ${paid.id}`;
    expect(stored!.total).toBe(paid.totals.total);
  });
});
