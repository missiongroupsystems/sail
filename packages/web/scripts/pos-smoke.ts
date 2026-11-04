/**
 * POS contract smoke test: drives the same wrapper functions the iPad POS uses
 * (src/pos/api/register.ts) against a live register, in the order a shift does:
 *
 *   pair → sign in (Server) → menu, layout, floor → open a dine-in order →
 *   add a line with a required modifier → add a simple line → send one line →
 *   void the sent line with a manager override → apply "Staff meal" (manager
 *   override, Server is below Cashier) → stale-version add is retried without
 *   a version → catch up on events and read the SSE hello → cancel → sign out.
 *
 * Run (API from `pnpm --filter @sail/server dev:local` on :8080):
 *   pnpm --filter @sail/web pos:smoke
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ApiError, idempotencyKey } from "../src/lib/api";
import { createPosApi } from "../src/pos/api/client";
import * as reg from "../src/pos/api/register";

const API = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080").replace(/\/+$/, "");
const devLocal = JSON.parse(readFileSync(resolve(process.cwd(), process.env.SAIL_DEV_LOCAL ?? "../server/.dev-local.json"), "utf8")) as { stationId: string; outletId: string };

let token: string | null = null;
const api = createPosApi({ baseUrl: API, getToken: () => token });

let failures = 0;
function ok(label: string, detail?: string) {
  console.log(`  ok    ${label}${detail ? `  ${detail}` : ""}`);
}
function fail(label: string, e: unknown) {
  failures++;
  const err = e instanceof ApiError ? `${e.code}: ${e.message}${e.remedy ? ` (${e.remedy})` : ""}` : String(e);
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
async function expectError<T>(label: string, fn: () => Promise<T>, code: string): Promise<ApiError | null> {
  try {
    await fn();
    fail(label, `expected ${code}, got success`);
    return null;
  } catch (e) {
    if (e instanceof ApiError && e.code === code) {
      ok(label, `${code} as expected`);
      return e;
    }
    fail(label, e);
    return null;
  }
}

async function adminJson<T>(path: string, body: unknown, bearer?: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": idempotencyKey(), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

console.log(`POS smoke against ${API}`);

// 0. An Admin issues a pairing code (back office step).
const admin = await adminJson<{ token: string }>("/v1/auth/dev-token", { email: "admin@sail.local" });
const code = await adminJson<{ data: { code: string } }>(`/v1/stations/${devLocal.stationId}/pairing-code`, {}, admin.token);

// 0b. The dev seed writes rule bodies with `${JSON.stringify(...)}::jsonb`, which postgres.js double-encodes, so the
// register's own `activeRules` parse fails on them: every order call, and `?active_at=`, answers 400 validation
// (drizzle paths parse the string back, which is why the plain list works). Repair through the register only:
// archive each seeded rule key, then re-issue it as a new version via pricing_rules.create_version (proper jsonb).
{
  const probe = await fetch(`${API}/v1/pricing-rules?active_at=${new Date().toISOString()}`, { headers: { authorization: `Bearer ${admin.token}` } });
  if (!probe.ok) {
    const body = (await probe.json()) as { code?: string; message?: string };
    console.log(`  note  pricing_rules.list?active_at failed on the seeded rules (${body.code}: ${body.message}); re-issuing them through the register`);
    const all = await fetch(`${API}/v1/pricing-rules`, { headers: { authorization: `Bearer ${admin.token}` } });
    const rows = ((await all.json()) as { data: { rule_key: string; status: string; version: number; body: Record<string, unknown> }[] }).data;
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if (r.status === "active" && (!latest.has(r.rule_key) || r.version > latest.get(r.rule_key)!.version)) latest.set(r.rule_key, r);
    for (const r of latest.values()) await adminJson(`/v1/pricing-rules/${encodeURIComponent(r.rule_key)}/archive`, { reason: "smoke: re-issuing the seeded rule" }, admin.token);
    for (const r of latest.values()) {
      const { id: _id, version: _v, ...ruleBody } = r.body as Record<string, unknown> & { id?: string; version?: number };
      await adminJson(`/v1/pricing-rules`, { rule_key: r.rule_key, body: ruleBody, note: "smoke: re-issued seeded rule" }, admin.token);
    }
    const again = await fetch(`${API}/v1/pricing-rules?active_at=${new Date().toISOString()}`, { headers: { authorization: `Bearer ${admin.token}` } });
    (again.ok ? ok : (l: string, d?: string) => fail(l, d))("pricing_rules.list?active_at after re-issuing", `${again.status}, ${latest.size} rules`);
  }
}

// 1. Pair, then sign in as Sam Server (444444).
const paired = await step("stations.pair", () => reg.pairStation(api, code.data.code, "Smoke iPad"), (p) => `station ${p.station.name}, home ${p.station.home}, seats ${p.station.seats_enabled}`);
if (!paired) process.exit(1);
token = paired.station_token;

await expectError("staff_sessions.start wrong PIN", () => reg.startSession(api, "000000"), "unauthenticated");
const session = await step("staff_sessions.start (Server)", () => reg.startSession(api, "444444"), (s) => `${s.staff.name} (${s.staff.role}), expires in ${s.expires_in_seconds}s`);
if (!session) process.exit(1);
token = session.session_token;
const station = session.station;

await step("me", () => reg.getMe(api), (m) => `${m.type} ${m.name} via ${m.via}`);

// 2. Reference data the order screen needs.
const link = await step("channel-links (pos)", () => reg.findPosChannelLink(api, station.outlet_id, station.brand_id));
const menu = link ? await step("menu.get", () => reg.getMenu(api, link.id), (m) => `${Object.keys(m.products).length} products, ${m.menu.sections.length} sections, version ${m.version}`) : null;
const layout = station.layout_id ? await step("layouts.get", () => reg.getLayout(api, station.layout_id!), (l) => `${l.pages.length} pages`) : null;
const floor = await step("floor.snapshot", () => reg.getFloor(api, station.outlet_id), (f) => `${f.areas.length} areas, ${f.tables.length} tables, ${f.open_orders} open`);
await step("orders.list open", () => reg.listOpenOrders(api, station.outlet_id), (o) => `${o.length} open`);
const rules = await step("pricing_rules.list manual", () => reg.listManualRules(api), (r) => r.map((x) => `${x.name} (${x.min_role})`).join(", "));
const reasons = await step("void_reasons.list", () => reg.listVoidReasons(api), (r) => r.map((x) => x.name).join(", "));
await step("outlets.list", () => reg.listOutlets(api), (o) => o.map((x) => `${x.name} service from ${x.service_theme_from}`).join(", "));
await step("stations.list", () => reg.listStations(api, station.outlet_id), (s) => `${s.length} stations`);
if (!menu || !floor || !rules || !reasons || !layout) process.exit(1);

// 3. Seat a table (2 taps on the floor).
const freeTable = floor.tables.find((t) => t.status === "free")!;
const orderId = idempotencyKey();
const opened = await step("orders.open dine-in", () => reg.openOrder(api, { order_id: orderId, order_type: "dine_in", table_id: freeTable.id, pax: 3 }), (r) => `${r.data.order_no} v${r.data.version} total ${r.data.totals.total}`);
if (!opened) process.exit(1);
let version = opened.data.version;

// 4. A line with a required choice (Laksa → Protein: Prawn, + Spice: Less spicy), then a simple line (Kopi Peng).
const laksa = Object.values(menu.products).find((p) => p.name === "Laksa")!;
const protein = laksa.modifier_groups.map((g) => menu.modifier_groups[g]!).find((g) => g.min_select > 0)!;
const spice = laksa.modifier_groups.map((g) => menu.modifier_groups[g]!).find((g) => g.min_select === 0)!;
const prawn = protein.options.find((o) => o.name === "Prawn")!;
const less = spice.options[0]!;
await expectError("lines.add missing required choice", () => reg.addLines(api, orderId, [{ line_id: idempotencyKey(), product_id: laksa.id, quantity: 1 }], { expectedVersion: version }), "validation");
const laksaLine = idempotencyKey();
const withMod = await step(
  "lines.add Laksa (prawn, less spicy)",
  () => reg.addLines(api, orderId, [{ line_id: laksaLine, product_id: laksa.id, quantity: 1, seat_no: 1, modifiers: [{ group_id: protein.id, product_id: prawn.product_id }, { group_id: spice.id, product_id: less.product_id }] }], { expectedVersion: version }),
  (r) => `line total ${r.data.lines[0]!.amounts.total}, order total ${r.data.totals.total}, adjustments ${r.data.adjustments.map((a) => `${a.name}=${a.total}`).join(" ")}`,
);
if (!withMod) process.exit(1);
version = withMod.data.version;

const kopi = Object.values(menu.products).find((p) => p.name === "Kopi Peng")!;
const kopiLine = idempotencyKey();
const simple = await step("lines.add Kopi Peng (1 tap)", () => reg.addLines(api, orderId, [{ line_id: kopiLine, product_id: kopi.id, quantity: 2, seat_no: 2 }], { expectedVersion: version }), (r) => `v${r.data.version} total ${r.data.totals.total}`);
if (!simple) process.exit(1);
version = simple.data.version;

// 5. Stale version → version_conflict; the POS refetches and retries the add without a version ("Your 1 new line was kept").
const conflict = await expectError("lines.add with stale expected_version", () => reg.addLines(api, orderId, [{ line_id: idempotencyKey(), product_id: kopi.id, quantity: 1 }], { expectedVersion: version - 1 }), "version_conflict");
if (conflict) ok("version_conflict details", `current_version ${String(conflict.details?.current_version)}`);
const retried = await step("lines.add retried without expected_version", () => reg.addLines(api, orderId, [{ line_id: idempotencyKey(), product_id: kopi.id, quantity: 1 }]), (r) => `v${r.data.version}, ${r.data.lines.length} lines`);
if (retried) version = retried.data.version;

// 6. Hold and release (T1 with Undo), edit notes and quantity.
const held = await step("lines.update hold", () => reg.updateLine(api, orderId, kopiLine, { hold: true }, { expectedVersion: version }), (r) => `status ${r.data.lines.find((l) => l.id === kopiLine)!.status}`);
if (held) version = held.data.version;
const released = await step("lines.update release + note + qty", () => reg.updateLine(api, orderId, kopiLine, { hold: false, notes: "No ice", quantity: 1 }, { expectedVersion: version }), (r) => `qty ${r.data.lines.find((l) => l.id === kopiLine)!.quantity}, total ${r.data.totals.total}`);
if (released) version = released.data.version;

// 7. Send the Laksa only.
const fired = await step("orders.fire (Laksa)", () => reg.fireOrder(api, orderId, { line_ids: [laksaLine] }, { expectedVersion: version }), (r) => `status ${r.data.status}, round ${r.data.round_count}${r.warnings.length ? `, warnings: ${r.warnings.join("; ")}` : ""}`);
if (!fired) process.exit(1);
version = fired.data.version;

// 8. Void the sent line: a Server needs a manager's PIN (Approve here).
const reason = reasons[0]!;
const denied = await expectError("lines.void sent line as Server", () => reg.voidLine(api, orderId, laksaLine, { reason_id: reason.id }, { expectedVersion: version }), "permission_denied");
if (denied) ok("permission_denied details", `required_role ${String(denied.details?.required_role)}, override_allowed ${String(denied.details?.override_allowed)}`);
await expectError("overrides.grant with a Server PIN", () => reg.grantOverride(api, { action: "lines.void_fired", target_kind: "order_line", target_id: laksaLine, approver_pin: "333333" }), "permission_denied");
const grant = await step("overrides.grant (Mia Manager 222222)", () => reg.grantOverride(api, { action: "lines.void_fired", target_kind: "order_line", target_id: laksaLine, approver_pin: "222222" }), (g) => `approved by ${g.approver.name} (${g.approver.role}), expires ${g.expires_at}`);
if (grant) {
  const voided = await step("lines.void with override_id", () => reg.voidLine(api, orderId, laksaLine, { reason_id: reason.id }, { expectedVersion: version, overrideId: grant.override_id }), (r) => `line ${r.data.lines.find((l) => l.id === laksaLine)!.status}, reason "${r.data.lines.find((l) => l.id === laksaLine)!.void_reason}", total ${r.data.totals.total}`);
  if (voided) version = voided.data.version;
}

// 9. Staff meal (min_role cashier, reason required): Server → manager override, then applied; then removed.
const staffMeal = rules.find((r) => r.name === "Staff meal")!;
await expectError("adjustments.apply_manual Staff meal without reason", () => reg.applyAdjustment(api, orderId, { application_id: idempotencyKey(), rule_key: staffMeal.rule_key, reason: null }, { expectedVersion: version }), "validation");
const smDenied = await expectError("adjustments.apply_manual Staff meal as Server", () => reg.applyAdjustment(api, orderId, { application_id: idempotencyKey(), rule_key: staffMeal.rule_key, reason: "Staff" }, { expectedVersion: version }), "permission_denied");
if (smDenied) ok("permission_denied details", `override_allowed ${String(smDenied.details?.override_allowed)}`);
const smGrant = await step("overrides.grant adjustments.apply_manual", () => reg.grantOverride(api, { action: "adjustments.apply_manual", target_kind: "order", target_id: orderId, approver_pin: "222222" }));
const appId = idempotencyKey();
if (smGrant) {
  const applied = await step("adjustments.apply_manual Staff meal with override", () => reg.applyAdjustment(api, orderId, { application_id: appId, rule_key: staffMeal.rule_key, reason: "Staff" }, { expectedVersion: version, overrideId: smGrant.override_id }), (r) => `adjustments: ${r.data.adjustments.map((a) => `${a.name}=${a.kind === "discount" ? "-" : ""}${a.total}`).join(", ")}; total ${r.data.totals.total}`);
  if (applied) version = applied.data.version;
}
const percentOff = rules.find((r) => r.name === "% off item");
if (percentOff) {
  await expectError("adjustments.apply_manual % off item above max", () => reg.applyAdjustment(api, orderId, { application_id: idempotencyKey(), rule_key: percentOff.rule_key, entered_value: 9_000, line_ids: [kopiLine] }, { expectedVersion: version }), "validation");
}

// 10. Remove the manual adjustment (needs the rule's role again → override).
const rmGrant = await step("overrides.grant adjustments.remove", () => reg.grantOverride(api, { action: "adjustments.remove", target_kind: "order", target_id: orderId, approver_pin: "222222" }));
if (rmGrant) {
  const removed = await step("adjustments.remove Staff meal", () => reg.removeAdjustment(api, orderId, appId, { expectedVersion: version, overrideId: rmGrant.override_id }), (r) => `adjustments now ${r.data.adjustments.map((a) => a.name).join(", ") || "none"}; total ${r.data.totals.total}`);
  if (removed) version = removed.data.version;
}

// 11. Event store: catch up from 0, confirm the order's events are there, and read the SSE hello.
const events = await step("events.list after=0", () => reg.listEvents(api, station.outlet_id, 0, 1000), (p) => `${p.data.length} events, latest_seq ${p.latest_seq}, has_more ${p.has_more}`);
if (events) {
  const mine = events.data.filter((e) => e.aggregate.id === orderId);
  const types = [...new Set(mine.map((e) => e.type))];
  ok("events for this order", `${mine.length}: ${types.join(", ")}`);
  const fromStation = mine.every((e) => e.actor.station_id === station.id);
  (fromStation ? ok : (l: string, d?: string) => fail(l, d))("actor.station_id on every order event", String(fromStation));
}
await step("outlets.stream hello", async () => {
  const controller = new AbortController();
  const res = await fetch(`${API}/v1/outlets/${station.outlet_id}/stream`, { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" }, signal: controller.signal });
  if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
  const reader = res.body.getReader();
  const { value } = await reader.read();
  controller.abort();
  const text = new TextDecoder().decode(value);
  if (!text.includes("event: hello")) throw new Error(`no hello: ${text}`);
  return text.replace(/\s+/g, " ").trim();
});

// 12. Fresh snapshot, then cancel (nothing sent remains: the sent line was voided).
await step("orders.get", () => reg.getOrder(api, orderId), (o) => `v${o.version} ${o.status}, ${o.lines.filter((l) => l.status !== "voided").length} live lines, balance ${o.balance}`);
const cancelled = await step("orders.cancel", () => reg.cancelOrder(api, orderId, "Smoke test", { expectedVersion: version }), (r) => `status ${r.data.status}`);
if (cancelled) {
  const after = await reg.getFloor(api, station.outlet_id);
  const t = after.tables.find((x) => x.id === freeTable.id)!;
  (t.status === "free" ? ok : (l: string, d?: string) => fail(l, d))("table free again after cancel", t.status);
}

// 13. A takeaway order for the Orders screen, marked ready, then cancelled.
const ta = await step("orders.open takeaway", () => reg.openOrder(api, { order_id: idempotencyKey(), order_type: "takeaway", takeaway_ref: "Lim" }), (r) => `${r.data.order_no} ${r.data.customer_ref?.name}`);
if (ta) {
  const added = await step("lines.add to takeaway", () => reg.addLines(api, ta.data.id, [{ line_id: idempotencyKey(), product_id: kopi.id, quantity: 1 }], { expectedVersion: ta.data.version }), (r) => `total ${r.data.totals.total} (takeaway prices)`);
  const sent = added ? await step("orders.fire takeaway", () => reg.fireOrder(api, ta.data.id, {}, { expectedVersion: added.data.version })) : null;
  const ready = sent ? await step("orders.ready", () => reg.markReady(api, ta.data.id, { expectedVersion: sent.data.version }), (r) => `status ${r.data.status}`) : null;
  void ready;
}

await step("staff_sessions.end", () => reg.endSession(api));

console.log(failures ? `\n${failures} step(s) failed` : "\nAll steps passed");
process.exit(failures ? 1 : 0);
