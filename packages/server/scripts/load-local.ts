/**
 * Local load test (roadmap v0.9 hardening). Runs the API in-process against an
 * embedded Postgres, then drives N concurrent stations through open → add lines
 * → fire → pay while S SSE streams are connected, and prints p50/p95/p99 latency
 * per operation plus the admission-gate rejections. Local numbers size TX_MAX
 * and QUEUE_MAX; the Singapore p95 target (scope doc 9) needs staging.
 *
 *   pnpm --filter @sail/server load:local            # 20 stations × 10 orders, 50 streams
 *   STATIONS=40 ORDERS=20 STREAMS=200 TX_MAX=16 pnpm --filter @sail/server load:local
 */
import { randomUUID } from "node:crypto";
import { startEmbeddedPostgres } from "../test/pg.js";
import { runMigrations } from "../src/db/migrate.js";
import { bootstrapMerchant } from "../src/bootstrap.js";

const STATIONS = Number(process.env.STATIONS ?? 20);
const ORDERS = Number(process.env.ORDERS ?? 10);
const STREAMS = Number(process.env.STREAMS ?? 50);

const pg = await startEmbeddedPostgres();
const url = `postgres://postgres@127.0.0.1:${pg.port}/sail_load`;
const { default: postgres } = await import("postgres");
const admin = postgres(pg.adminUrl, { max: 1, onnotice: () => {} });
await admin`create database sail_load`;
await admin.end();
await runMigrations(url, { log: () => {} });
process.env.NODE_ENV = "development";
process.env.LOG_LEVEL ??= "fatal";
process.env.DATABASE_URL = url;
process.env.LISTEN_DATABASE_URL = url;
process.env.ALLOW_POOLER_LISTEN = "1";
process.env.DEV_AUTH_SECRET ??= "local-dev-secret-change-me-0123456789";
process.env.STATION_TOKEN_SECRET ??= "local-station-secret-0123456789abcdef";
process.env.GUEST_TOKEN_SECRET ??= "local-guest-secret-0123456789abcdef";
process.env.RELAY_TOKEN_SECRET ??= "local-relay-secret-0123456789abcdef";
process.env.AGENT_TOKEN_SECRET ??= "local-agent-secret-0123456789abcdef";
process.env.TX_MAX ??= "16";
process.env.QUEUE_MAX ??= "200";
process.env.DB_POOL_MAX ??= "20";

const boot = await bootstrapMerchant(url, { merchantName: "Load", brandName: "Load Brand", outletName: "Load Outlet", admin: { name: "Ada", email: "admin@sail.local", pin: "123456" }, taxMode: "exclusive", cashRoundingIncrement: 5 });
await import("../src/modules.js");
const { buildApp } = await import("../src/app.js");
const { startListener, stopListener } = await import("../src/sse/listener.js");
const { closePool } = await import("../src/db/client.js");
const { seedRulesForMerchant } = await import("../src/services/pricing-rules.js");
const { withTransaction } = await import("../src/db/client.js");
const app = buildApp();
await startListener();
await withTransaction(() => seedRulesForMerchant(boot.merchantId));

const lat: Record<string, number[]> = {};
let rejected = 0;
async function call<T = unknown>(name: string, method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: T }> {
  const t0 = performance.now();
  const res = await app.request(path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": randomUUID() }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  (lat[name] ??= []).push(performance.now() - t0);
  if (res.status === 503) rejected++;
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* text */
  }
  if (res.status >= 400 && res.status !== 503) throw new Error(`${name} ${res.status}: ${text.slice(0, 200)}`);
  return { status: res.status, body: parsed as T };
}

const adminTok = (await call<{ token: string }>("dev-token", "POST", "/v1/auth/dev-token", "", { email: "admin@sail.local" })).body.token;
const products = Array.from({ length: 30 }, () => randomUUID());
for (const [i, id] of products.entries()) await call("setup", "POST", "/v1/products", adminTok, { id, name: `Item ${i}`, price: 500 + i * 35, tags: ["kitchen"] });
const menu = randomUUID();
await call("setup", "POST", "/v1/menus", adminTok, { id: menu, brand_id: boot.brandId, name: "Load", sections: [{ name: "All", items: products.map((p) => ({ product_id: p })) }] });
await call("setup", "POST", "/v1/channel-links", adminTok, { id: randomUUID(), channel: "pos", outlet_id: boot.outletId, brand_id: boot.brandId, menu_id: menu });
const cash = randomUUID();
await call("setup", "POST", "/v1/tender-types", adminTok, { id: cash, name: "Cash", is_cash: true });
await call("setup", "POST", "/v1/printers", adminTok, { id: randomUUID(), outlet_id: boot.outletId, name: "Kitchen", ip: "10.0.0.1", is_default_kitchen: true });
const stationTokens: string[] = [];
for (let s = 0; s < STATIONS; s++) {
  const st = randomUUID();
  await call("setup", "POST", "/v1/stations", adminTok, { id: st, outlet_id: boot.outletId, brand_id: boot.brandId, name: `S${s}` });
  const code = await call<{ data: { code: string } }>("setup", "POST", `/v1/stations/${st}/pairing-code`, adminTok, {});
  const paired = await call<{ data: { station_token: string } }>("setup", "POST", "/v1/stations/pair", "", { code: code.body.data.code, device_label: "load" });
  const sess = await call<{ data: { session_token: string } }>("setup", "POST", "/v1/stations/sessions", paired.body.data.station_token, { pin: "123456" });
  stationTokens.push(sess.body.data.session_token);
}

// SSE streams held open for the whole run.
const controllers: AbortController[] = [];
let streamEvents = 0;
for (let i = 0; i < STREAMS; i++) {
  const ac = new AbortController();
  controllers.push(ac);
  const res = await app.request(`/v1/outlets/${boot.outletId}/stream`, { headers: { authorization: `Bearer ${stationTokens[i % STATIONS]!}` }, signal: ac.signal });
  void (async () => {
    const reader = res.body!.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        streamEvents += (new TextDecoder().decode(value).match(/^event:/gm) ?? []).length;
      }
    } catch {
      /* aborted */
    }
  })();
}

const started = performance.now();
await Promise.all(
  stationTokens.map(async (tok, s) => {
    for (let o = 0; o < ORDERS; o++) {
      try {
        const opened = await call<{ data: { id: string; version: number } }>("orders.open", "POST", "/v1/orders", tok, { order_id: randomUUID(), order_type: "takeaway", customer_name: `L${s}-${o}` });
        if (opened.status === 503) continue;
        const id = opened.body.data.id;
        const lines = Array.from({ length: 3 + (o % 4) }, (_, i) => ({ line_id: randomUUID(), product_id: products[(s + o + i) % products.length]!, quantity: 1 + (i % 2) }));
        await call("lines.add", "POST", `/v1/orders/${id}/lines`, tok, { lines });
        await call("orders.get", "GET", `/v1/orders/${id}`, tok);
        await call("orders.fire", "POST", `/v1/orders/${id}/fire`, tok, {});
        const snap = await call<{ data: { checks: { id: string; totals: { total: number } }[] } }>("orders.get", "GET", `/v1/orders/${id}`, tok);
        const chk = snap.body.data.checks[0]!;
        await call("payments.record", "POST", `/v1/checks/${chk.id}/payments`, tok, { payment_id: randomUUID(), tender_type_id: cash, amount: chk.totals.total, tendered: chk.totals.total + 500 });
        await call("floor.snapshot", "GET", `/v1/outlets/${boot.outletId}/floor`, tok);
      } catch (err) {
        console.error(String(err));
      }
    }
  }),
);
const elapsed = (performance.now() - started) / 1000;
await new Promise((r) => setTimeout(r, 500));
for (const c of controllers) c.abort();

const q = (xs: number[], p: number) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;
const rows = Object.entries(lat)
  .filter(([k]) => k !== "setup" && k !== "dev-token")
  .map(([k, v]) => ({ operation: k, calls: v.length, p50_ms: Math.round(q(v, 0.5)), p95_ms: Math.round(q(v, 0.95)), p99_ms: Math.round(q(v, 0.99)), max_ms: Math.round(Math.max(...v)) }));
const total = rows.reduce((s, r) => s + r.calls, 0);
console.log(JSON.stringify({ stations: STATIONS, orders_per_station: ORDERS, sse_streams: STREAMS, tx_max: Number(process.env.TX_MAX), queue_max: Number(process.env.QUEUE_MAX), elapsed_s: Number(elapsed.toFixed(1)), requests: total, requests_per_s: Math.round(total / elapsed), gate_rejections_503: rejected, sse_events_seen: streamEvents, operations: rows }, null, 2));

await stopListener();
await closePool();
await pg.stop();
process.exit(0);
