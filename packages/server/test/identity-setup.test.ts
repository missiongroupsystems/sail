import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/modules.js";
import { buildApp } from "../src/app.js";
import { api, freshDb, type TestDb } from "./helpers.js";

/**
 * First-run setup: a server with no merchant offers setup, exactly once. Setup is the only unauthenticated way to
 * create an Admin, so once any merchant exists it must be refused, including when two people press it together.
 */
let db: TestDb;
let call: ReturnType<typeof api>["call"];

beforeAll(async () => {
  db = await freshDb();
  call = api(buildApp()).call;
});
afterAll(async () => db.drop());

const setupBody = (n: number, password = "a long enough password") => ({
  business_name: `Setup Test ${n}`,
  preset: "eu-vat",
  time_zone: "Europe/Berlin",
  outlet_name: `Outlet ${n}`,
  admin: { name: `First Admin ${n}`, email: `first.admin.${n}@setup.test`, password },
});
type Setup = { data: { merchant_id: string; admin_staff_id: string; session: { token: string; staff: { role: string } } | null } };

describe("first-run setup", () => {
  it("an empty server says setup is needed, and setup validates before writing anything", async () => {
    const status = await call<{ data: { provider: string; setup_required: boolean } }>("GET", "/v1/auth/status");
    expect(status.body.data).toEqual({ provider: "local", setup_required: true });
    const short = await call<{ code: string }>("POST", "/v1/setup", { body: setupBody(0, "eleven char"), idempotencyKey: null });
    expect(short.status).toBe(400);
    const badZone = await call<{ code: string }>("POST", "/v1/setup", { body: { ...setupBody(0), time_zone: "Mars/Olympus" }, idempotencyKey: null });
    expect(badZone.status).toBe(400);
    expect((await db.sql`select count(*)::int as n from merchants`)[0]!.n).toBe(0);
  });

  it("concurrent setups: exactly one succeeds, the rest are refused, and one merchant exists", async () => {
    const results = await Promise.all([1, 2, 3].map((n) => call<Setup & { code?: string }>("POST", "/v1/setup", { body: setupBody(n), idempotencyKey: null })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.code === "state_conflict")).toBe(true);
    const [m] = await db.sql<{ n: number }[]>`select count(*)::int as n from merchants`;
    expect(m!.n).toBe(1);
    const [admins] = await db.sql<{ n: number }[]>`select count(*)::int as n from staff where role = 'admin'`;
    expect(admins!.n).toBe(1);
  });

  it("the winner is signed in as the merchant's Admin, with the preset applied, an outlet and one POS station, and can sign in again", async () => {
    const [merchant] = await db.sql<{ id: string; name: string }[]>`select id, name from merchants`;
    const n = Number(merchant!.name.split(" ").pop());
    const [settings] = await db.sql<{ currency: string; timezone: string }[]>`select currency, timezone from merchant_settings where merchant_id = ${merchant!.id}`;
    expect(settings).toEqual({ currency: "EUR", timezone: "Europe/Berlin" });
    expect((await db.sql`select name from outlets where merchant_id = ${merchant!.id}`).map((o) => o.name)).toEqual([`Outlet ${n}`]);
    // One POS station and no kitchen display: a display needs a destination, which setup does not guess.
    expect((await db.sql`select kind from stations where merchant_id = ${merchant!.id}`).map((st) => st.kind)).toEqual(["pos"]);
    expect((await db.sql`select count(*)::int as n from display_destinations where merchant_id = ${merchant!.id}`)[0]!.n).toBe(0);
    // The preset's tenders, all recorded by hand: nothing is sent to a payment provider until an Admin configures one.
    const tenders = await db.sql<{ name: string; provider: string | null }[]>`select name, provider from tender_types where merchant_id = ${merchant!.id}`;
    expect(tenders.length).toBeGreaterThan(0);
    expect(tenders.filter((t) => t.provider !== null)).toEqual([]);
    expect((await db.sql`select count(*)::int as n from payment_provider_accounts where merchant_id = ${merchant!.id}`)[0]!.n).toBe(0);

    const signIn = await call<{ data: { token: string } }>("POST", "/v1/auth/sign-in", { body: { email: `First.Admin.${n}@setup.test`, password: "a long enough password" }, idempotencyKey: null });
    expect(signIn.status, JSON.stringify(signIn.body)).toBe(201);
    const me = await call<{ data: { role: string; merchant_id: string; via: string } }>("GET", "/v1/me", { token: signIn.body.data.token });
    expect(me.body.data).toMatchObject({ role: "admin", merchant_id: merchant!.id, via: "backoffice" });
  });

  it("once a merchant exists, setup is refused and the server no longer asks for it", async () => {
    const again = await call<{ code: string }>("POST", "/v1/setup", { body: setupBody(9), idempotencyKey: null });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("state_conflict");
    const status = await call<{ data: { setup_required: boolean } }>("GET", "/v1/auth/status");
    expect(status.body.data.setup_required).toBe(false);
    expect((await db.sql`select count(*)::int as n from merchants`)[0]!.n).toBe(1);
  });
});
