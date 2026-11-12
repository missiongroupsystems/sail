// Agent and MCP safety: each describe block holds the repro of one finding from the agent-safety review, asserting
// the behaviour the register must have.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootWorld, type Call, type World } from "./world.js";
import type { TestDb } from "./helpers.js";

let db: TestDb;
let call: Call;
let w: World;

type Snap = { id: string; version: number; status: string; totals: { total: number }; lines: { id: string; status: string }[]; checks: { id: string }[]; balance: number };

async function identity(body: Record<string, unknown>) {
  const r = await call<{ data: { id: string; credential: string } }>("POST", "/v1/agent-identities", { token: w.m.admin.token, body: { name: `a-${randomUUID().slice(0, 6)}`, ...body } });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.data;
}
async function session(credential: string, extra: Record<string, unknown> = {}) {
  const r = await call<{ data: { agent_token: string } }>("POST", "/v1/agent-sessions", { body: { credential, ...extra }, idempotencyKey: null });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.data.agent_token;
}
const delegate = async (token: string, identityId: string) => {
  const r = await call<{ data: { grant: string } }>("POST", `/v1/agent-identities/${identityId}/delegations`, { token, body: {} });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.data.grant;
};
const openTakeaway = (token: string) => call<{ data: Snap }>("POST", "/v1/orders", { token, body: { order_id: randomUUID(), order_type: "takeaway", takeaway_ref: "R", outlet_id: w.m.outletId, brand_id: w.m.brandId } });
const addLine = (token: string, orderId: string, line: Record<string, unknown>) => call<{ data: Snap; code?: string }>("POST", `/v1/orders/${orderId}/lines`, { token, body: { lines: [{ line_id: randomUUID(), quantity: 1, ...line }] } });

beforeAll(async () => {
  ({ db, call, w } = await bootWorld());
}, 120_000);
afterAll(async () => db.drop());

describe("A1: approval comes only from a person's own session, never from the agent's runner", () => {
  it("on_behalf_of refuses a person's bearer token; a delegation grant works once; that person cannot approve the agent's proposal", async () => {
    const id = await identity({ role: "manager", toolsets: ["pos.order"], risk_ceiling: "T2" });
    await expect(session(id.credential, { on_behalf_of: w.pins.manager })).rejects.toThrow(/validation/);
    const grant = await delegate(w.pins.manager, id.id);
    const tok = await session(id.credential, { on_behalf_of: grant });
    await expect(session(id.credential, { on_behalf_of: grant })).rejects.toThrow(/validation/);
    const [stored] = await db.sql<{ n: number }[]>`select count(*)::int as n from agent_delegations where grant_hash = ${grant.split(".")[1]!}`;
    expect(stored!.n).toBe(0); // only a hash is stored

    const o = await openTakeaway(tok);
    await addLine(tok, o.body.data.id, { product_id: w.ids.kopi });
    const p = await call<{ data: { id: string } }>("POST", `/v1/orders/${o.body.data.id}/fire`, { token: tok, body: {} });
    expect(p.status).toBe(202);
    const byPerson = await call<{ code: string }>("POST", `/v1/proposals/${p.body.data.id}/approve`, { token: w.pins.manager, body: {} });
    expect(byPerson.status).toBe(403);
    const byAgent = await call("POST", `/v1/proposals/${p.body.data.id}/approve`, { token: tok, body: {} });
    expect(byAgent.status).toBe(403);
    const byOther = await call<{ data: { status: string } }>("POST", `/v1/proposals/${p.body.data.id}/approve`, { token: w.pins.admin, body: {} });
    expect(byOther.status).toBe(200);
    expect(byOther.body.data.status).not.toBe("pending");
  });
});

describe("A13: an on_behalf_of session ends with the person's session", () => {
  it("the agent stops acting for a person once they sign out", async () => {
    const pin = (await call<{ data: { session_token: string } }>("POST", "/v1/stations/sessions", { token: w.stationToken, body: { pin: "333333" } })).body.data.session_token;
    const id = await identity({ role: "manager", toolsets: ["pos.order"], risk_ceiling: "T1" });
    const tok = await session(id.credential, { on_behalf_of: await delegate(pin, id.id) });
    expect((await openTakeaway(tok)).status).toBe(201);
    expect((await call("POST", "/v1/stations/sessions/end", { token: pin, body: {} })).status).toBeLessThan(300);
    expect((await openTakeaway(tok)).status).toBe(401);
  });
});
