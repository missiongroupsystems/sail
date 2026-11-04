import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { inject } from "vitest";
import type { Role } from "@sail/shared";
import { setConfigForTests, loadConfig } from "../src/config.js";
import { setPoolForTests } from "../src/db/client.js";
import { resetGateForTests } from "../src/middleware/pipeline.js";
import { signDevBackOfficeToken, signSailToken, hashSecret } from "../src/auth/tokens.js";

export const TEST_SECRETS = {
  DEV_AUTH_SECRET: "dev-secret-for-tests-only-0123456789",
  STATION_TOKEN_SECRET: "station-secret-for-tests-0123456789",
  GUEST_TOKEN_SECRET: "guest-secret-for-tests-0123456789ab",
  RELAY_TOKEN_SECRET: "relay-secret-for-tests-0123456789ab",
  AGENT_TOKEN_SECRET: "agent-secret-for-tests-0123456789ab",
};

export type TestDb = { url: string; name: string; admin: Sql; sql: Sql; drop: () => Promise<void> };

/** Clone the migrated template into a fresh database and point the server at it. */
export async function freshDb(overrides: Partial<Record<string, string>> = {}): Promise<TestDb> {
  const adminUrl = inject("pgAdminUrl");
  const port = inject("pgPort");
  const name = `t_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name} template sail_template`);
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
  const sql = postgres(url, { max: 2, prepare: false, onnotice: () => {} });
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

export type SeededMerchant = {
  merchantId: string;
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

/** Insert a merchant with settings, a brand, two outlets and one staff member per role; return bearer tokens. */
export async function seedMerchant(sql: Sql, name = "Test Merchant"): Promise<SeededMerchant> {
  const merchantId = randomUUID();
  const brandId = randomUUID();
  const outletId = randomUUID();
  const outlet2Id = randomUUID();
  await sql`insert into merchants (id, name) values (${merchantId}, ${name})`;
  await sql`insert into merchant_settings (merchant_id) values (${merchantId})`;
  await sql`insert into brands (id, merchant_id, name) values (${brandId}, ${merchantId}, ${name + " Brand"})`;
  await sql`insert into outlets (id, merchant_id, name) values (${outletId}, ${merchantId}, ${name + " Outlet 1"})`;
  await sql`insert into outlets (id, merchant_id, name) values (${outlet2Id}, ${merchantId}, ${name + " Outlet 2"})`;
  const mk = async (role: Role, label: string, outletIds: string[] = [], pin = "123456") => {
    const id = randomUUID();
    const sub = `test:${id}`;
    const pinHash = hashSecret(pin);
    await sql`insert into staff (id, merchant_id, name, email, auth_subject, role, outlet_ids, pin_hash)
      values (${id}, ${merchantId}, ${label}, ${`${label.toLowerCase().replace(/\s+/g, ".")}@${merchantId.slice(0, 8)}.test`}, ${sub}, ${role}, ${outletIds}, ${pinHash})`;
    const token = await signDevBackOfficeToken(sub);
    return { id, token };
  };
  return {
    merchantId,
    brandId,
    outletId,
    outlet2Id,
    admin: await mk("admin", "Ada Admin"),
    manager: await mk("manager", "Mia Manager"),
    cashier: await mk("cashier", "Cal Cashier"),
    server: await mk("server", "Sam Server"),
    outlet2Cashier: await mk("cashier", "Olive Outlet Two", [outlet2Id]),
  };
}

export { signSailToken };

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
