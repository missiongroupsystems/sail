import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SEED_RULE_IDS } from "@sail/shared";
import type { Principal } from "../src/auth/principal.js";
import { withTransaction } from "../src/db/client.js";
import { consumeOverride } from "../src/services/overrides.js";
import type { TestDb } from "./helpers.js";
import { bootWorld, orderHelpers, type Call, type Snap, type World } from "./world.js";

/**
 * Manager approval (scope doc 7.1 rule 9): a grant authorises exactly what the
 * approver was shown, for the staff session that asked, once.
 */
let db: TestDb;
let call: Call;
let w: World;
let h: ReturnType<typeof orderHelpers>;

beforeAll(async () => {
  ({ db, call, w } = await bootWorld());
  h = orderHelpers(call, w);
});
afterAll(async () => db.drop());

type Grant = { data: { override_id: string; args: Record<string, unknown>; approver: { role: string } }; code?: string };
const DIFFERENT = "Manager approval was for a different action";
const SOMEONE_ELSE = "Manager approval was given to someone else";
const grant = (token: string, action: string, targetKind: string, targetId: string, pin: string, args: Record<string, unknown>) => call<Grant>("POST", "/v1/overrides", { token, body: { action, target_kind: targetKind, target_id: targetId, approver_pin: pin, args } });
const quoted = async (checkId: string, request: Record<string, unknown>) => (await call<{ data: { totals: { total: number } } }>("POST", `/v1/checks/${checkId}/refunds/quote`, { token: w.pins.manager, body: { request } })).body.data.totals.total;
const refund = (token: string, checkId: string, request: Record<string, unknown>, overrideId: string) => call<{ refund: { totals: { total: number } }; code?: string; message?: string }>("POST", `/v1/checks/${checkId}/refunds`, { token, body: { refund_id: randomUUID(), request, reason: "Complaint", override_id: overrideId } });
const applyRule = (token: string, orderId: string, ruleKey: string, lineIds: string[], overrideId: string | undefined, applicationId: string = randomUUID()) => call<{ data: Snap; code?: string; message?: string }>("POST", `/v1/orders/${orderId}/adjustments`, { token, body: { application_id: applicationId, rule_key: ruleKey, reason: "Regular", line_ids: lineIds, override_id: overrideId } });
const voidLine = (token: string, orderId: string, lineId: string, quantity: number | undefined, overrideId: string) => call<{ data: Snap; code?: string; message?: string }>("POST", `/v1/orders/${orderId}/lines/${lineId}/void`, { token, body: { reason_id: w.ids.voidReason, quantity, override_id: overrideId } });

describe("a manager approval is bound to what the manager approved", () => {
  it("a cashier's PIN cannot approve a Manager comp, and a manager's approval covers only that rule and those lines", async () => {
    const s = await h.orderWith(w.pins.server, [{ product_id: w.ids.wine }, { product_id: w.ids.kopi }]);
    const [wine, kopi] = s.lines;
    const args = { rule_key: SEED_RULE_IDS.managerComp, entered_value: null, line_ids: [wine!.id] };
    const byCashier = await grant(w.pins.server, "adjustments.apply_manual", "order", s.id, "333333", args);
    expect(byCashier.status).toBe(403);
    expect(byCashier.body).toMatchObject({ details: { required_role: "manager" } });
    const g = await grant(w.pins.server, "adjustments.apply_manual", "order", s.id, "222222", args);
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    expect((await applyRule(w.pins.server, s.id, SEED_RULE_IDS.managerComp, [kopi!.id], g.body.data.override_id)).body).toMatchObject({ code: "permission_denied", message: DIFFERENT });
    expect((await applyRule(w.pins.server, s.id, SEED_RULE_IDS.staffMeal, [wine!.id], g.body.data.override_id)).body).toMatchObject({ code: "permission_denied", message: DIFFERENT });
    const ok = await applyRule(w.pins.server, s.id, SEED_RULE_IDS.managerComp, [wine!.id], g.body.data.override_id);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.totals.total).toBeLessThan(s.totals.total);
  });

  it("a rule that does not allow manager approval cannot be approved", async () => {
    const created = await call("POST", "/v1/pricing-rules", { token: w.m.admin.token, body: { rule_key: "manual:owner-only", body: { kind: "discount", name: "Owner's comp", calc: "percent", level: "line", value: { type: "fixed", amount: 10_000 }, scope: { type: "all" }, priority: 5, application: "manual", min_role: "admin", override_allowed: false, reason_required: false, report_class: "comp" }, effective_from: "2026-01-01T00:00:00Z" } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const s = await h.orderWith(w.pins.server, [{ product_id: w.ids.kopi }]);
    const g = await grant(w.pins.server, "adjustments.apply_manual", "order", s.id, "111111", { rule_key: "manual:owner-only", entered_value: null, line_ids: null });
    expect(g.status).toBe(403);
  });

  it("a refund approval is for the refund the manager saw: its request and the quoted total", async () => {
    const s = await h.paidOrder(w.pins.cashier, [{ product_id: w.ids.wine }, { product_id: w.ids.kopi }]);
    const check = s.checks[0]!;
    const kopi = s.lines.find((l) => l.status !== "voided" && l.quantity === 1 && l.id !== s.lines[0]!.id)!;
    const request = { kind: "lines", lines: [{ line_id: kopi.id, quantity: 1 }] };
    const total = await quoted(check.id, request);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(check.totals.total);
    // A total the register does not agree with is refused at approval.
    const stale = await grant(w.pins.cashier, "refunds.create", "check", check.id, "222222", { request, total: total + 100 });
    expect(stale.body).toMatchObject({ code: "state_conflict" });
    const g = await grant(w.pins.cashier, "refunds.create", "check", check.id, "222222", { request, total });
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    const full = await refund(w.pins.cashier, check.id, { kind: "full" }, g.body.data.override_id);
    expect(full.body).toMatchObject({ code: "permission_denied", message: DIFFERENT });
    const ok = await refund(w.pins.cashier, check.id, request, g.body.data.override_id);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.refund.totals.total).toBe(total);
  });

  it("a void approval covers the quantity approved; an open-price approval covers that price; a payment approval covers that payment", async () => {
    const s = await h.orderWith(w.pins.server, [{ product_id: w.ids.kopi, quantity: 3 }]);
    await h.fire(w.pins.server, s.id);
    const line = s.lines[0]!;
    const g = await grant(w.pins.server, "lines.void_fired", "order_line", line.id, "222222", { quantity: 1 });
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    expect((await voidLine(w.pins.server, s.id, line.id, 3, g.body.data.override_id)).body).toMatchObject({ message: DIFFERENT });
    expect((await voidLine(w.pins.server, s.id, line.id, undefined, g.body.data.override_id)).body).toMatchObject({ message: DIFFERENT });
    expect((await voidLine(w.pins.server, s.id, line.id, 1, g.body.data.override_id)).status).toBe(200);

    const lineId = randomUUID();
    const op = await grant(w.pins.server, "lines.add_open_price", "order", s.id, "222222", { lines: [{ line_id: lineId, product_id: w.ids.openItem, quantity: 1, open_price: 2500 }] });
    expect(op.status, JSON.stringify(op.body)).toBe(201);
    expect((await h.add(w.pins.server, s.id, [{ line_id: lineId, product_id: w.ids.openItem, open_price: 9900 }], { override_id: op.body.data.override_id })).body).toMatchObject({ message: DIFFERENT });
    expect((await h.add(w.pins.server, s.id, [{ line_id: lineId, product_id: w.ids.openItem, open_price: 2500 }], { override_id: op.body.data.override_id })).status).toBe(200);

    const now = (await call<{ data: Snap }>("GET", `/v1/orders/${s.id}`, { token: w.pins.server })).body.data;
    const check = now.checks[0]!;
    const pg = await grant(w.pins.server, "payments.record", "order", s.id, "333333", { check_id: check.id, tender_type_id: w.ids.card, amount: 100, tip_cents: 0 });
    expect(pg.status, JSON.stringify(pg.body)).toBe(201);
    expect((await h.pay(w.pins.server, check.id, { tender_type_id: w.ids.card, amount: check.balance, override_id: pg.body.data.override_id })).body).toMatchObject({ message: DIFFERENT });
    expect((await h.pay(w.pins.server, check.id, { tender_type_id: w.ids.card, amount: 100, override_id: pg.body.data.override_id })).status).toBe(200);
  });
});

describe("removing a discount needs the rule's own role", () => {
  it("is bound to that application, and still applies once the rule is archived", async () => {
    const s = await h.orderWith(w.pins.cashier, [{ product_id: w.ids.wine }]);
    const appId = randomUUID();
    expect((await applyRule(w.pins.manager, s.id, SEED_RULE_IDS.managerComp, [s.lines[0]!.id], undefined, appId)).status).toBe(200);
    const other = randomUUID();
    const wrong = await grant(w.pins.cashier, "adjustments.remove", "order", s.id, "222222", { application_id: other });
    expect(wrong.status).toBe(404);
    const byCashier = await grant(w.pins.server, "adjustments.remove", "order", s.id, "333333", { application_id: appId });
    expect(byCashier.body).toMatchObject({ details: { required_role: "manager" } });
    expect((await call("POST", `/v1/pricing-rules/${encodeURIComponent(SEED_RULE_IDS.managerComp)}/archive`, { token: w.m.admin.token, body: {} })).status).toBeLessThan(300);
    const remove = (token: string, overrideId?: string) => call<{ code?: string }>("DELETE", `/v1/orders/${s.id}/adjustments/${appId}`, { token, body: { override_id: overrideId } });
    expect((await remove(w.pins.cashier)).body).toMatchObject({ code: "permission_denied", details: { required_role: "manager" } });
    const g = await grant(w.pins.cashier, "adjustments.remove", "order", s.id, "222222", { application_id: appId });
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    expect((await remove(w.pins.cashier, g.body.data.override_id)).status).toBe(200);
  });
});

describe("a manager approval belongs to the staff session that asked for it", () => {
  it("another staff member, or the same person in another sign-in, cannot spend it", async () => {
    const s = await h.paidOrder(w.pins.cashier, [{ product_id: w.ids.wine }]);
    const check = s.checks[0]!;
    const g = await grant(w.pins.cashier, "refunds.create", "check", check.id, "222222", { request: { kind: "full" }, total: await quoted(check.id, { kind: "full" }) });
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    expect((await refund(w.pins.cashierStation2, check.id, { kind: "full" }, g.body.data.override_id)).body).toMatchObject({ message: SOMEONE_ELSE });
    expect((await refund(w.pins.server, check.id, { kind: "full" }, g.body.data.override_id)).body).toMatchObject({ message: SOMEONE_ELSE });
    // The same person signed in again at the same station is a different session.
    const again = await call<{ data: { session_token: string } }>("POST", "/v1/stations/sessions", { token: w.stationToken, body: { pin: "333333" } });
    expect((await refund(again.body.data.session_token, check.id, { kind: "full" }, g.body.data.override_id)).body).toMatchObject({ message: SOMEONE_ELSE });
    expect((await refund(w.pins.cashier, check.id, { kind: "full" }, g.body.data.override_id)).status).toBe(201);
  });

  it("the grant id is never on the event log or in the audit trail before it is used", async () => {
    const s = await h.paidOrder(w.pins.cashier, [{ product_id: w.ids.kopi }]);
    const g = await grant(w.pins.server, "refunds.create", "check", s.checks[0]!.id, "222222", { request: { kind: "full" }, total: await quoted(s.checks[0]!.id, { kind: "full" }) });
    expect(g.status).toBe(201);
    const ev = await call<{ data: { type: string; payload: Record<string, unknown>; approval: Record<string, unknown> | null }[] }>("GET", `/v1/outlets/${w.m.outletId}/events?types=override.granted&limit=1000`, { token: w.station2Token });
    expect(ev.status).toBe(200);
    expect(ev.body.data.length).toBeGreaterThan(0);
    expect(JSON.stringify(ev.body)).not.toContain(g.body.data.override_id);
    const [audit] = await db.sql<{ n: number }[]>`select count(*)::int as n from audit_log where override_id = ${g.body.data.override_id} or details::text like ${"%" + g.body.data.override_id + "%"}`;
    expect(audit!.n).toBe(0);
  });

  it("of two transactions that both read a grant as unused, only the first to write spends it", async () => {
    const s = await h.orderWith(w.pins.server, [{ product_id: w.ids.kopi }]);
    const g = await grant(w.pins.server, "orders.reopen", "order", s.id, "222222", {});
    expect(g.status).toBe(201);
    const [row] = await db.sql<{ requester_id: string; requester_session_id: string; station_id: string }[]>`select requester_id, requester_session_id, station_id from overrides where id = ${g.body.data.override_id}`;
    const requester: Principal = { type: "staff", id: row!.requester_id, merchantId: w.m.merchantId, role: "server", name: "Sam Server", outletIds: [], brandIds: [], stationId: row!.station_id, sessionId: row!.requester_session_id, outletId: w.m.outletId, riskCeiling: null, via: "pin" };
    const want = { action: "orders.reopen", targetId: s.id, required: "manager" as const, args: {} };
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let firstDone!: () => void;
    const consumed = new Promise<void>((r) => (firstDone = r));
    const first = withTransaction(async () => {
      await consumeOverride(g.body.data.override_id, want, requester);
      firstDone();
      await held; // keep the first transaction open: its write is not yet visible
    });
    await consumed;
    const second = withTransaction(() => consumeOverride(g.body.data.override_id, want, requester));
    await new Promise((r) => setTimeout(r, 200)); // the second has read the row as unused and waits on the first's row lock
    release();
    await first;
    await expect(second).rejects.toMatchObject({ code: "permission_denied", message: "Manager approval is missing, used or expired" });
  });

  it("a grant is used once, even by two requests at the same time", async () => {
    const s = await h.orderWith(w.pins.server, [{ product_id: w.ids.kopi, quantity: 2 }]);
    await h.fire(w.pins.server, s.id);
    const line = s.lines[0]!;
    const g = await grant(w.pins.server, "lines.void_fired", "order_line", line.id, "222222", { quantity: 1 });
    expect(g.status).toBe(201);
    const both = await Promise.all([voidLine(w.pins.server, s.id, line.id, 1, g.body.data.override_id), voidLine(w.pins.server, s.id, line.id, 1, g.body.data.override_id)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 403]);
  });
});
