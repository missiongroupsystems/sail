/**
 * Guest contract smoke test: drives the same wrapper functions the guest app
 * uses (src/lib/api.ts) against a live register, in the order a table does:
 *
 *   (register) seat a table and rotate its QR → (guest) start a session →
 *   load the menu → send a round missing a required choice (validation) →
 *   send it properly → retry the same round (idempotent) → read the order →
 *   read the SSE hello → call staff ("Water") → repeat it (429) →
 *   a second, unseated table: session says can_order false, a round is 409 →
 *   (register) pay a takeaway bill and send a QR receipt → (guest) read it.
 *
 * Run (API from `pnpm --filter @sail/server dev:local`):
 *   NEXT_PUBLIC_API_URL=http://localhost:8080 pnpm --filter @sail/guest smoke
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ApiError, createGuestApi, createRequest, createSession, getMenu, getOrder, readReceipt, submitRound, uuid } from "../src/lib/api";
import type { CompiledGroup, CompiledProduct, GuestSession } from "../src/lib/types";

const API = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080").replace(/\/+$/, "");
const devLocal = JSON.parse(readFileSync(resolve(process.cwd(), process.env.SAIL_DEV_LOCAL ?? "../server/.dev-local.json"), "utf8")) as { outletId: string; brandId: string; admin_email: string; admin_password: string };

let failures = 0;
function ok(label: string, detail?: string) {
  console.log(`  ok    ${label}${detail ? `  ${detail}` : ""}`);
}
function fail(label: string, e: unknown) {
  failures++;
  const err = e instanceof ApiError ? `${e.code} (${e.status}): ${e.message}${e.remedy ? ` (${e.remedy})` : ""}` : String(e);
  console.log(`  FAIL  ${label}  ${err}`);
}
async function step<T>(label: string, fn: () => Promise<T>, detail?: (v: T) => string): Promise<T | null> {
  try {
    const v = await fn();
    ok(label, detail?.(v));
    return v;
  } catch (e) {
    fail(label, e);
    return null;
  }
}
async function expectError<T>(label: string, fn: () => Promise<T>, code: string, check?: (e: ApiError) => string | null): Promise<ApiError | null> {
  try {
    await fn();
    fail(label, `expected ${code}, got success`);
    return null;
  } catch (e) {
    if (e instanceof ApiError && e.code === code) {
      const problem = check?.(e) ?? null;
      if (problem) fail(label, problem);
      else ok(label, `${code}: "${e.message}"`);
      return e;
    }
    fail(label, e);
    return null;
  }
}

/* ---- The register side (staff), plain fetch with the Admin's back-office session. ---- */
let admin = "";
async function reg<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, { method, headers: { "content-type": "application/json", "idempotency-key": uuid(), ...(admin ? { authorization: `Bearer ${admin}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await res.json()) as T & { code?: string; message?: string };
  if (!res.ok) throw new ApiError({ code: json.code ?? "internal", message: json.message ?? `${path} → ${res.status}` }, res.status);
  return json;
}

console.log(`Guest smoke against ${API}`);

admin = (await reg<{ data: { token: string } }>("POST", "/v1/auth/sign-in", { email: devLocal.admin_email, password: devLocal.admin_password })).data.token;
const tables = (await reg<{ data: { id: string; name: string }[] }>("GET", `/v1/tables?outlet_id=${devLocal.outletId}`)).data;
if (tables.length < 2) {
  console.log("Need at least two tables in the demo outlet");
  process.exit(1);
}
const tableA = tables[0]!;
const tableB = tables[tables.length - 1]!;

// 1. Staff seat table A (the default: guests order only at a seated table).
await step(
  `orders.open dine-in on Table ${tableA.name}`,
  async () => {
    try {
      return await reg<{ data: { id: string } }>("POST", "/v1/orders", { order_id: uuid(), order_type: "dine_in", table_id: tableA.id, pax: 2, outlet_id: devLocal.outletId, brand_id: devLocal.brandId });
    } catch (e) {
      if (e instanceof ApiError && e.code === "state_conflict") return { data: { id: "(already seated)" } };
      throw e;
    }
  },
  (r) => `order ${r.data.id}`,
);
const qrA = await step(`tables.rotate_qr Table ${tableA.name}`, () => reg<{ data: { url: string } }>("POST", `/v1/tables/${tableA.id}/qr/rotate`, {}), (r) => r.data.url);
const qrB = await step(`tables.rotate_qr Table ${tableB.name}`, () => reg<{ data: { url: string } }>("POST", `/v1/tables/${tableB.id}/qr/rotate`, {}), (r) => r.data.url);
if (!qrA || !qrB) process.exit(1);
const tokenA = qrA.data.url.split("/t/")[1]!;
const tokenB = qrB.data.url.split("/t/")[1]!;

/* ---- The guest side: the app's own client and wrapper functions. ---- */
let session: GuestSession | null = null;
let unauthenticated = 0;
const api = createGuestApi({ baseUrl: API, getToken: () => session?.guest_token ?? null, onUnauthenticated: () => unauthenticated++ });
const device = uuid();

// 2. Scan: a session on the seated table.
session = await step("guest_sessions.create (seated table)", () => createSession(api, { token: tokenA, device_id: device }), (s) => `Table ${s.table.name} · ${s.outlet.name}; can_order ${s.can_order}, hold_orders ${s.hold_orders}, requests [${s.service_requests.join(", ")}]`);
if (!session) process.exit(1);
if (!session.can_order) fail("session.can_order", "expected true on a seated table");
await expectError("guest_sessions.create with a bad code", () => createSession(api, { token: "not-a-real-table-code", device_id: device }), "not_found");

// 3. The menu, and the products the test needs.
const menu = await step("menu.get", () => getMenu(api, session!.channel_link_id), (m) => `${m.brand.name}: ${m.menu.sections.length} sections, ${Object.keys(m.products).length} products, version ${m.version}`);
if (!menu) process.exit(1);
const requiredGroupOf = (p: CompiledProduct): CompiledGroup | null => p.modifier_groups.map((g) => menu.modifier_groups[g]).find((g): g is CompiledGroup => Boolean(g && g.min_select > 0)) ?? null;
const orderable = Object.values(menu.products).filter((p) => p.available_now && !p.sold_out);
const withChoice = orderable.find((p) => p.name === "Laksa" && requiredGroupOf(p)) ?? orderable.find((p) => requiredGroupOf(p));
const simple = orderable.find((p) => p.modifier_groups.length === 0);
if (!withChoice || !simple) {
  fail("menu has a product with a required choice and a simple product", `withChoice ${withChoice?.name}, simple ${simple?.name}`);
  process.exit(1);
}
const group = requiredGroupOf(withChoice)!;
ok("menu products", `${withChoice.name} (${group.name}: choose ${group.min_select}), ${simple.name}`);

// 4. A round missing the required choice: the register's own words, with the group id for the review page.
const lineChoice = uuid();
const lineSimple = uuid();
await expectError(
  `rounds.submit ${withChoice.name} without ${group.name}`,
  () => submitRound(api, { round_id: uuid(), lines: [{ line_id: uuid(), product_id: withChoice.id, quantity: 1 }] }, uuid()),
  "validation",
  (e) => (e.groupId === group.id ? (e.message.startsWith("Choose") ? null : `unexpected message ${e.message}`) : `details.group_id ${e.groupId} ≠ ${group.id}`),
);

// 5. The round done properly; then the same round again with the same key (a retry) must not double it.
const roundId = uuid();
const key = uuid();
const option = group.options[0]!;
const body = { round_id: roundId, lines: [{ line_id: lineChoice, product_id: withChoice.id, quantity: 1, modifiers: [{ group_id: group.id, product_id: option.product_id }] }, { line_id: lineSimple, product_id: simple.id, quantity: 2, notes: "No ice" }], guest_name: "Smoke" };
const sent = await step(`rounds.submit ${withChoice.name} (${option.name}) + 2× ${simple.name}`, () => submitRound(api, body, key), (r) => `round ${r.round_id} ${r.status}, order ${r.order?.order_no} ${r.order?.status}, ${r.lines.length} lines on the table, order_opened ${r.order_opened}`);
if (sent) {
  if (session.hold_orders && sent.status !== "pending") fail("round status with hold orders", `expected pending, got ${sent.status}`);
  const mine = sent.lines.filter((l) => l.mine);
  if (mine.length !== 2) fail("lines marked mine", `${mine.length} of ${sent.lines.length}`);
  else ok("lines marked mine", mine.map((l) => `${l.name} ×${l.quantity} [${l.modifiers.join(", ")}] ${l.status}`).join("; "));
}
const replay = await step("rounds.submit retried with the same round_id and Idempotency-Key", () => submitRound(api, body, key), (r) => `round ${r.round_id} ${r.status}`);
if (replay && sent && replay.lines.filter((l) => l.mine).length !== sent.lines.filter((l) => l.mine).length) fail("idempotent retry", "the retry added lines");
await expectError("rounds.submit a second round straight away", () => submitRound(api, { round_id: uuid(), lines: [{ line_id: uuid(), product_id: simple.id, quantity: 1 }] }, uuid()), "rate_limited", (e) => (e.retryAfterSeconds ? null : "no details.retry_after_seconds"));

// 6. The order view and the live stream.
await step("guest.order", () => getOrder(api), (v) => `order ${v.order?.order_no} ${v.order?.status}; rounds ${v.rounds.map((r) => `${r.status}${r.mine ? " (mine)" : ""}`).join(", ")}; ${v.lines.length} lines`);
await step("guest.stream hello", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  const res = await fetch(`${API}/v1/guest/stream`, { headers: { authorization: `Bearer ${session!.guest_token}`, accept: "text/event-stream" }, signal: controller.signal });
  if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
  const { value } = await res.body.getReader().read();
  clearTimeout(timer);
  controller.abort();
  const text = new TextDecoder().decode(value);
  if (!text.includes("event: hello")) throw new Error(`no hello: ${text}`);
  return text.replace(/\s+/g, " ").trim();
});

// 7. Call staff, then again too soon. The register allows one request per type per table per minute, so
// runs within a minute of each other take turns through the channel's list.
const requestType = session.service_requests[Math.floor(Date.now() / 60_000) % Math.max(1, session.service_requests.length)] ?? "call_for_bill";
await step(`service_requests.create "${requestType}"`, () => createRequest(api, requestType, "Smoke"), (r) => `${String(r.type)} ${String(r.status)}`);
await expectError(`service_requests.create "${requestType}" again within 60 s`, () => createRequest(api, requestType), "rate_limited", (e) => (e.retryAfterSeconds ? null : "no details.retry_after_seconds"));
await expectError('service_requests.create a type the channel does not offer', () => createRequest(api, "Helicopter"), "validation");

// 8. An unseated table: browse only, and a round is refused with table_not_open.
const sessionB = await step(`guest_sessions.create (Table ${tableB.name}, not seated)`, () => createSession(api, { token: tokenB, device_id: uuid() }), (s) => `order_open ${s.order_open}, can_order ${s.can_order}`);
if (sessionB) {
  if (sessionB.order_open) ok("Table B already has an order; skipping the table_not_open check");
  else {
    if (sessionB.can_order) fail("session.can_order on an unseated table", "expected false (open_on_first_scan is off in the demo)");
    const apiB = createGuestApi({ baseUrl: API, getToken: () => sessionB.guest_token });
    await expectError("rounds.submit at an unseated table", () => submitRound(apiB, { round_id: uuid(), lines: [{ line_id: uuid(), product_id: simple.id, quantity: 1 }] }, uuid()), "state_conflict", (e) => (e.tableNotOpen ? null : "details.table_not_open missing"));
    await step("guest.order at an unseated table", () => getOrder(apiB), (v) => `order ${v.order === null ? "null" : "present"}, ${v.rounds.length} rounds`);
    await expectError("guest.stream at an unseated table (poll instead)", async () => {
      const res = await fetch(`${API}/v1/guest/stream`, { headers: { authorization: `Bearer ${sessionB.guest_token}`, accept: "text/event-stream" } });
      if (res.ok) throw new Error("stream opened without an order");
      throw ApiError.from(res.status, await res.json());
    }, "state_conflict");
  }
}

// 9. A receipt: the register pays a takeaway bill and sends a QR receipt; the guest reads it by token.
const receiptToken = await step(
  "register: takeaway → line → fire → pay cash → receipts.send qr",
  async () => {
    const order = await reg<{ data: { id: string; version: number } }>("POST", "/v1/orders", { order_id: uuid(), order_type: "takeaway", outlet_id: devLocal.outletId, brand_id: devLocal.brandId });
    const added = await reg<{ data: { version: number } }>("POST", `/v1/orders/${order.data.id}/lines`, { lines: [{ line_id: uuid(), product_id: simple.id, quantity: 1 }], expected_version: order.data.version });
    await reg("POST", `/v1/orders/${order.data.id}/fire`, { expected_version: added.data.version });
    const checks = await reg<{ data: { id: string; balance: number; total: number }[] }>("GET", `/v1/orders/${order.data.id}/checks`);
    const check = checks.data[0]!;
    const tenders = await reg<{ data: { id: string; name: string; is_cash: boolean }[] }>("GET", "/v1/tender-types");
    const cash = tenders.data.find((t) => t.is_cash) ?? tenders.data[0]!;
    // Cash goes into a shift's drawer: open an outlet-wide one if none is open.
    const open = await reg<{ data: { station_id: string | null }[] }>("GET", `/v1/outlets/${devLocal.outletId}/shifts?status=open`);
    if (!open.data.some((s) => s.station_id === null)) await reg("POST", "/v1/shifts", { outlet_id: devLocal.outletId, station_id: null, float_cents: 0 });
    // A $10 note on top of the balance: the register applies cash rounding and computes the change for the receipt.
    await reg("POST", `/v1/checks/${check.id}/payments`, { payment_id: uuid(), tender_type_id: cash.id, amount: check.balance, tendered: check.balance + 1000 });
    const receipt = await reg<{ data: { token: string; url: string } }>("POST", `/v1/checks/${check.id}/receipt/send`, { channel: "qr" });
    return { token: receipt.data.token, url: receipt.data.url, balance: check.balance, tender: cash.name };
  },
  (r) => `${r.url} (paid ${r.balance} cents by ${r.tender})`,
);
if (receiptToken) {
  await step("receipts.read", () => readReceipt(api, receiptToken.token), (r) => `${r.document.kind} ${r.document.check_label} · ${r.document.header.brand_name} · total ${r.document.totals.total} · ${r.document.payments?.map((p) => `${p.tender} ${p.amount}${p.rounding_cents ? ` (rounding ${p.rounding_cents})` : ""}${p.change ? ` change ${p.change}` : ""}`).join(", ")}`);
}
await expectError("receipts.read with an unknown token", () => readReceipt(api, "no-such-receipt-token"), "not_found");

if (unauthenticated) fail("unexpected 401s during the run", String(unauthenticated));
console.log(failures ? `\n${failures} failure(s)` : "\nAll steps passed");
process.exit(failures ? 1 : 0);
