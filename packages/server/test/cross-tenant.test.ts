import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/modules.js";
import { buildApp } from "../src/app.js";
import { api, seedMerchant, type SeededMerchant, type TestDb } from "./helpers.js";
import { bootWorld, orderHelpers, type Call, type World } from "./world.js";

/**
 * Tenancy through the API, not only through RLS: merchant B, with its own Admin and its own print relay, calls every
 * route that takes an id with merchant A's real ids, and gets 404 or 403 every time. The routes come from the spec, so a
 * new route that takes an id is covered without editing this test.
 */
let db: TestDb;
let call: Call;
let w: World;
let B: SeededMerchant;
let bRelayToken: string;
type S = Record<string, unknown>;
type Doc = { paths: Record<string, Record<string, { operationId: string; parameters?: { name: string; in: string }[]; requestBody?: { content?: Record<string, { schema?: S }> }; "x-sail": { principals: string[] } }>>; components?: { schemas?: Record<string, S> } };
let doc: Doc;

beforeAll(async () => {
  ({ db, call, w } = await bootWorld());
  const h = orderHelpers(call, w);
  const t = w.m.admin.token;
  const must = async (method: string, path: string, body: unknown, token = t) => {
    const r = await call<{ data: Record<string, unknown> }>(method, path, { token, body });
    if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.data;
  };
  // Merchant A: at least one row behind every route family that takes an id.
  const area = randomUUID();
  const table = randomUUID();
  await must("POST", "/v1/areas", { id: area, outlet_id: w.m.outletId, name: "Main" });
  await must("POST", "/v1/tables", { id: table, outlet_id: w.m.outletId, area_id: area, name: "1" });
  await must("POST", "/v1/categories", { name: "Food" });
  await must("POST", "/v1/customer-groups", { name: "Regulars" });
  await must("PUT", "/v1/customers", { name: "A customer", mobile: "91234567" });
  await must("POST", "/v1/availability-rules", { target_kind: "product", target_id: w.ids.wine, days_of_week: [], start_time: "00:00", end_time: "00:01" });
  await must("POST", "/v1/layouts", { brand_id: w.m.brandId, name: "Main", pages: [] });
  await must("POST", "/v1/modifier-groups", { name: "Size", min_select: 0, options: [{ product_id: w.ids.kopi }] });
  await must("POST", "/v1/relays", { outlet_id: w.m.outletId, name: "Relay" });
  // A kitchen display destination, so the fire below also makes a kitchen ticket.
  await must("POST", "/v1/display-destinations", { outlet_id: w.m.outletId, name: "Kitchen screen" });
  await must("POST", "/v1/imports", { files: { "brands.csv": "id,name\nB9,Second brand\n" }, mapping: { files: [{ name: "brands.csv", entity: "brands", columns: { legacy_id: "id", name: "name" } }] }, dry_run: true });
  await must("POST", "/v1/shifts", { float_cents: 0 }, w.pins.cashier);
  const s = await h.orderWith(w.pins.cashier, [{ product_id: w.ids.laksa }, { product_id: w.ids.kopi }]);
  await must("POST", `/v1/orders/${s.id}/adjustments`, { application_id: randomUUID(), rule_key: "seed:staff-meal", reason: "Lunch", line_ids: [s.lines[0]!.id] }, w.pins.manager);
  await h.fire(w.pins.cashier, s.id);
  const paid = await h.paidOrder(w.pins.cashier, [{ product_id: w.ids.kopi }]);
  await must("POST", `/v1/checks/${paid.checks[0]!.id}/invoice`, {}, w.pins.cashier);
  await must("POST", `/v1/checks/${paid.checks[0]!.id}/refunds`, { refund_id: randomUUID(), request: { kind: "full" }, reason: "Spill" }, w.pins.manager);
  const agent = await must("POST", "/v1/agent-identities", { name: "Helper", role: "server", toolsets: ["pos.order"], risk_ceiling: "T1" });
  const session = await call<{ data: { agent_token: string } }>("POST", "/v1/agent-sessions", { body: { credential: agent.credential }, idempotencyKey: null });
  const open = await h.orderWith(w.pins.cashier, [{ product_id: w.ids.kopi }]);
  expect((await call("POST", `/v1/orders/${open.id}/fire`, { token: session.body.data.agent_token, body: {} })).status).toBe(202);
  const [gs] = await db.sql<{ id: string }[]>`insert into guest_sessions (merchant_id, outlet_id, brand_id, table_id, channel_link_id, order_id, device_hash, expires_at) values (${w.m.merchantId}, ${w.m.outletId}, ${w.m.brandId}, ${table}, ${w.ids.posLink}, ${open.id}, 'device', now() + interval '1 hour') returning id`;
  await db.sql`insert into guest_rounds (id, merchant_id, outlet_id, order_id, guest_session_id, table_id, status, line_ids) values (${randomUUID()}, ${w.m.merchantId}, ${w.m.outletId}, ${open.id}, ${gs!.id}, ${table}, 'pending', '{}')`;
  await db.sql`insert into service_requests (merchant_id, outlet_id, table_id, order_id, guest_session_id, type) values (${w.m.merchantId}, ${w.m.outletId}, ${table}, ${open.id}, ${gs!.id}, 'Water')`;

  // Merchant B: an Admin and a paired relay of its own.
  B = await seedMerchant(db.sql, "Beta");
  const relay = await must("POST", "/v1/relays", { outlet_id: B.outletId, name: "B relay" }, B.admin.token);
  const code = await must("POST", `/v1/relays/${relay.id as string}/pairing-code`, {}, B.admin.token);
  bRelayToken = (await call<{ data: { relay_token: string } }>("POST", "/v1/relays/pair", { body: { code: code.code }, idempotencyKey: null })).body.data.relay_token;
  doc = (await (await buildApp().request("/openapi.json")).json()) as Doc;
});
afterAll(async () => db.drop());

/** Merchant A's id for each route family and path parameter, read from the database so every one is a real row. */
async function idsOfA(): Promise<Record<string, string>> {
  const m = w.m.merchantId;
  const one = async (q: Promise<{ id: string }[]>) => {
    const [r] = await q;
    if (!r) throw new Error("merchant A is missing a row for a route family");
    return r.id;
  };
  const tables: Record<string, string> = { "agent-identities": "agent_identities", areas: "areas", "availability-rules": "availability_rules", brands: "brands", categories: "report_categories", "channel-links": "channel_links", checks: "checks", "customer-groups": "customer_groups", customers: "customers", "display-destinations": "display_destinations", "kitchen-tickets": "kitchen_tickets", imports: "import_jobs", layouts: "pos_layouts", menus: "menus", "modifier-groups": "modifier_groups", orders: "orders", outlets: "outlets", "print-jobs": "print_jobs", printers: "printers", products: "products", proposals: "proposals", refunds: "refunds", relays: "print_relays", rounds: "guest_rounds", "service-requests": "service_requests", shifts: "shifts", staff: "staff", stations: "stations", tables: "tables", "tax-classes": "tax_classes", "tender-types": "tender_types", "void-reasons": "void_reasons" };
  const out: Record<string, string> = {};
  for (const [family, table] of Object.entries(tables)) out[family] = await one(db.sql.unsafe(`select id::text as id from ${table} where merchant_id = $1 order by id limit 1`, [m]) as unknown as Promise<{ id: string }[]>);
  // An invoiced bill and a refund with a credit note, so their documents exist.
  out.checks = await one(db.sql`select id::text from checks where merchant_id = ${m} and invoice_no is not null limit 1`);
  out.refunds = await one(db.sql`select id::text from refunds where merchant_id = ${m} and credit_note_no is not null limit 1`);
  // An order with lines and a manual adjustment, so the nested ids belong to the same order.
  const [order] = await db.sql<{ id: string; line: string; app: string }[]>`select o.id::text, (select id::text from order_lines where order_id = o.id limit 1) as line, (select id::text from order_manual_applications where order_id = o.id limit 1) as app from orders o where o.merchant_id = ${m} and exists (select 1 from order_manual_applications a where a.order_id = o.id) limit 1`;
  out.orders = order!.id;
  out.line_id = order!.line;
  out.application_id = order!.app;
  out.rule_key = (await db.sql<{ k: string }[]>`select rule_key as k from pricing_rules where merchant_id = ${m} limit 1`)[0]!.k;
  out.rate_id = await one(db.sql`select id::text from tax_rates where merchant_id = ${m} and tax_class_id = ${out["tax-classes"]!}::uuid limit 1`);
  out.job_id = out["print-jobs"]!;
  return out;
}

const deref = (s: S): S => (typeof s.$ref === "string" ? deref(doc.components!.schemas![s.$ref.split("/").pop()!]!) : s);

/** The smallest body the schema accepts, so the request reaches the handler and tenancy decides the answer. */
function sample(raw: S, patch = false): unknown {
  let s = deref(raw);
  if (Array.isArray(s.allOf)) {
    const parts = (s.allOf as S[]).map(deref);
    s = { type: "object", properties: Object.assign({}, ...parts.map((x) => x.properties ?? {})), required: parts.flatMap((x) => (x.required as string[] | undefined) ?? []) };
  }
  const alt = (s.anyOf ?? s.oneOf) as S[] | undefined;
  if (alt) return sample(alt.find((x) => deref(x).type !== "null") ?? alt[0]!);
  if ("const" in s) return s.const;
  if (Array.isArray(s.enum)) return s.enum[0];
  if ("default" in s) return s.default;
  const type = Array.isArray(s.type) ? (s.type as string[]).find((t) => t !== "null") : s.type;
  if (type === "object" || s.properties) {
    const props = (s.properties as Record<string, S> | undefined) ?? {};
    const keys = (s.required as string[] | undefined) ?? [];
    // A PATCH with nothing in it is refused before the lookup; send one field so tenancy decides.
    if (patch && keys.length === 0) keys.push("name" in props ? "name" : Object.keys(props).find((k) => !["dry_run", "expected_version", "override_id"].includes(k))!);
    return Object.fromEntries(keys.map((k) => [k, sample(props[k] ?? {})]));
  }
  if (type === "array") return Array.from({ length: Number(s.minItems ?? 0) }, () => sample((s.items as S) ?? {}));
  if (type === "integer" || type === "number") return Math.max(1, Number(s.minimum ?? 1));
  if (type === "boolean") return false;
  if (s.format === "uuid") return randomUUID();
  if (s.format === "date-time") return new Date().toISOString();
  if (s.format === "email") return "someone@example.test";
  if (s.pattern === "^\\d{6}$") return "123456";
  if (s.pattern === "^\\d{4}-\\d{2}-\\d{2}$") return "2026-01-01";
  return "x".repeat(Math.max(1, Number(s.minLength ?? 1)));
}

describe("merchant B cannot reach merchant A's records through the API", () => {
  it("every route that takes an id answers 404 or 403 to the other merchant's Admin or relay, and A can read them all", async () => {
    const a = await idsOfA();
    const results: { route: string; status: number; code?: string }[] = [];
    const ownFailures: string[] = [];
    let routes = 0;
    for (const [path, methods] of Object.entries(doc.paths)) {
      if (!path.includes("{") || path.startsWith("/v1/receipts/")) continue; // a receipt token is a bearer link, not a tenant id
      const family = path.split("/")[2]!;
      const url = path.replace(/\{(\w+)\}/g, (_, name: string) => (name === "id" ? a[family]! : a[name]!));
      for (const [method, o] of Object.entries(methods)) {
        const principals = o["x-sail"].principals;
        const token = principals.includes("staff") ? B.admin.token : principals.includes("relay") ? bRelayToken : null;
        if (!token) continue;
        routes++;
        const schema = o.requestBody?.content?.["application/json"]?.schema;
        const res = await call<{ code?: string }>(method.toUpperCase(), url, { token, body: schema ? sample(schema, method === "patch") : undefined });
        results.push({ route: `${method.toUpperCase()} ${path}`, status: res.status, code: typeof res.body === "object" && res.body ? res.body.code : undefined });
        if (method === "get" && principals.includes("staff") && !path.endsWith("/stream")) {
          const own = await call("GET", url, { token: w.m.admin.token });
          if (own.status !== 200) ownFailures.push(`${path} ${own.status}`);
        }
      }
    }
    expect(ownFailures, "merchant A reads its own records").toEqual([]);
    expect(routes).toBeGreaterThan(100);
    expect(results.filter((r) => r.status !== 404 && r.status !== 403)).toEqual([]);
  });
});
