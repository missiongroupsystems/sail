import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { inject } from "vitest";
import { presetSeedRules, REGION_PRESETS, type PricingRuleInput, type RegionPresetKey, type Role } from "@sail/shared";
import { applyPreset, type MerchantSettingsInput } from "../src/bootstrap.js";
import { setConfigForTests, loadConfig } from "../src/config.js";
import { PG_TYPES, setPoolForTests } from "../src/db/client.js";
import { resetGateForTests } from "../src/middleware/pipeline.js";
import { signSailToken, hashSecret, pinLookup } from "../src/auth/tokens.js";
import { localSubject, SESSION_TTL_SECONDS } from "../src/auth/identity.js";

export const TEST_SECRETS = {
  SESSION_TOKEN_SECRET: "session-secret-for-tests-0123456789",
  STATION_TOKEN_SECRET: "station-secret-for-tests-0123456789",
  GUEST_TOKEN_SECRET: "guest-secret-for-tests-0123456789ab",
  RELAY_TOKEN_SECRET: "relay-secret-for-tests-0123456789ab",
  AGENT_TOKEN_SECRET: "agent-secret-for-tests-0123456789ab",
};

export type TestDb = { url: string; name: string; admin: Sql; sql: Sql; drop: () => Promise<void> };

/** Clone the migrated template (or another template database) into a fresh database and point the server at it. */
export async function freshDb(overrides: Partial<Record<string, string>> = {}, template = "sail_template"): Promise<TestDb> {
  const adminUrl = inject("pgAdminUrl");
  const port = inject("pgPort");
  const name = `t_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name} template ${template}`);
  const url = `postgres://postgres@127.0.0.1:${port}/${name}`;
  setConfigForTests(
    loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: url,
      LISTEN_DATABASE_URL: url,
      ALLOW_POOLER_LISTEN: "1",
      DB_POOL_MAX: "8",
      TX_MAX: "4",
      QUEUE_MAX: "8",
      ...TEST_SECRETS,
      ...overrides,
    }),
  );
  setPoolForTests(null);
  resetGateForTests();
  const sql = postgres(url, { max: 2, prepare: false, onnotice: () => {}, types: PG_TYPES });
  return {
    url,
    name,
    admin,
    sql,
    drop: async () => {
      await sql.end({ timeout: 2 });
      const { closePool } = await import("../src/db/client.js");
      await closePool();
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.end({ timeout: 2 });
    },
  };
}

/** PINs used by seedMerchant: admin 111111, manager 222222, cashier 333333, server 444444, outlet-2 cashier 555555. */
export type SeededMerchant = {
  merchantId: string;
  /** Tax class ids by preset code (the sg preset has one: `standard`, GST 9%). */
  taxClassIds: Record<string, string>;
  brandId: string;
  outletId: string;
  outlet2Id: string;
  admin: { id: string; token: string };
  manager: { id: string; token: string };
  cashier: { id: string; token: string };
  server: { id: string; token: string };
  /** A cashier limited to outlet 2. */
  outlet2Cashier: { id: string; token: string };
};

/** The sg preset's seed rules for a seeded merchant, wired to its tax class. */
export function sgSeedRules(m: SeededMerchant): PricingRuleInput[] {
  return presetSeedRules(REGION_PRESETS.sg, m.taxClassIds);
}

/**
 * Insert a merchant with settings and tax classes from a region preset (sg,
 * in Singapore, unless the caller says otherwise; no seed rules or tenders),
 * a brand, two outlets and one staff member per role; return bearer tokens.
 */
export async function seedMerchant(sql: Sql, name = "Test Merchant", region: { preset: RegionPresetKey } & MerchantSettingsInput = { preset: "sg", timeZone: "Asia/Singapore" }): Promise<SeededMerchant> {
  const merchantId = randomUUID();
  const brandId = randomUUID();
  const outletId = randomUUID();
  const outlet2Id = randomUUID();
  await sql`insert into merchants (id, name) values (${merchantId}, ${name})`;
  const taxClassIds = await sql.begin((tx) => applyPreset(tx, merchantId, REGION_PRESETS[region.preset], region));
  await sql`insert into brands (id, merchant_id, name) values (${brandId}, ${merchantId}, ${name + " Brand"})`;
  await sql`insert into outlets (id, merchant_id, name) values (${outletId}, ${merchantId}, ${name + " Outlet 1"})`;
  await sql`insert into outlets (id, merchant_id, name) values (${outlet2Id}, ${merchantId}, ${name + " Outlet 2"})`;
  const mk = async (role: Role, label: string, outletIds: string[] = [], pin: string) => {
    const id = randomUUID();
    const sub = localSubject(id);
    const pinHash = hashSecret(pin);
    await sql`insert into staff (id, merchant_id, name, email, auth_subject, role, outlet_ids, pin_hash, pin_lookup)
      values (${id}, ${merchantId}, ${label}, ${`${label.toLowerCase().replace(/\s+/g, ".")}@${merchantId.slice(0, 8)}.test`}, ${sub}, ${role}, ${outletIds}, ${pinHash}, ${pinLookup(merchantId, pin)})`;
    const token = await backOfficeSession(sql, merchantId, id);
    return { id, token };
  };
  return {
    merchantId,
    taxClassIds: taxClassIds as Record<string, string>,
    brandId,
    outletId,
    outlet2Id,
    admin: await mk("admin", "Ada Admin", [], "111111"),
    manager: await mk("manager", "Mia Manager", [], "222222"),
    cashier: await mk("cashier", "Cal Cashier", [], "333333"),
    server: await mk("server", "Sam Server", [], "444444"),
    outlet2Cashier: await mk("cashier", "Olive Outlet Two", [outlet2Id], "555555"),
  };
}

export { signSailToken };

/** A back-office session for a seeded staff member, as the local identity provider issues one after sign-in. */
export async function backOfficeSession(sql: Sql, merchantId: string, staffId: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`insert into backoffice_sessions (merchant_id, staff_id, expires_at) values (${merchantId}, ${staffId}, now() + make_interval(secs => ${SESSION_TTL_SECONDS})) returning id`;
  return signSailToken({ typ: "session", merchant_id: merchantId, staff_id: staffId, session_id: row!.id }, SESSION_TTL_SECONDS);
}

/** Minimal typed fetch against the in-process app. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function api(app: { request: (...args: any[]) => Response | Promise<Response> }) {
  return {
    async call<T = unknown>(method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string>; idempotencyKey?: string | null } = {}): Promise<{ status: number; body: T; headers: Headers }> {
      const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
      if (opts.token) headers.authorization = `Bearer ${opts.token}`;
      if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && opts.idempotencyKey !== null) headers["idempotency-key"] = opts.idempotencyKey ?? randomUUID();
      const res = await app.request(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
      const text = await res.text();
      let body: unknown = text;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        /* keep text */
      }
      return { status: res.status, body: body as T, headers: res.headers };
    },
  };
}

/** Read SSE events from a streaming Response until `count` events arrive or the timeout passes. */
export async function readSse(res: Response, count: number, timeoutMs = 5000): Promise<{ event: string; data: unknown }[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const out: { event: string; data: unknown }[] = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (out.length < count && Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), Math.max(1, deadline - Date.now())))]);
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (block.startsWith(":")) continue;
      const lines = block.split("\n");
      const event = lines.find((l) => l.startsWith("event:"))?.slice(6).trim() ?? "message";
      const dataLine = lines.find((l) => l.startsWith("data:"))?.slice(5).trim() ?? "";
      let data: unknown = dataLine;
      try {
        data = JSON.parse(dataLine);
      } catch {
        /* raw */
      }
      out.push({ event, data });
    }
  }
  reader.cancel().catch(() => {});
  return out;
}

/**
 * Settle every order still open at an outlet (fire, pay each bill's balance by card, complete), so its business day can
 * close: a day with an open order cannot (pricing-semantics §10).
 */
export async function settleOpenOrders(sql: Sql, call: ReturnType<typeof api>["call"], token: string, outletId: string, cardTenderId: string) {
  for (const { id } of await sql<{ id: string }[]>`select id from orders where outlet_id = ${outletId} and status not in ('completed','cancelled')`) {
    await call("POST", `/v1/orders/${id}/fire`, { token, body: {} });
    for (const c of await sql<{ id: string; balance: number }[]>`select id, total - paid_total as balance from checks where order_id = ${id} and total > paid_total`) {
      const r = await call("POST", `/v1/checks/${c.id}/payments`, { token, body: { payment_id: randomUUID(), tender_type_id: cardTenderId, amount: c.balance } });
      if (r.status !== 200) throw new Error(`settle ${id}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    await call("POST", `/v1/orders/${id}/complete`, { token, body: {} });
  }
}
