import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/modules.js";
import { buildApp, type App } from "../src/app.js";
import { drainPaymentOutbox, expireIntents, OUTBOX_MAX_ATTEMPTS, pollPendingIntents } from "../src/services/payment-intents.js";
import { SIMULATOR_SIGNATURE_HEADER, signSimulatorWebhook, simulatorProvider } from "../src/payments/simulator.js";
import { startSimulator, type Delivery, type Simulator } from "../scripts/payment-simulator.js";
import { api, freshDb, seedMerchant, settleOpenOrders, type TestDb } from "./helpers.js";

/**
 * Terminal payments end to end against the simulator: the register never calls the provider inside a request, an
 * approval is recorded exactly once through the ordinary payment path, and money it cannot apply is given back.
 */
let db: TestDb;
let app: App;
let call: ReturnType<typeof api>["call"];
let sim: Simulator;

const post = (d: Delivery) => app.request(new URL(d.url).pathname, { method: "POST", headers: d.headers, body: d.body });

beforeAll(async () => {
  sim = await startSimulator({ auto: false, deliver: async (d) => void (await post(d)) });
  // Room for 20 requests at once, so the concurrency test is decided by the register, not by the admission gate.
  db = await freshDb({ PAYMENT_SIMULATOR_URL: sim.url, TX_MAX: "8", QUEUE_MAX: "40", DB_POOL_MAX: "12" });
  app = buildApp();
  call = api(app).call;
});
afterAll(async () => {
  await sim.stop();
  await db.drop();
});

type Payment = { id: string; tender: string; amount: number; rounding_cents: number; tip_cents: number; reference: string | null; status: string };
type Check = { id: string; status: string; balance: number; paid_total: number; totals: { total: number }; payments: Payment[] };
type Snap = { id: string; version: number; status: string; pricing_status: string; balance: number; checks: Check[] };
type Intent = { id: string; state: string; outcome_reason: string | null; amount: number; tip_cents: number; payment_id: string | null; provider_ref: string | null; void_requested_at: string | null; provider_voided_at: string | null };
type Err = { code?: string; message?: string; details?: Record<string, unknown> };

async function merchant(name: string, opts: { currency?: string; rounding?: number | null; price?: number } = {}) {
  const m = await seedMerchant(db.sql, name, { preset: "blank", timeZone: "Europe/London", currency: opts.currency ?? "GBP", locale: "en-GB", cashRoundingIncrement: opts.rounding ?? null });
  const t = m.admin.token;
  const ids = { item: randomUUID(), side: randomUUID(), menu: randomUUID(), link: randomUUID(), cash: randomUUID(), card: randomUUID(), terminal: randomUUID() };
  const must = async (method: string, path: string, body: unknown) => {
    const r = await call(method, path, { token: t, body });
    if (r.status >= 300) throw new Error(`${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  };
  await must("POST", "/v1/products", { id: ids.item, name: "Set lunch", price: opts.price ?? 1234 });
  await must("POST", "/v1/products", { id: ids.side, name: "Side", price: 250 });
  await must("POST", "/v1/menus", { id: ids.menu, brand_id: m.brandId, name: "M", sections: [{ name: "All", items: [{ product_id: ids.item }, { product_id: ids.side }] }] });
  await must("POST", "/v1/channel-links", { id: ids.link, channel: "pos", outlet_id: m.outletId, brand_id: m.brandId, menu_id: ids.menu });
  await must("POST", "/v1/tender-types", { id: ids.cash, name: "Cash", is_cash: true });
  await must("POST", "/v1/tender-types", { id: ids.card, name: "Card", is_terminal: true });
  await must("POST", "/v1/tender-types", { id: ids.terminal, name: "Card (terminal)", is_terminal: true, provider: "simulator", terminal_id: `term-${name}` });
  const secret = randomBytes(24).toString("hex");
  await must("PUT", "/v1/payment-providers/simulator", { webhook_secret: secret });
  return { m, ids, secret, token: m.cashier.token };
}
type M = Awaited<ReturnType<typeof merchant>>;

const snap = async (w: M, orderId: string) => (await call<{ data: Snap }>("GET", `/v1/orders/${orderId}`, { token: w.token })).body.data;
const intents = async (w: M, orderId: string) => (await call<{ data: Intent[] }>("GET", `/v1/orders/${orderId}/payment-intents`, { token: w.token })).body.data;
const intentRow = async (id: string) => (await db.sql<{ state: string; outcome_reason: string | null; provider_voided_at: Date | null }[]>`select state, outcome_reason, provider_voided_at from payment_intents where id = ${id}`)[0]!;
const paymentRows = async (orderId: string) => db.sql<{ id: string; status: string; amount: number; tip_cents: number; rounding_cents: number }[]>`select id, status, amount, tip_cents, rounding_cents from payments where order_id = ${orderId} order by created_at`;

async function order(w: M, lines: string[] = [w.ids.item], fire = true): Promise<Snap> {
  const o = await call<{ data: Snap }>("POST", "/v1/orders", { token: w.token, body: { order_id: randomUUID(), order_type: "takeaway", takeaway_ref: "T", outlet_id: w.m.outletId, brand_id: w.m.brandId } });
  const s = await call<{ data: Snap }>("POST", `/v1/orders/${o.body.data.id}/lines`, { token: w.token, body: { lines: lines.map((product_id) => ({ line_id: randomUUID(), product_id, quantity: 1 })) } });
  if (fire) await call("POST", `/v1/orders/${o.body.data.id}/fire`, { token: w.token, body: {} });
  return s.body.data;
}
const start = (w: M, checkId: string, amount: number, extra: Record<string, unknown> = {}, token = w.token) => call<{ data: Intent } & Err>("POST", `/v1/checks/${checkId}/payment-intents`, { token, body: { intent_id: randomUUID(), tender_type_id: w.ids.terminal, amount, ...extra } });
const simPayment = (reference: string) => [...sim.payments.values()].find((p) => p.reference === reference);
/** A webhook as the simulator would sign it, for tampering, replay and reordering. */
const webhook = (merchantId: string, secret: string, payment: { id: string; reference: string; status: string; amount: number }, at = new Date(), eventId = `evt_${randomUUID()}`): Delivery => {
  const body = JSON.stringify({ id: eventId, type: `payment.${payment.status}`, created: Math.floor(at.getTime() / 1000), payment });
  return { url: `http://register/v1/webhooks/payments/simulator/${merchantId}`, headers: { "content-type": "application/json", [SIMULATOR_SIGNATURE_HEADER]: signSimulatorWebhook(secret, body, at) }, body };
};

/** Start a full-balance terminal payment and let the worker hand it to the terminal. */
async function onTerminal(w: M, s: Snap, extra: Record<string, unknown> = {}) {
  const r = await start(w, s.checks[0]!.id, s.checks[0]!.balance, extra);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  await drainPaymentOutbox();
  expect(simPayment(r.body.data.id)?.status).toBe("pending");
  return r.body.data;
}

let A: M;
let B: M;
beforeAll(async () => {
  A = await merchant("Alpha", { rounding: 5 });
  B = await merchant("Bravo");
  // Cash goes into a shift's drawer: one outlet-wide shift for the file.
  expect((await call("POST", "/v1/shifts", { token: A.m.admin.token, body: { outlet_id: A.m.outletId, station_id: null, float_cents: 0 } })).status).toBe(201);
});

describe("approve and decline", () => {
  it("an approval records one payment through the ordinary payment path and settles the bill; the request itself never reaches the terminal", async () => {
    const s = await order(A);
    const balance = s.checks[0]!.balance;
    const r = await start(A, s.checks[0]!.id, balance);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({ state: "pending", amount: balance, payment_id: null });
    // Committed and answered before any provider call: the terminal has not been asked yet.
    expect(simPayment(r.body.data.id)).toBeUndefined();
    await drainPaymentOutbox();
    expect(simPayment(r.body.data.id)).toMatchObject({ status: "pending", amount: balance, terminalId: "term-Alpha", currency: "GBP" });
    await sim.settle(r.body.data.id, "approve");
    const after = await snap(A, s.id);
    expect(after).toMatchObject({ status: "completed", balance: 0, pricing_status: "frozen" });
    expect(after.checks[0]!.status).toBe("paid");
    expect(after.checks[0]!.payments).toHaveLength(1);
    expect(after.checks[0]!.payments[0]).toMatchObject({ tender: "Card (terminal)", amount: balance, rounding_cents: 0, reference: simPayment(r.body.data.id)!.id, status: "recorded" });
    const [intent] = await intents(A, s.id);
    expect(intent).toMatchObject({ state: "approved", payment_id: after.checks[0]!.payments[0]!.id });
    const ev = await call<{ data: { type: string; payload: { intent_id?: string } }[] }>("GET", `/v1/outlets/${A.m.outletId}/events?after=0`, { token: A.token });
    const mine = ev.body.data.filter((e) => e.payload.intent_id === r.body.data.id).map((e) => e.type);
    expect(mine).toEqual(["payment_intent.started", "payment.recorded", "payment_intent.approved"]);
  });

  it("a decline leaves the bill exactly as it was: no payment, pricing not frozen, and the bill can be paid another way", async () => {
    const s = await order(A);
    const intent = await onTerminal(A, s);
    await sim.settle(intent.id, "decline");
    const after = await snap(A, s.id);
    expect(after).toMatchObject({ status: "fired", balance: s.balance, pricing_status: s.pricing_status });
    expect(after.checks[0]!.payments).toEqual([]);
    expect(after.checks[0]!.paid_total).toBe(0);
    expect((await intents(A, s.id))[0]).toMatchObject({ state: "declined", outcome_reason: "declined" });
    // The bill is free again: a new terminal payment or cash.
    const cash = await call("POST", `/v1/checks/${s.checks[0]!.id}/payments`, { token: A.token, body: { payment_id: randomUUID(), tender_type_id: A.ids.cash, amount: s.balance, tendered: 5000 } });
    expect(cash.status, JSON.stringify(cash.body)).toBe(200);
  });

  it("a bill whose terminal payment was declined can still be split, and an intent for a bill split away is never applied", async () => {
    const s = await order(A, [A.ids.item, A.ids.side]);
    const declined = await onTerminal(A, s);
    await sim.settle(declined.id, "decline");
    const pending = await onTerminal(A, s);
    const split = await call<{ data: Snap }>("POST", `/v1/orders/${s.id}/checks/split-even`, { token: A.token, body: { n: 2 } });
    expect(split.status, JSON.stringify(split.body)).toBe(200);
    expect(split.body.data.checks).toHaveLength(2);
    await sim.settle(pending.id, "approve");
    expect(await intentRow(pending.id)).toMatchObject({ state: "cancelled", outcome_reason: "bill_changed" });
    expect(await paymentRows(s.id)).toHaveLength(0);
  });

  it("a terminal payment method cannot be recorded by hand, and a by-hand one cannot be sent to a terminal", async () => {
    const s = await order(A);
    const byHand = await call<Err>("POST", `/v1/checks/${s.checks[0]!.id}/payments`, { token: A.token, body: { payment_id: randomUUID(), tender_type_id: A.ids.terminal, amount: s.balance } });
    expect(byHand.status).toBe(400);
    expect(byHand.body.message).toMatch(/taken on the terminal/);
    const toTerminal = await start(A, s.checks[0]!.id, s.balance, { tender_type_id: A.ids.card });
    expect(toTerminal.status).toBe(400);
    expect(toTerminal.body.message).toMatch(/recorded by hand/);
    expect((await start(A, s.checks[0]!.id, s.balance, {}, A.m.server.token)).status).toBe(403);
  });
});

describe("exactly once", () => {
  it("a duplicated, replayed or differently numbered approval, raced against the worker's poll, records one payment", async () => {
    const s = await order(A);
    const intent = await onTerminal(A, s);
    const before = sim.deliveries.length;
    await sim.settle(intent.id, "duplicate");
    const sent = sim.deliveries.slice(before);
    expect(sent).toHaveLength(2);
    // The same delivery five more times at once, the same approval under a new event id, and a poll, all together.
    const p = simPayment(intent.id)!;
    const renumbered = webhook(A.m.merchantId, A.secret, { id: p.id, reference: p.reference, status: "approved", amount: p.amount });
    const results = await Promise.all([...Array.from({ length: 5 }, () => post(sent[0]!)), post(renumbered), pollPendingIntents()]);
    for (const r of results.slice(0, 6)) expect((r as Response).status).toBe(200);
    expect(await paymentRows(s.id)).toHaveLength(1);
    expect((await snap(A, s.id)).checks[0]!.paid_total).toBe(s.balance);
  });

  it("events out of order: a decline or a cancel arriving after the approval changes nothing", async () => {
    const s = await order(A);
    const intent = await onTerminal(A, s);
    const p = simPayment(intent.id)!;
    const earlier = new Date(Date.now() - 30_000);
    await sim.settle(intent.id, "approve");
    for (const status of ["pending", "declined", "cancelled"]) expect((await post(webhook(A.m.merchantId, A.secret, { id: p.id, reference: p.reference, status, amount: p.amount }, earlier))).status).toBe(200);
    expect(await paymentRows(s.id)).toHaveLength(1);
    expect(await intentRow(intent.id)).toMatchObject({ state: "approved" });
  });

  it("20 starts on one bill at once leave one payment on the terminal; the rest are refused", async () => {
    const s = await order(A);
    const all = await Promise.all(Array.from({ length: 20 }, () => start(A, s.checks[0]!.id, s.balance)));
    const statuses = all.map((r) => r.status).sort();
    expect(statuses.filter((x) => x === 201)).toHaveLength(1);
    expect(statuses.filter((x) => x === 409)).toHaveLength(19);
    const [row] = await db.sql<{ n: number }[]>`select count(*)::int as n from payment_intents where check_id = ${s.checks[0]!.id}`;
    expect(row!.n).toBe(1);
  });
});

describe("webhook intake", () => {
  it("refuses a tampered body, another merchant's secret, a stale signature and an unknown provider; refused deliveries count on their own limit, apart from verified ones", async () => {
    const s = await order(A);
    const intent = await onTerminal(A, s);
    const p = simPayment(intent.id)!;
    const good = webhook(A.m.merchantId, A.secret, { id: p.id, reference: p.reference, status: "approved", amount: p.amount });
    const tampered = { ...good, body: good.body.replace(`"amount":${p.amount}`, `"amount":${p.amount + 1}`) };
    expect((await post(tampered)).status).toBe(401);
    // Signed with Bravo's secret but sent to Alpha's address: Alpha's secret does not verify it.
    expect((await post(webhook(A.m.merchantId, B.secret, { id: p.id, reference: p.reference, status: "approved", amount: p.amount }))).status).toBe(401);
    // Sent to Bravo's address with Bravo's secret, naming Alpha's payment: Bravo has no such payment, so nothing happens.
    const crossed = await post(webhook(B.m.merchantId, B.secret, { id: p.id, reference: p.reference, status: "approved", amount: p.amount }));
    expect(crossed.status).toBe(200);
    expect(((await crossed.json()) as { data: { applied: string } }).data.applied).toBe("unchanged");
    expect((await post(webhook(A.m.merchantId, A.secret, { id: p.id, reference: p.reference, status: "approved", amount: p.amount }, new Date(Date.now() - 10 * 60_000)))).status).toBe(401);
    expect((await app.request(`/v1/webhooks/payments/nobody/${A.m.merchantId}`, { method: "POST", headers: good.headers, body: good.body })).status).toBe(401);
    expect(await paymentRows(s.id)).toHaveLength(0);
    expect(await intentRow(intent.id)).toMatchObject({ state: "pending" });
    const [hits] = await db.sql<{ n: number }[]>`select coalesce(cardinality(hits), 0)::int as n from guest_rate_hits where merchant_id = ${A.m.merchantId} and key = 'webhook-refused:simulator'`;
    expect(hits!.n).toBeGreaterThanOrEqual(3);
    expect((await post(good)).status).toBe(200);
    expect(await paymentRows(s.id)).toHaveLength(1);
  });
});

describe("the bill is pinned at start", () => {
  it("a bill that changed while the guest was paying: the approval is voided at the provider and nothing is applied", async () => {
    const s = await order(A);
    const intent = await onTerminal(A, s);
    const added = await call("POST", `/v1/orders/${s.id}/lines`, { token: A.token, body: { lines: [{ line_id: randomUUID(), product_id: A.ids.side, quantity: 1 }] } });
    expect(added.status).toBe(200);
    await sim.settle(intent.id, "approve");
    expect(await paymentRows(s.id)).toHaveLength(0);
    expect(await intentRow(intent.id)).toMatchObject({ state: "cancelled", outcome_reason: "bill_changed", provider_voided_at: null });
    await drainPaymentOutbox();
    expect(simPayment(intent.id)!.status).toBe("voided");
    expect((await intentRow(intent.id)).provider_voided_at).not.toBeNull();
    expect((await snap(A, s.id)).checks[0]!.paid_total).toBe(0);
  });

  it("a bill paid in cash while the terminal was waiting: the late approval is voided, never applied on top", async () => {
    const s = await order(A);
    const intent = await onTerminal(A, s);
    const cash = await call("POST", `/v1/checks/${s.checks[0]!.id}/payments`, { token: A.token, body: { payment_id: randomUUID(), tender_type_id: A.ids.cash, amount: s.balance, tendered: 5000 } });
    expect(cash.status, JSON.stringify(cash.body)).toBe(200);
    await sim.settle(intent.id, "approve");
    const rows = await paymentRows(s.id);
    expect(rows).toHaveLength(1);
    expect((await snap(A, s.id)).checks[0]!.payments[0]!.tender).toBe("Cash");
    await drainPaymentOutbox();
    expect(simPayment(intent.id)!.status).toBe("voided");
  });
});

describe("timeouts", () => {
  it("an intent past its time expires and is stopped on the terminal; the bill is free again", async () => {
    const s = await order(A);
    const intent = await onTerminal(A, s);
    await db.sql`update payment_intents set expires_at = now() - interval '1 second' where id = ${intent.id}`;
    expect(await expireIntents()).toBe(1);
    expect(await intentRow(intent.id)).toMatchObject({ state: "expired", outcome_reason: "expired" });
    await drainPaymentOutbox();
    expect(simPayment(intent.id)!.status).toBe("cancelled");
    expect((await start(A, s.checks[0]!.id, s.balance)).status).toBe(201);
  });

  it("an approval that arrives after the intent expired is given back at the provider", async () => {
    const s = await order(A);
    const intent = await onTerminal(A, s);
    await db.sql`update payment_intents set expires_at = now() - interval '1 second' where id = ${intent.id}`;
    await expireIntents();
    // The guest paid just before the cancel reached the terminal.
    const p = simPayment(intent.id)!;
    p.status = "approved";
    await drainPaymentOutbox(); // the cancel finds it approved and queues a void
    await post(webhook(A.m.merchantId, A.secret, { id: p.id, reference: p.reference, status: "approved", amount: p.amount }));
    await drainPaymentOutbox();
    expect(p.status).toBe("voided");
    expect(await paymentRows(s.id)).toHaveLength(0);
    expect((await intentRow(intent.id)).provider_voided_at).not.toBeNull();
  });
});

describe("an intent the register gave up on", () => {
  it("a cancel the terminal has not settled is retried, and an approval it later reports without a webhook is found by the poll and voided", async () => {
    const s = await order(A);
    const intent = await onTerminal(A, s);
    expect((await call("POST", `/v1/payment-intents/${intent.id}/cancel`, { token: A.token, body: {} })).status).toBe(200);
    const original = simulatorProvider.cancelPayment;
    simulatorProvider.cancelPayment = async () => "pending";
    try {
      expect(await drainPaymentOutbox()).toMatchObject({ retried: 1 });
    } finally {
      simulatorProvider.cancelPayment = original;
    }
    // The guest finishes the payment on the terminal and the webhook never arrives.
    simPayment(intent.id)!.status = "approved";
    await pollPendingIntents();
    await db.sql`update payment_outbox set next_attempt_at = now() where intent_id = ${intent.id}`;
    await drainPaymentOutbox();
    expect(simPayment(intent.id)!.status).toBe("voided");
    expect(await paymentRows(s.id)).toHaveLength(0);
    expect((await intentRow(intent.id)).provider_voided_at).not.toBeNull();
  });

  it("an agent's cancel of a terminal payment is a proposal", async () => {
    const s = await order(B);
    const intent = await onTerminal(B, s);
    const identity = await call<{ data: { credential: string } }>("POST", "/v1/agent-identities", { token: B.m.admin.token, body: { name: "Till helper", role: "cashier", toolsets: ["pos.payment"], risk_ceiling: "T1" } });
    const session = await call<{ data: { agent_token: string } }>("POST", "/v1/agent-sessions", { body: { credential: identity.body.data.credential }, idempotencyKey: null });
    expect((await call("POST", `/v1/payment-intents/${intent.id}/cancel`, { token: session.body.data.agent_token, body: {} })).status).toBe(202);
    expect(await intentRow(intent.id)).toMatchObject({ state: "pending" });
  });
});

describe("the outbox", () => {
  it("a failing row backs off and retries without holding up the rows after it, and gives up after its last attempt", async () => {
    const first = await order(A);
    const second = await order(A);
    const a = await start(A, first.checks[0]!.id, first.balance);
    const b = await start(A, second.checks[0]!.id, second.balance);
    const original = simulatorProvider.startPayment;
    simulatorProvider.startPayment = async (input) => {
      if (input.reference === a.body.data.id) throw new Error("terminal offline");
      return original(input);
    };
    try {
      const tally = await drainPaymentOutbox();
      expect(tally).toMatchObject({ retried: 1 });
      expect(simPayment(b.body.data.id)?.status).toBe("pending");
      expect(simPayment(a.body.data.id)).toBeUndefined();
      const [row] = await db.sql<{ attempts: number; last_error: string; due_later: boolean }[]>`select attempts, last_error, next_attempt_at > now() as due_later from payment_outbox where intent_id = ${a.body.data.id} and kind = 'start'`;
      expect(row).toMatchObject({ attempts: 1, last_error: "terminal offline", due_later: true });
      // Not due yet: another drain leaves it alone.
      expect((await drainPaymentOutbox()).retried).toBe(0);
      // Out of attempts: marked failed, not retried for ever.
      await db.sql`update payment_outbox set attempts = ${OUTBOX_MAX_ATTEMPTS - 1}, next_attempt_at = now() where intent_id = ${a.body.data.id}`;
      expect(await drainPaymentOutbox()).toMatchObject({ failed: 1 });
      const [dead] = await db.sql<{ failed: boolean }[]>`select failed_at is not null as failed from payment_outbox where intent_id = ${a.body.data.id}`;
      expect(dead!.failed).toBe(true);
    } finally {
      simulatorProvider.startPayment = original;
    }
  });
});

describe("tips, cash rounding and currencies", () => {
  it("a terminal payment is charged amount plus tip, records the tip, and takes no cash rounding; cash for the rest of the bill rounds", async () => {
    // Alpha rounds cash to 5. Set lunch 1234 + side 250 = 1484: a terminal part payment of 1001 with a 37 tip, then cash.
    const s = await order(A, [A.ids.item, A.ids.side]);
    expect(s.balance).toBe(1484);
    const r = await start(A, s.checks[0]!.id, 1001, { tip_cents: 37 });
    await drainPaymentOutbox();
    expect(simPayment(r.body.data.id)!.amount).toBe(1038);
    await sim.settle(r.body.data.id, "approve");
    const after = await snap(A, s.id);
    expect(after.checks[0]!.payments[0]).toMatchObject({ amount: 1001, tip_cents: 37, rounding_cents: 0 });
    expect(after.balance).toBe(483);
    const cash = await call<{ payment: { rounding_cents: number; amount: number } }>("POST", `/v1/checks/${s.checks[0]!.id}/payments`, { token: A.token, body: { payment_id: randomUUID(), tender_type_id: A.ids.cash, amount: 483, tendered: 500 } });
    expect(cash.body.payment).toMatchObject({ amount: 483, rounding_cents: 2 });
    // An approval for anything but the pinned amount plus tip is not applied.
    const s2 = await order(A);
    const i2 = await onTerminal(A, s2, { tip_cents: 100 });
    const p2 = simPayment(i2.id)!;
    await post(webhook(A.m.merchantId, A.secret, { id: p2.id, reference: p2.reference, status: "approved", amount: s2.balance }));
    expect(await intentRow(i2.id)).toMatchObject({ state: "cancelled", outcome_reason: "amount_mismatch" });
    expect(await paymentRows(s2.id)).toHaveLength(0);
  });

  it("works in whole minor units for a 0-decimal and a 3-decimal currency", async () => {
    for (const [name, currency, price] of [["Yen", "JPY", 1480], ["Dinar", "BHD", 3125]] as const) {
      const w = await merchant(name, { currency, price });
      const s = await order(w);
      expect(s.balance).toBe(price);
      const intent = await onTerminal(w, s, { tip_cents: 7 });
      expect(simPayment(intent.id)).toMatchObject({ amount: price + 7, currency });
      await sim.settle(intent.id, "approve");
      expect((await snap(w, s.id)).checks[0]!.payments[0]).toMatchObject({ amount: price, tip_cents: 7 });
    }
  });
});

describe("payments.void", () => {
  let C: M;
  beforeAll(async () => {
    C = await merchant("Charlie");
  });
  const pay = (w: M, s: Snap, tender: string, token = w.token) => call<{ data: Snap } & Err>("POST", `/v1/checks/${s.checks[0]!.id}/payments`, { token, body: { payment_id: randomUUID(), tender_type_id: tender, amount: s.checks[0]!.balance, ...(tender === w.ids.cash ? { tendered: s.checks[0]!.balance } : {}) } });
  const paid = async (w: M, tender = w.ids.card) => {
    const s = await order(w);
    const r = await pay(w, s, tender);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return { s, paymentId: r.body.data.checks[0]!.payments[0]!.id };
  };
  const voidIt = (w: M, paymentId: string, token: string, extra: Record<string, unknown> = {}) => call<{ data: Snap; void: { status: string }; events: { type: string }[] } & Err>("POST", `/v1/payments/${paymentId}/void`, { token, body: { reason: "Wrong payment method", ...extra } });
  const grant = (w: M, paymentId: string, amount: number) => call<{ data: { override_id: string } } & Err>("POST", "/v1/overrides", { token: w.token, body: { action: "payments.void", target_kind: "payment", target_id: paymentId, approver_pin: "222222", outlet_id: w.m.outletId, args: { amount } } });

  it("a cashier needs a manager's approval bound to that payment; the bill owes the amount again and the order reopens for payment", async () => {
    const drawer = await call<{ data: { id: string } }>("POST", "/v1/shifts", { token: C.token, body: { outlet_id: C.m.outletId, float_cents: 0 } });
    expect(drawer.status).toBe(201);
    const one = await paid(C);
    const other = await paid(C);
    expect((await snap(C, one.s.id)).status).toBe("completed");
    const refused = await voidIt(C, one.paymentId, C.token);
    expect(refused.status).toBe(403);
    expect(refused.body.details).toMatchObject({ required_role: "manager", override_allowed: true });
    // An approval for the other payment cannot be spent on this one.
    const forOther = await grant(C, other.paymentId, other.s.balance);
    expect(forOther.status, JSON.stringify(forOther.body)).toBe(201);
    expect((await voidIt(C, one.paymentId, C.token, { override_id: forOther.body.data.override_id })).status).toBe(403);
    const g = await grant(C, one.paymentId, one.s.balance);
    const done = await voidIt(C, one.paymentId, C.token, { override_id: g.body.data.override_id });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.void.status).toBe("voided");
    expect(done.body.events.map((e) => e.type)).toEqual(["payment.voided"]);
    expect(done.body.data).toMatchObject({ status: "fired", balance: one.s.balance, pricing_status: "live" });
    expect(done.body.data.checks[0]).toMatchObject({ status: "open", paid_total: 0 });
    expect(done.body.data.checks[0]!.payments[0]!.status).toBe("reversed");
    // Voided once: a second void is refused, and the bill takes the right payment.
    expect((await voidIt(C, one.paymentId, C.m.manager.token)).status).toBe(409);
    expect((await pay(C, done.body.data, C.ids.cash)).status).toBe(200);
    expect((await snap(C, one.s.id)).status).toBe("completed");
    // A manager voids directly.
    expect((await voidIt(C, other.paymentId, C.m.manager.token)).status).toBe(200);
    expect((await call("POST", `/v1/shifts/${drawer.body.data.id}/close`, { token: C.token, body: { counted_cash_cents: one.s.balance } })).status).toBe(200);
  });

  it("another merchant's manager cannot see the payment; an agent's void becomes a proposal that a manager approves", async () => {
    const { s, paymentId } = await paid(C);
    expect((await voidIt(B, paymentId, B.m.manager.token)).status).toBe(404);
    const identity = await call<{ data: { credential: string } }>("POST", "/v1/agent-identities", { token: C.m.admin.token, body: { name: "Till assistant", role: "manager", outlet_ids: [C.m.outletId], toolsets: ["pos.read", "pos.refund"], risk_ceiling: "T2" } });
    const session = await call<{ data: { agent_token: string } }>("POST", "/v1/agent-sessions", { body: { credential: identity.body.data.credential }, idempotencyKey: null });
    const proposed = await call<{ code: string; data: { id: string; tier: string } }>("POST", `/v1/payments/${paymentId}/void`, { token: session.body.data.agent_token, body: { reason: "Charged twice" } });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(202);
    expect(proposed.body).toMatchObject({ code: "requires_confirmation", data: { tier: "T3" } });
    expect((await paymentRows(s.id))[0]!.status).toBe("recorded");
    const approved = await call<{ data: { status: string; result: { status: number } } }>("POST", `/v1/proposals/${proposed.body.data.id}/approve`, { token: C.m.manager.token, body: {} });
    expect(approved.body.data, JSON.stringify(approved.body)).toMatchObject({ status: "approved", result: { status: 200 } });
    expect((await paymentRows(s.id))[0]!.status).toBe("reversed");
  });

  it("is refused once money has been refunded from the bill", async () => {
    const { s, paymentId } = await paid(C);
    const refund = await call("POST", `/v1/checks/${s.checks[0]!.id}/refunds`, { token: C.m.manager.token, body: { refund_id: randomUUID(), request: { kind: "amount", amount: 100 }, reason: "Cold", print: false } });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    const r = await voidIt(C, paymentId, C.m.manager.token);
    expect(r.status).toBe(422);
    expect(r.body.details).toMatchObject({ invariant: "payment_refunded" });
  });

  it("a terminal payment is voided at the provider first: until it confirms, the payment stands and refunds and the shift close wait", async () => {
    const shift = await call<{ data: { id: string } }>("POST", "/v1/shifts", { token: C.token, body: { outlet_id: C.m.outletId, float_cents: 0 } });
    expect(shift.status).toBe(201);
    const s = await order(C);
    const intent = await onTerminal(C, s);
    await sim.settle(intent.id, "approve");
    const [payment] = await paymentRows(s.id);
    const r = await voidIt(C, payment!.id, C.m.manager.token);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.void.status).toBe("pending_provider");
    expect(r.body.events.map((e) => e.type)).toEqual(["payment.void_requested"]);
    expect((await paymentRows(s.id))[0]!.status).toBe("recorded");
    expect(simPayment(intent.id)!.status).toBe("approved");
    expect((await call("POST", `/v1/checks/${s.checks[0]!.id}/refunds`, { token: C.m.manager.token, body: { refund_id: randomUUID(), request: { kind: "amount", amount: 100 }, reason: "Cold", print: false } })).status).toBe(409);
    expect((await call("POST", `/v1/shifts/${shift.body.data.id}/close`, { token: C.token, body: { counted_cash_cents: 0 } })).status).toBe(409);
    expect((await voidIt(C, payment!.id, C.m.manager.token)).status).toBe(409);
    await drainPaymentOutbox();
    expect(simPayment(intent.id)!.status).toBe("voided");
    expect((await paymentRows(s.id))[0]!.status).toBe("reversed");
    expect((await snap(C, s.id))).toMatchObject({ status: "fired", balance: s.balance });
    const ev = await call<{ data: { type: string; payload: { payment_id?: string } }[] }>("GET", `/v1/outlets/${C.m.outletId}/events?after=0`, { token: C.token });
    expect(ev.body.data.filter((e) => e.payload.payment_id === payment!.id).map((e) => e.type)).toEqual(["payment.recorded", "payment_intent.approved", "payment.void_requested", "payment.voided"]);
    const closed = await call("POST", `/v1/shifts/${shift.body.data.id}/close`, { token: C.token, body: { counted_cash_cents: 0 } });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  });

  it("a void the provider made although every call to it failed is found by the poll, and the payment is reversed", async () => {
    const s = await order(C);
    const intent = await onTerminal(C, s);
    await sim.settle(intent.id, "approve");
    const [payment] = await paymentRows(s.id);
    expect((await voidIt(C, payment!.id, C.m.manager.token)).body.void.status).toBe("pending_provider");
    // The provider voids, but the answer never arrives, on every attempt.
    const original = simulatorProvider.voidPayment;
    simulatorProvider.voidPayment = async (input) => {
      await original(input);
      throw new Error("timed out");
    };
    try {
      await db.sql`update payment_outbox set attempts = ${OUTBOX_MAX_ATTEMPTS - 1}, next_attempt_at = now() where intent_id = ${intent.id} and kind = 'void'`;
      expect(await drainPaymentOutbox()).toMatchObject({ failed: 1 });
    } finally {
      simulatorProvider.voidPayment = original;
    }
    expect(simPayment(intent.id)!.status).toBe("voided");
    expect((await paymentRows(s.id))[0]!.status).toBe("recorded");
    // The register gave up on the call, but the money went back: the poll asks the provider and applies the void.
    await pollPendingIntents();
    expect((await paymentRows(s.id))[0]!.status).toBe("reversed");
    expect(await snap(C, s.id)).toMatchObject({ balance: s.balance });
    expect((await intentRow(intent.id)).provider_voided_at).not.toBeNull();
  });

  it("a void the provider made after the register gave up is not applied once the bill was refunded: the guest is never paid back twice by the register", async () => {
    const s = await order(C);
    const intent = await onTerminal(C, s);
    await sim.settle(intent.id, "approve");
    const [payment] = await paymentRows(s.id);
    expect((await voidIt(C, payment!.id, C.m.manager.token)).body.void.status).toBe("pending_provider");
    const original = simulatorProvider.voidPayment;
    simulatorProvider.voidPayment = async (input) => {
      await original(input);
      throw new Error("timed out");
    };
    try {
      await db.sql`update payment_outbox set attempts = ${OUTBOX_MAX_ATTEMPTS - 1}, next_attempt_at = now() where intent_id = ${intent.id} and kind = 'void'`;
      expect(await drainPaymentOutbox()).toMatchObject({ failed: 1 });
    } finally {
      simulatorProvider.voidPayment = original;
    }
    // The register stopped waiting, so staff give the money back as a refund, as the void_failed event tells them to.
    const refund = await call("POST", `/v1/checks/${s.checks[0]!.id}/refunds`, { token: C.m.manager.token, body: { refund_id: randomUUID(), request: { kind: "full" }, reason: "Void failed, refunding instead", print: false } });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    await pollPendingIntents();
    // The payment stands next to its refund; the provider's late void is reported, not applied on top.
    expect((await paymentRows(s.id))[0]!.status).toBe("recorded");
    const [check] = await db.sql<{ paid_total: number; refunded_total: number }[]>`select paid_total, refunded_total from checks where id = ${s.checks[0]!.id}`;
    expect(check).toMatchObject({ paid_total: payment!.amount, refunded_total: payment!.amount });
    const ev = await call<{ data: { type: string; payload: { payment_id?: string; reason?: string } }[] }>("GET", `/v1/outlets/${C.m.outletId}/events?after=0`, { token: C.token });
    expect(ev.body.data.filter((e) => e.payload.payment_id === payment!.id && e.type === "payment_intent.voided_not_applied").map((e) => e.payload.reason)).toEqual(["refunded"]);
  });

  it("a void and a shift close at the same moment run one after the other: the closed shift counts exactly the payments still recorded", async () => {
    const shift = await call<{ data: { id: string } }>("POST", "/v1/shifts", { token: C.token, body: { outlet_id: C.m.outletId, float_cents: 0 } });
    expect(shift.status, JSON.stringify(shift.body)).toBe(201);
    const a = await paid(C, C.ids.cash);
    const b = await paid(C, C.ids.cash);
    const [voided, closed] = await Promise.all([voidIt(C, b.paymentId, C.m.manager.token), call<{ data: { expected_cash_cents: number } } & Err>("POST", `/v1/shifts/${shift.body.data.id}/close`, { token: C.token, body: { counted_cash_cents: a.s.balance, variance_reason: "Counted during a void" } })]);
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    const [recorded] = await db.sql<{ n: number }[]>`select coalesce(sum(amount), 0)::int as n from payments where shift_id = ${shift.body.data.id} and status = 'recorded' and is_cash`;
    expect(closed.body.data.expected_cash_cents).toBe(recorded!.n);
    // Either the void came first (and the close counted without it) or the close did (and the void was refused).
    expect([200, 422]).toContain(voided.status);
    expect(recorded!.n).toBe(voided.status === 200 ? a.s.balance : a.s.balance + b.s.balance);
  });

  it("a reopen of an order paid on the terminal is refused, so the guest is never charged twice", async () => {
    const s = await order(C);
    const intent = await onTerminal(C, s);
    await sim.settle(intent.id, "approve");
    const r = await call<Err>("POST", `/v1/orders/${s.id}/reopen`, { token: C.m.manager.token, body: { reason: "Wrong table" } });
    expect(r.status).toBe(422);
    expect(r.body.details).toMatchObject({ invariant: "terminal_payment" });
  });

  it("after a void the shift's expected cash and the Z-report agree, and a closed shift's payments can no longer be voided", async () => {
    const shift = await call<{ data: { id: string } }>("POST", "/v1/shifts", { token: C.token, body: { outlet_id: C.m.outletId, float_cents: 10_000 } });
    expect(shift.status, JSON.stringify(shift.body)).toBe(201);
    const kept = await paid(C, C.ids.cash);
    const wrong = await paid(C, C.ids.cash);
    expect((await voidIt(C, wrong.paymentId, C.m.manager.token)).status).toBe(200);
    // The guest paid by card in the end.
    expect((await pay(C, await snap(C, wrong.s.id), C.ids.card)).status).toBe(200);
    type Z = { cash: { expected: number; cash_payments: number }; tenders: { tender: string; count: number; amount: number }[] };
    const z = (await call<{ data: Z }>("GET", `/v1/outlets/${C.m.outletId}/z-report`, { token: C.token })).body.data;
    const shiftCash = await db.sql<{ n: number }[]>`select coalesce(sum(amount), 0)::int as n from payments where shift_id = ${shift.body.data.id} and status = 'recorded' and is_cash`;
    expect(shiftCash[0]!.n).toBe(kept.s.balance);
    const closed = await call<{ data: { expected_cash_cents: number; variance_cents: number; report: Z } }>("POST", `/v1/shifts/${shift.body.data.id}/close`, { token: C.token, body: { counted_cash_cents: 10_000 + kept.s.balance } });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.data).toMatchObject({ expected_cash_cents: 10_000 + kept.s.balance, variance_cents: 0 });
    expect(closed.body.data.report.cash.cash_payments).toBe(kept.s.balance);
    // The day's report counts the voided cash nowhere and the card that replaced it once.
    expect(z.tenders.find((t) => t.tender === "Card")!.amount).toBeGreaterThanOrEqual(wrong.s.balance);
    const zAfter = (await call<{ data: Z }>("GET", `/v1/outlets/${C.m.outletId}/z-report`, { token: C.token })).body.data;
    const [totals] = await db.sql<{ cash: number; card: number }[]>`select coalesce(sum(amount) filter (where is_cash), 0)::int as cash, coalesce(sum(amount) filter (where tender_name = 'Card'), 0)::int as card from payments where merchant_id = ${C.m.merchantId} and status = 'recorded'`;
    expect(zAfter.tenders.find((t) => t.tender === "Cash")!.amount).toBe(totals!.cash);
    expect(zAfter.tenders.find((t) => t.tender === "Card")!.amount).toBe(totals!.card);
    const r = await voidIt(C, kept.paymentId, C.m.manager.token);
    expect(r.status).toBe(422);
    expect(r.body.details).toMatchObject({ invariant: "shift_closed" });
  });

  it("is refused once the business day is closed, and the day waits for a terminal void still to be confirmed", async () => {
    const s = await order(C);
    const intent = await onTerminal(C, s);
    await sim.settle(intent.id, "approve");
    const [terminalPayment] = await paymentRows(s.id);
    expect((await voidIt(C, terminalPayment!.id, C.m.manager.token)).body.void.status).toBe("pending_provider");
    expect((await call("POST", `/v1/outlets/${C.m.outletId}/business-days/close`, { token: C.m.manager.token, body: {} })).status).toBe(409);
    await drainPaymentOutbox();
    const { paymentId } = await paid(C);
    await settleOpenOrders(db.sql, call, C.m.manager.token, C.m.outletId, C.ids.card);
    const close = await call("POST", `/v1/outlets/${C.m.outletId}/business-days/close`, { token: C.m.manager.token, body: {} });
    expect(close.status, JSON.stringify(close.body)).toBe(200);
    const r = await voidIt(C, paymentId, C.m.manager.token);
    expect(r.status).toBe(422);
    expect(r.body.details).toMatchObject({ invariant: "business_day_closed" });
  });
});
