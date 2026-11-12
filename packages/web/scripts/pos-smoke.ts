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
 * Then, as Cal Cashier (v0.6 to v0.8): printers → a dine-in order sent to the
 * kitchen → even split → by-item move and a three-way share → pre-bills → card
 * part payment → split refused once paid → cash dry run, then cash with rounding
 * and change → the other bills by card → auto-complete → receipt QR link →
 * invoice → refund by line with a manager override → reopen (override) and
 * complete → shift open and close with expected cash → Z-report → late print
 * jobs and reroute to the backup → a guest session, QR round accept and a table
 * request acknowledged.
 *
 * Run (API from `pnpm --filter @sail/server dev:local` on :8080, or set
 * NEXT_PUBLIC_API_URL and SAIL_DEV_LOCAL for another port):
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
await expectError("overrides.grant with a Server PIN", () => reg.grantOverride(api, { action: "lines.void_fired", target_kind: "order_line", target_id: laksaLine, args: { quantity: 1 }, approver_pin: "333333" }), "permission_denied");
const grant = await step("overrides.grant (Mia Manager 222222)", () => reg.grantOverride(api, { action: "lines.void_fired", target_kind: "order_line", target_id: laksaLine, args: { quantity: 1 }, approver_pin: "222222" }), (g) => `approved by ${g.approver.name} (${g.approver.role}), expires ${g.expires_at}`);
if (grant) {
  const voided = await step("lines.void with override_id", () => reg.voidLine(api, orderId, laksaLine, { reason_id: reason.id }, { expectedVersion: version, overrideId: grant.override_id }), (r) => `line ${r.data.lines.find((l) => l.id === laksaLine)!.status}, reason "${r.data.lines.find((l) => l.id === laksaLine)!.void_reason}", total ${r.data.totals.total}`);
  if (voided) version = voided.data.version;
}

// 9. Staff meal (min_role cashier, reason required): Server → manager override, then applied; then removed.
const staffMeal = rules.find((r) => r.name === "Staff meal")!;
await expectError("adjustments.apply_manual Staff meal without reason", () => reg.applyAdjustment(api, orderId, { application_id: idempotencyKey(), rule_key: staffMeal.rule_key, reason: null }, { expectedVersion: version }), "validation");
const smDenied = await expectError("adjustments.apply_manual Staff meal as Server", () => reg.applyAdjustment(api, orderId, { application_id: idempotencyKey(), rule_key: staffMeal.rule_key, reason: "Staff" }, { expectedVersion: version }), "permission_denied");
if (smDenied) ok("permission_denied details", `override_allowed ${String(smDenied.details?.override_allowed)}`);
const smGrant = await step("overrides.grant adjustments.apply_manual", () => reg.grantOverride(api, { action: "adjustments.apply_manual", target_kind: "order", target_id: orderId, args: { rule_key: staffMeal.rule_key, entered_value: null, line_ids: null }, approver_pin: "222222" }));
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
const rmGrant = await step("overrides.grant adjustments.remove", () => reg.grantOverride(api, { action: "adjustments.remove", target_kind: "order", target_id: orderId, args: { application_id: appId }, approver_pin: "222222" }));
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


/* ======================================================================== *
 * v0.6 to v0.8: bills, payments, refunds, shifts, printing, Scan to Order.  *
 * ======================================================================== */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const check = (label: string, cond: boolean, detail?: string) => (cond ? ok(label, detail) : fail(label, detail ?? "condition false"));

// 14. Printers (back-office step, Admin): a kitchen printer with a backup, and a receipt printer. The demo has no relay, so jobs queue and become late.
// The Pass printer only takes tickets tagged "pass" (none are), so it receives rerouted tickets only; the Kitchen printer is the default.
// Reruns against the same register reuse the printers by name.
const existingPrinters = (await reg.listPrinters(api, station.outlet_id).catch(() => [])) as Awaited<ReturnType<typeof reg.listPrinters>>;
const printerNamed = async (name: string, body: Record<string, unknown>) => {
  const found = existingPrinters.find((p) => p.name === name);
  if (found) return { data: { id: found.id, name: found.name } };
  return adminJson<{ data: { id: string; name: string } }>("/v1/printers", { outlet_id: station.outlet_id, name, ...body }, admin.token);
};
const pass = await printerNamed("Pass printer", { ip: "10.0.0.12", role: "kitchen", include_tags: ["pass"] }).catch((e) => (fail("printers.create Pass", e), null));
const kitchen = pass ? await printerNamed("Kitchen printer", { ip: "10.0.0.11", role: "kitchen", is_default_kitchen: true, backup_printer_id: pass.data.id }).catch((e) => (fail("printers.create Kitchen", e), null)) : null;
const receiptPrinter = await printerNamed("Receipt printer", { ip: "10.0.0.13", role: "receipt" }).catch((e) => (fail("printers.create Receipt", e), null));
if (kitchen && receiptPrinter) ok("printers.create", `Kitchen printer → backup ${pass!.data.name}, receipt printer`);
const printersNow = await step("printers.list", () => reg.listPrinters(api, station.outlet_id), (ps) => ps.map((p) => `${p.name} (${p.role}${p.backup_printer_id ? ", backup set" : ""})`).join(", "));
await step("relays.list", () => reg.listRelays(api, station.outlet_id), (rs) => `${rs.length} relays, ${rs.filter((r) => r.online).length} online`);

// 15. Switch to Cal Cashier (333333): payments and shifts are Cashier+.
await step("staff_sessions.end (Server)", () => reg.endSession(api));
token = paired.station_token;
const cashier = await step("staff_sessions.start (Cashier)", () => reg.startSession(api, "333333"), (s) => `${s.staff.name} (${s.staff.role})`);
if (!cashier) process.exit(1);
token = cashier.session_token;

const tenders = await step("tender_types.list", () => reg.listTenderTypes(api, station.outlet_id), (ts) => ts.map((t) => `${t.name}${t.is_cash ? " (cash)" : t.is_terminal ? " (terminal)" : ""}`).join(", "));
const cashTender = tenders?.find((t) => t.is_cash);
const cardTender = tenders?.find((t) => !t.is_cash && t.is_terminal);
if (!cashTender || !cardTender) process.exit(1);

// 16. A dine-in order for three, everything sent (kitchen tickets queue on the printers above).
const floor2 = await reg.getFloor(api, station.outlet_id);
const table2 = floor2.tables.find((t) => t.status === "free")!;
const billOrderId = idempotencyKey();
const billOpened = await step("orders.open dine-in (bills)", () => reg.openOrder(api, { order_id: billOrderId, order_type: "dine_in", table_id: table2.id, pax: 3 }), (r) => `${r.data.order_no}, ${r.data.checks.length} bill`);
if (!billOpened) process.exit(1);
const satay = Object.values(menu.products).find((p) => p.name.startsWith("Satay")) ?? kopi;
const l1 = idempotencyKey();
const l2 = idempotencyKey();
const l3 = idempotencyKey();
const billLines = await step(
  "lines.add ×3 (seats 1, 2, shared)",
  () =>
    reg.addLines(api, billOrderId, [
      { line_id: l1, product_id: laksa.id, quantity: 1, seat_no: 1, modifiers: [{ group_id: protein.id, product_id: prawn.product_id }] },
      { line_id: l2, product_id: kopi.id, quantity: 2, seat_no: 2 },
      { line_id: l3, product_id: satay.id, quantity: 1 },
    ]),
  (r) => `total ${r.data.totals.total}, balance ${r.data.balance}, pricing ${r.data.pricing_status}`,
);
if (!billLines) process.exit(1);
const sentAll = await step("orders.fire all", () => reg.fireOrder(api, billOrderId, {}, { expectedVersion: billLines.data.version }), (r) => `status ${r.data.status}, round ${r.data.round_count}`);
if (!sentAll) process.exit(1);
let bill = sentAll.data;
const firedAt = Date.now();

// 17. Even split into 3, then by item: move the Kopi to bill 2, share the Laksa three ways.
const even = await step("checks.split_even n=3", () => reg.splitEven(api, billOrderId, 3, { expectedVersion: bill.version }), (r) => `${r.data.checks.length} bills: ${r.data.checks.map((c) => `${c.label}=${c.totals.total}`).join(" ")}`);
if (even) {
  bill = even.data;
  check("bills add up to the order total", bill.checks.reduce((s, c) => s + c.totals.total, 0) === bill.totals.total, `${bill.checks.reduce((s, c) => s + c.totals.total, 0)} = ${bill.totals.total}`);
  check("each line shared 1/3 on every bill", bill.checks.every((c) => c.allocations.every((a) => a.share === "1/3")), bill.checks[0]!.allocations.map((a) => a.share).join(","));
}
const checksList = await step("checks.list", () => reg.listChecks(api, billOrderId), (cs) => `${cs.length} bills`);
void checksList;
const c2 = bill.checks[1]!;
const moved = await step("checks.allocate move Kopi → Bill 2", () => reg.allocateLines(api, billOrderId, [{ line_id: l2, check_ids: [c2.id] }], undefined, { expectedVersion: bill.version }), (r) => r.data.checks.map((c) => `${c.label}=${c.totals.total}`).join(" "));
if (moved) {
  bill = moved.data;
  const onlyOn2 = bill.checks.filter((c) => c.allocations.some((a) => a.line_id === l2));
  check("Kopi now only on Bill 2 with share 1", onlyOn2.length === 1 && onlyOn2[0]!.id === c2.id && onlyOn2[0]!.allocations.find((a) => a.line_id === l2)!.share === "1");
  check("bills still add up", bill.checks.reduce((s, c) => s + c.totals.total, 0) === bill.totals.total);
}
const shared = await step("checks.allocate share Laksa between 3 bills", () => reg.allocateLines(api, billOrderId, [{ line_id: l1, check_ids: bill.checks.map((c) => c.id) }], undefined, { expectedVersion: bill.version }), (r) => r.data.checks.map((c) => `${c.label}=${c.totals.total}`).join(" "));
if (shared) bill = shared.data;
// An empty bill cannot stand on its own: the register prunes empty unlocked bills, so add_checks without a move is a no-op (see the report's API gaps).
const added = await step("checks.allocate add_checks=1 without moves", () => reg.allocateLines(api, billOrderId, [], 1, { expectedVersion: bill.version }), (r) => `${r.data.checks.length} bills (empty bill pruned by the register)`);
if (added) bill = added.data;
const bySeat = await step("checks.split_by_seat shared=even", () => reg.splitBySeat(api, billOrderId, "even", { expectedVersion: bill.version }), (r) => r.data.checks.map((c) => `${c.label} seat ${c.seat_no}=${c.totals.total}`).join(" "));
if (bySeat) bill = bySeat.data;
const backToEven = await step("checks.split_even n=3 again", () => reg.splitEven(api, billOrderId, 3, { expectedVersion: bill.version }), (r) => `${r.data.checks.length} bills`);
if (backToEven) bill = backToEven.data;

// 18. Pre-bills for every bill: the table turns "bill requested".
const prebilled = await step("checks.print_prebill (all)", () => reg.printPrebill(api, billOrderId, null, { expectedVersion: bill.version }), (r) => `${r.jobs.length} jobs, bill_requested_at ${r.data.bill_requested_at ? "set" : "null"}`);
if (prebilled) {
  bill = prebilled.data;
  const f = await reg.getFloor(api, station.outlet_id);
  check("table status bill_requested", f.tables.find((t) => t.id === table2.id)?.status === "bill_requested", f.tables.find((t) => t.id === table2.id)?.status);
}

// 19. Card part payment on bill 1, then the split is locked.
const b1 = bill.checks[0]!;
const half = Math.floor(b1.balance / 2);
const partPay = await step("payments.record card part payment", () => reg.recordPayment(api, b1.id, { payment_id: idempotencyKey(), tender_type_id: cardTender.id, amount: half, reference: "T#1234" }, { expectedVersion: bill.version }), (r) => {
  const c = r.data.checks.find((x) => x.id === b1.id)!;
  return `paid ${c.paid_total}, balance ${c.balance}, locked ${c.locked}, pricing ${r.data.pricing_status}`;
});
if (partPay) {
  bill = partPay.data;
  const c = bill.checks.find((x) => x.id === b1.id)!;
  check("part payment applied and bill locked", c.paid_total === half && c.balance === b1.balance - half && c.locked && bill.pricing_status === "frozen");
}
// A double tap: the POS sends the same payment_id AND the same Idempotency-Key, so the register replays its first answer.
const dupId = idempotencyKey();
const first = await step("payments.record (idempotent id) first", () => reg.recordPayment(api, b1.id, { payment_id: dupId, tender_type_id: cardTender.id, amount: 100 }, { key: dupId }), (r) => `paid ${r.data.checks.find((x) => x.id === b1.id)!.paid_total}`);
if (first) bill = first.data;
const again = await step("payments.record (same id + same key) replay", () => reg.recordPayment(api, b1.id, { payment_id: dupId, tender_type_id: cardTender.id, amount: 100 }, { key: dupId }), (r) => `paid ${r.data.checks.find((x) => x.id === b1.id)!.paid_total}`);
if (first && again) check("double tap recorded once", again.data.checks.find((x) => x.id === b1.id)!.paid_total === first.data.checks.find((x) => x.id === b1.id)!.paid_total);
// With a new Idempotency-Key the same payment_id is refused outright (unique id), never recorded twice.
await expectError("payments.record (same id, new key)", () => reg.recordPayment(api, b1.id, { payment_id: dupId, tender_type_id: cardTender.id, amount: 100 }), "state_conflict");
bill = await reg.getOrder(api, billOrderId);
const lockedErr = await expectError("checks.split_even after a payment", () => reg.splitEven(api, billOrderId, 2, { expectedVersion: bill.version }), "invariant_violation");
if (lockedErr) check("split refusal names the paid bill", /Bill 1 is paid/.test(lockedErr.message), `${lockedErr.message} · ${lockedErr.remedy ?? ""} · details ${JSON.stringify(lockedErr.details ?? {})}`);
await expectError("payments.record card above the balance", () => reg.recordPayment(api, b1.id, { payment_id: idempotencyKey(), tender_type_id: cardTender.id, amount: bill.checks.find((x) => x.id === b1.id)!.balance + 1000 }), "validation");

// 20. Cash: dry run first (rounding and change from the register), then the real payment with the same figures.
const b1now = bill.checks.find((x) => x.id === b1.id)!;
const tendered = Math.ceil((b1now.balance + 1) / 1000) * 1000;
const dry = await step("payments.record dry_run cash", () => reg.recordPayment(api, b1.id, { payment_id: idempotencyKey(), tender_type_id: cashTender.id, amount: b1now.balance, tendered, dry_run: true }), (r) => `amount ${r.payment.amount}, rounding ${r.payment.rounding_cents}, tendered ${tendered}, change_due ${r.payment.change_due}`);
if (dry) {
  const after = await reg.getOrder(api, billOrderId);
  check("dry run recorded nothing", after.checks.find((x) => x.id === b1.id)!.paid_total === b1now.paid_total && after.version === bill.version, `paid ${after.checks.find((x) => x.id === b1.id)!.paid_total}`);
  check("rounding is a 5¢ step", Math.abs(dry.payment.rounding_cents ?? 0) <= 2, String(dry.payment.rounding_cents));
}
const cashPaid = await step("payments.record cash", () => reg.recordPayment(api, b1.id, { payment_id: idempotencyKey(), tender_type_id: cashTender.id, amount: b1now.balance, tendered }, { expectedVersion: bill.version }), (r) => {
  const c = r.data.checks.find((x) => x.id === b1.id)!;
  return `status ${c.status}, rounding ${c.rounding_total}, change_due ${r.payment.change_due}, order ${r.data.status}`;
});
if (cashPaid && dry) {
  bill = cashPaid.data;
  check("cash figures match the dry run", cashPaid.payment.change_due === dry.payment.change_due && cashPaid.payment.rounding_cents === dry.payment.rounding_cents);
  check("bill 1 paid", bill.checks.find((x) => x.id === b1.id)!.status === "paid");
}

// 21. The other bills by card; the order completes on its own (everything sent, every bill paid).
for (const c of bill.checks.filter((x) => x.status === "open")) {
  const paid = await step(`payments.record card ${c.label}`, () => reg.recordPayment(api, c.id, { payment_id: idempotencyKey(), tender_type_id: cardTender.id, amount: c.balance }, { expectedVersion: bill.version }), (r) => `${r.data.checks.find((x) => x.id === c.id)!.status}, order ${r.data.status}`);
  if (paid) bill = paid.data;
}
check("order auto-completed", bill.status === "completed", bill.status);
{
  const f = await reg.getFloor(api, station.outlet_id);
  const t = f.tables.find((x) => x.id === table2.id)!;
  check("table free (or paid) after completion", t.status === "free" || t.status === "paid", t.status);
}

// 22. Receipts and documents.
const qr = await step("receipts.send qr", () => reg.sendReceipt(api, b1.id, "qr"), (r) => `${r.data.url} (${r.data.delivery_status})`);
if (qr) check("receipt url is absolute", /^https?:\/\//.test(qr.data.url), qr.data.url);
await step("receipts.send email (not configured → warning)", () => reg.sendReceipt(api, b1.id, "email", "guest@example.com"), (r) => `${r.data.delivery_status}; warnings: ${r.warnings.join("; ") || "none"}`);
await step("receipts.print", () => reg.printReceipt(api, b1.id), (jobs) => `${jobs.length} job(s) on ${jobs[0]?.printer_name ?? "—"}`);
const b2 = bill.checks[1]!;
const invoice = await step("documents.issue_invoice bill 2", () => reg.issueInvoice(api, b2.id), (i) => `${i.invoice_no} reused ${i.reused} ${i.pdf_url}`);
const invoiceAgain = await step("documents.issue_invoice bill 2 again", () => reg.issueInvoice(api, b2.id), (i) => `${i.invoice_no} reused ${i.reused}`);
if (invoice && invoiceAgain) check("same invoice number on reissue", invoice.invoice_no === invoiceAgain.invoice_no);

// 23. Refund by line on bill 2 (invoiced → credit note): Cashier is below Manager, so a manager override.
const b2Line = bill.checks.find((x) => x.id === b2.id)!.allocations[0]!;
const quote = await step("refunds.quote lines", () => reg.quoteRefund(api, b2.id, { kind: "lines", lines: [{ line_id: b2Line.line_id, quantity: 1 }] }), (q) => `total ${q.totals.total} (tax ${q.totals.tax}), tenders ${q.tenders.map((t) => `${t.tender}=${t.amount}${t.rounding_cents ? `±${t.rounding_cents}` : ""}`).join(" ")}, cash_out ${q.cash_out}`);
if (quote) {
  await expectError("refunds.create as Cashier", () => reg.createRefund(api, b2.id, { refund_id: idempotencyKey(), request: { kind: "lines", lines: [{ line_id: b2Line.line_id, quantity: 1 }] }, reason: "Guest complaint" }), "permission_denied");
  const rGrant = await step("overrides.grant refunds.create (check)", () => reg.grantOverride(api, { action: "refunds.create", target_kind: "check", target_id: b2.id, args: { request: { kind: "lines", lines: [{ line_id: b2Line.line_id, quantity: 1 }] }, total: quote.totals.total }, approver_pin: "222222" }), (g) => `by ${g.approver.name}, quoted ${String(g.args.total)}`);
  if (rGrant) {
    check("the approval carries the register's quote", rGrant.args.total === quote.totals.total, `${String(rGrant.args.total)} vs ${quote.totals.total}`);
    await expectError("refunds.create full under a one-line approval", () => reg.createRefund(api, b2.id, { refund_id: idempotencyKey(), request: { kind: "full" }, reason: "Guest complaint" }, { overrideId: rGrant.override_id }), "permission_denied");
    const refunded = await step("refunds.create with override", () => reg.createRefund(api, b2.id, { refund_id: idempotencyKey(), request: { kind: "lines", lines: [{ line_id: b2Line.line_id, quantity: 1 }] }, reason: "Guest complaint", print: true }, { overrideId: rGrant.override_id }), (r) => `${r.refund.refund_receipt_no} credit note ${r.refund.credit_note_no ?? "—"} total ${r.refund.totals.total}; bill ${r.data.checks.find((x) => x.id === b2.id)!.status}`);
    if (refunded) {
      bill = refunded.data;
      check("refund total matches the quote", refunded.refund.totals.total === quote.totals.total);
      check("credit note issued for the invoiced bill", Boolean(refunded.refund.credit_note_no), refunded.refund.credit_note_no ?? "none");
      await step("refunds.list", () => reg.listRefunds(api, billOrderId), (rs) => `${rs.length} refund(s)`);
      await step("refunds.print_receipt", () => reg.printRefundReceipt(api, refunded.refund.id), (jobs) => `${jobs.length} job(s)`);
    }
  }
}

// 24. Reopen (Manager+, same day) with an override, then complete again. An order that already has a refund cannot be
// reopened (reversing its payments would double-count the refund), so the refunded order is refused and a fresh
// takeaway order exercises the reopen flow.
await expectError("orders.reopen as Cashier", () => reg.reopenOrder(api, billOrderId, "Closed by mistake"), "permission_denied");
const refundedGrant = await step("overrides.grant orders.reopen (refunded order)", () => reg.grantOverride(api, { action: "orders.reopen", target_kind: "order", target_id: billOrderId, args: {}, approver_pin: "222222" }));
if (refundedGrant) {
  const refused = await expectError("orders.reopen of a refunded order", () => reg.reopenOrder(api, billOrderId, "Closed by mistake", { overrideId: refundedGrant.override_id }), "invariant_violation");
  if (refused) check("refusal names the refund", (refused.details as { invariant?: string } | undefined)?.invariant === "order_has_refunds", JSON.stringify(refused.details));
}
{
  const reopenOrderId = idempotencyKey();
  const openedTa = await step("orders.open takeaway (for reopen)", () => reg.openOrder(api, { order_id: reopenOrderId, order_type: "takeaway", takeaway_ref: "Reopen" }), (r) => r.data.order_no);
  if (openedTa) {
    let ro = (await reg.addLines(api, reopenOrderId, [{ line_id: idempotencyKey(), product_id: kopi.id, quantity: 1 }])).data;
    ro = (await reg.fireOrder(api, reopenOrderId)).data;
    const roBill = ro.checks[0]!;
    const roPaid = await step("payments.record card (for reopen)", () => reg.recordPayment(api, roBill.id, { payment_id: idempotencyKey(), tender_type_id: cardTender.id, amount: roBill.balance }), (r) => `order ${r.data.status}`);
    if (roPaid) ro = roPaid.data;
    const reopenGrant = await step("overrides.grant orders.reopen", () => reg.grantOverride(api, { action: "orders.reopen", target_kind: "order", target_id: reopenOrderId, args: {}, approver_pin: "222222" }));
    if (reopenGrant) {
      const reopened = await step("orders.reopen with override", () => reg.reopenOrder(api, reopenOrderId, "Closed by mistake", { overrideId: reopenGrant.override_id }), (r) => `status ${r.data.status}, balance ${r.data.balance}, bills ${r.data.checks.map((c) => `${c.label}=${c.status}`).join(" ")}`);
      if (reopened) {
        ro = reopened.data;
        // Reopening reverses the payments: every bill is open again and must be paid once more.
        check("reopen reversed the payments", ro.balance === ro.totals.total && ro.checks.every((c) => c.status === "open"), `balance ${ro.balance} of ${ro.totals.total}`);
        await expectError("orders.complete with a balance", () => reg.completeOrder(api, reopenOrderId, { expectedVersion: ro.version }), "invariant_violation");
        for (const c of ro.checks.filter((x) => x.status === "open")) {
          const paid = await step(`payments.record card ${c.label} (after reopen)`, () => reg.recordPayment(api, c.id, { payment_id: idempotencyKey(), tender_type_id: cardTender.id, amount: c.balance }, { expectedVersion: ro.version }), (r) => `order ${r.data.status}`);
          if (paid) ro = paid.data;
        }
        check("order completed again", ro.status === "completed", ro.status);
      }
    }
  }
}

// 25. Shift: open with a float, close with a blind count. Expected cash = float + cash payments + rounding − cash refunds, from the register.
const openShifts = await step("shifts.list open (before)", () => reg.listShifts(api, station.outlet_id, { status: "open" }), (ss) => `${ss.length} open`);
for (const s of openShifts ?? []) if (s.station_id === station.id) await step("shifts.close (stale open shift)", () => reg.closeShift(api, s.id, { counted_cash_cents: s.float_cents, variance_reason: "Smoke: closing a shift left open" }));
const shift = await step("shifts.open float $200 by denomination", () => reg.openShift(api, { float_cents: 20000, float_counts: { "5000": 2, "1000": 10 } }), (s) => `${s.id.slice(0, 8)} station ${s.station_id?.slice(0, 8)} float ${s.float_cents} ${s.business_date}`);
if (shift) {
  check("shift station inferred from the PIN session", shift.station_id === station.id);
  // A cash sale on this shift, so expected cash moves: a takeaway Kopi paid in cash.
  const ta2 = await reg.openOrder(api, { order_id: idempotencyKey(), order_type: "takeaway" });
  const ta2Lines = await reg.addLines(api, ta2.data.id, [{ line_id: idempotencyKey(), product_id: kopi.id, quantity: 1 }], { expectedVersion: ta2.data.version });
  const ta2Fired = await reg.fireOrder(api, ta2.data.id, {}, { expectedVersion: ta2Lines.data.version });
  const ta2Check = ta2Fired.data.checks[0]!;
  const ta2Paid = await step("payments.record cash (shift sale)", () => reg.recordPayment(api, ta2Check.id, { payment_id: idempotencyKey(), tender_type_id: cashTender.id, amount: ta2Check.balance, tendered: 1000 }, { expectedVersion: ta2Fired.data.version }), (r) => `amount ${r.payment.amount}, rounding ${r.payment.rounding_cents}, change ${r.payment.change_due}, order ${r.data.status}`);
  await expectError("shifts.close an empty drawer without a variance reason", () => reg.closeShift(api, shift.id, { counted_cash_cents: 0 }), "validation");
  const dryClose = await step("shifts.close dry_run (count before expected)", () => reg.closeShift(api, shift.id, { counted_cash_cents: 20000, dry_run: true }), (r) => `expected ${r.data.report.cash.expected} = float ${r.data.report.cash.float} + cash ${r.data.report.cash.cash_payments} + rounding ${r.data.report.cash.rounding} − refunds ${r.data.report.cash.refunds}; variance ${r.data.report.cash.variance}`);
  if (dryClose && ta2Paid) {
    const c = dryClose.data.report.cash;
    check("expected cash includes the sale and its rounding", c.expected === c.float + c.cash_payments + c.rounding + c.tips - c.refunds && c.cash_payments >= (ta2Paid.payment.amount ?? 0));
    const still = await reg.listShifts(api, station.outlet_id, { status: "open" });
    check("dry run left the shift open", still.some((s) => s.id === shift.id));
    const closed = await step("shifts.close counted = expected", () => reg.closeShift(api, shift.id, { counted_cash_cents: c.expected, counted_counts: null }), (r) => `status ${r.data.status}, expected ${r.data.expected_cash_cents}, counted ${r.data.counted_cash_cents}, variance ${r.data.variance_cents}; tenders ${r.data.report.tenders.map((t) => `${t.tender}=${t.amount}`).join(" ")}`);
    if (closed) check("variance zero", closed.data.variance_cents === 0 && closed.data.report.cash.variance === 0);
  }
}
await step("business_days.z_report (station)", () => reg.getZReport(api, station.outlet_id, { station_id: station.id }), (z) => `${z.scope.business_date}: net ${z.sales.net}, ${z.orders.count} orders / ${z.orders.covers} covers, tenders ${z.tenders.map((t) => `${t.tender}=${t.amount}`).join(" ")}, cash expected ${z.cash.expected} counted ${z.cash.counted}, voids ${z.voids.count}, refunds ${z.refunds.count}=${z.refunds.amount}`);
await step("business_days.z_report (outlet)", () => reg.getZReport(api, station.outlet_id), (z) => `net ${z.sales.net}, open ${z.orders.open_count}`);
await expectError("business_days.close as Cashier", () => reg.closeBusinessDay(api, station.outlet_id), "permission_denied");

// 26. Late print jobs: no relay, so the kitchen tickets from step 16 pass 10 s unprinted. Reroute them to the backup.
if (kitchen) {
  const wait = Math.max(0, 11_000 - (Date.now() - firedAt));
  if (wait) {
    console.log(`  …     waiting ${Math.ceil(wait / 1000)} s for the tickets to count as late`);
    await sleep(wait);
  }
  const late = await step("print_jobs.list late=true", () => reg.listPrintJobs(api, station.outlet_id, { late: true }), (js) => `${js.length} late: ${[...new Set(js.map((j) => `${j.kind} ${j.status}`))].join(", ")}; oldest ${Math.max(0, ...js.map((j) => j.age_seconds))}s`);
  const withBackup = new Set((printersNow ?? []).filter((p) => p.role === "kitchen" && p.backup_printer_id).map((p) => p.id));
  const kitchenLate = (late ?? []).filter((j) => j.kind === "kitchen" && withBackup.has(j.printer_id));
  check("kitchen tickets are late on a printer with a backup", kitchenLate.length > 0, `${kitchenLate.length} of ${(late ?? []).filter((j) => j.kind === "kitchen").length} kitchen tickets`);
  const forOrder = await step("print_jobs.list order_id", () => reg.listPrintJobs(api, station.outlet_id, { order_id: billOrderId }), (js) => `${js.length} jobs for the order: ${[...new Set(js.map((j) => j.kind))].join(", ")}`);
  void forOrder;
  if (kitchenLate.length) {
    const rerouted = await step("print_jobs.reroute → backup", () => reg.rerouteJobs(api, kitchenLate.map((j) => j.id)), (cs) => cs.map((c) => `${c.kind} → ${c.printer_name}`).join(", "));
    if (rerouted) check("rerouted to the Pass printer", rerouted.every((c) => c.printer_name === "Pass printer"));
    const lateAfter = await reg.listPrintJobs(api, station.outlet_id, { late: true });
    check("rerouted tickets no longer late on the kitchen printer", kitchenLate.every((j) => !lateAfter.some((l) => l.id === j.id)), `${kitchenLate.filter((j) => lateAfter.some((l) => l.id === j.id)).length} still waiting`);
    await step("print_jobs.reprint", () => reg.reprintJob(api, kitchenLate[0]!.id), (cs) => cs.map((c) => `${c.kind} on ${c.printer_name}`).join(", "));
  }
}

// 27. Scan to Order: seat a table, a guest session from its rotated QR token, a round (the demo holds QR orders), accept it; a table request, acknowledged.
const floor3 = await reg.getFloor(api, station.outlet_id);
const qrTable = floor3.tables.find((t) => t.status === "free")!;
const seated = await step("orders.open dine-in (QR table)", () => reg.openOrder(api, { order_id: idempotencyKey(), order_type: "dine_in", table_id: qrTable.id, pax: 2 }), (r) => `${r.data.order_no} on table ${qrTable.name}`);
const rotated = await adminJson<{ data: { url: string } }>(`/v1/tables/${qrTable.id}/qr/rotate`, {}, admin.token).catch((e) => (fail("tables.rotate_qr_token", e), null));
if (rotated) {
  ok("tables.rotate_qr_token", rotated.data.url);
  const qrToken = rotated.data.url.split("/").pop()!;
  const guest = await adminJson<{ data: { guest_token: string; table: { name: string }; hold_orders: boolean; can_order: boolean; service_requests: string[] } }>("/v1/guest/sessions", { token: qrToken, device_id: `smoke-${idempotencyKey().slice(0, 8)}`, guest_name: "Wei" }).catch((e) => (fail("guest_sessions.create", e), null));
  if (guest) {
    ok("guest_sessions.create", `table ${guest.data.table.name}, hold_orders ${guest.data.hold_orders}, can_order ${guest.data.can_order}`);
    const roundId = idempotencyKey();
    const round = await adminJson<{ data: { round_id: string; status: string } }>("/v1/guest/rounds", { round_id: roundId, lines: [{ line_id: idempotencyKey(), product_id: kopi.id, quantity: 2, notes: "Less sugar" }] }, guest.data.guest_token).catch((e) => (fail("rounds.submit (guest)", e), null));
    if (round) {
      ok("rounds.submit (guest)", `status ${round.data.status}`);
      const pending = await step("rounds.list pending", () => reg.listPendingRounds(api, station.outlet_id), (rs) => rs.map((r) => `${r.table_name}: ${r.lines.map((l) => `${l.quantity} ${l.name}`).join(", ")}`).join(" | "));
      const mine = pending?.find((r) => r.id === roundId);
      check("the round is pending with its table and lines", Boolean(mine && mine.table_name === qrTable.name && mine.lines.length === 1 && mine.lines[0]!.quantity === 2), mine ? `${mine.status} ${mine.table_name}` : "not listed");
      if (mine) {
        const before = await reg.getOrder(api, mine.order_id);
        check("guest lines carry source=guest and the round id", before.lines.filter((l) => l.round_id === roundId).every((l) => l.source === "guest"), before.lines.map((l) => `${l.source}/${l.status}`).join(","));
        const floorPending = (await reg.getFloor(api, station.outlet_id)).tables.find((t) => t.id === qrTable.id);
        check("floor shows pending_rounds on the table", (floorPending?.order?.pending_rounds ?? 0) > 0, String(floorPending?.order?.pending_rounds));
        const accepted = await step("rounds.accept", () => reg.acceptRound(api, roundId), (r) => `order ${r.data.status}, lines ${r.data.lines.filter((l) => l.round_id === roundId).map((l) => l.status).join(",")}${r.warnings.length ? `; warnings: ${r.warnings.join("; ")}` : ""}`);
        if (accepted) {
          check("accepted round lines are sent", accepted.data.lines.filter((l) => l.round_id === roundId).every((l) => l.status === "fired"));
          const stillPending = await reg.listPendingRounds(api, station.outlet_id);
          check("round no longer pending", !stillPending.some((r) => r.id === roundId));
        }
        // A second round from another phone at the table (one phone is rate-limited to a round every 10 s), rejected with a reason: its lines are voided.
        const guest2 = await adminJson<{ data: { guest_token: string } }>("/v1/guest/sessions", { token: qrToken, device_id: `smoke-${idempotencyKey().slice(0, 8)}` }).catch((e) => (fail("guest_sessions.create #2", e), null));
        const round2 = idempotencyKey();
        const r2 = guest2 ? await adminJson<{ data: { status: string } }>("/v1/guest/rounds", { round_id: round2, lines: [{ line_id: idempotencyKey(), product_id: satay.id, quantity: 1 }] }, guest2.data.guest_token).catch((e) => (fail("rounds.submit #2 (guest)", e), null)) : null;
        if (r2) {
          const rejected = await step("rounds.reject", () => reg.rejectRound(api, round2, "Sold out"), (r) => `lines ${r.data.lines.filter((l) => l.round_id === round2).map((l) => `${l.status} (${l.void_reason})`).join(",")}`);
          if (rejected) check("rejected lines voided with the reason", rejected.data.lines.filter((l) => l.round_id === round2).every((l) => l.status === "voided" && (l.void_reason ?? "").includes("Sold out")));
        }
        // Table request → Now rail → Done.
        const requestType = guest.data.service_requests[0] ?? "call_for_bill";
        const req = await adminJson<{ data: { id: string; type: string } }>("/v1/guest/requests", { type: requestType }, guest.data.guest_token).catch((e) => (fail("service_requests.create (guest)", e), null));
        if (req) {
          ok("service_requests.create (guest)", req.data.type);
          const openReqs = await step("service_requests.list open", () => reg.listOpenServiceRequests(api, station.outlet_id), (rs) => rs.map((r) => `${r.table_name}: ${r.type}`).join(", "));
          check("request listed with its table", Boolean(openReqs?.some((r) => r.id === req.data.id && r.table_name === qrTable.name)));
          const fl = (await reg.getFloor(api, station.outlet_id)).tables.find((t) => t.id === qrTable.id);
          check("floor shows requests_waiting", (fl?.requests_waiting ?? 0) > 0, String(fl?.requests_waiting));
          const acked = await step("service_requests.acknowledge", () => reg.acknowledgeServiceRequest(api, req.data.id), (r) => `${r.status} by ${r.acknowledged_by}`);
          if (acked) {
            const after = await reg.listOpenServiceRequests(api, station.outlet_id);
            check("request no longer open", !after.some((r) => r.id === req.data.id));
          }
        }
        check("round landed on the seated order", Boolean(seated && mine.order_id === seated.data.id));
        // Settle the QR order so the table is free again: pay the one bill by card.
        const qrOrder = await reg.getOrder(api, mine.order_id);
        const qrCheck = qrOrder.checks[0];
        if (qrCheck && qrCheck.balance > 0) await step("payments.record card (QR order)", () => reg.recordPayment(api, qrCheck.id, { payment_id: idempotencyKey(), tender_type_id: cardTender.id, amount: qrCheck.balance }, { expectedVersion: qrOrder.version }), (r) => `order ${r.data.status}`);
      }
    }
  }
}

await step("staff_sessions.end (Cashier)", () => reg.endSession(api));

console.log(failures ? `\n${failures} step(s) failed` : "\nAll steps passed");
process.exit(failures ? 1 : 0);
