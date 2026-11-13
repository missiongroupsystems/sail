import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/modules.js";
import { buildApp } from "../src/app.js";
import { setLocalLogin } from "../src/auth/identity.js";
import { loadCatalog } from "../src/mcp/index.js";
import { config, loadConfig, setConfigForTests } from "../src/config.js";
import { api, backOfficeSession, freshDb, seedMerchant, TEST_SECRETS, type SeededMerchant, type TestDb } from "./helpers.js";

/**
 * Back-office sign-in with the local identity provider: email and password, sessions, lockout, invitations, reset
 * links and revocation. Each test names the rule it protects; most are about who must NOT get in.
 */
let db: TestDb;
let call: ReturnType<typeof api>["call"];
let A: SeededMerchant;
let B: SeededMerchant;
const PASSWORD = "correct horse battery";
const ip = () => `198.51.100.${Math.floor(Math.random() * 250) + 1}, 10.0.0.${Math.floor(Math.random() * 250) + 1}`;

type Session = { data: { token: string; expires_at: string; staff: { id: string; role: string } } };
type ErrorBody = { code: string; message: string; remedy?: string; details?: { retry_after_seconds?: number } };
type Link = { data: { kind: string; url: string | null; email: string; expires_at: string | null } };

const signIn = (email: string, password: string, from = ip(), c = call) => c<Session & ErrorBody>("POST", "/v1/auth/sign-in", { body: { email, password }, headers: { "x-forwarded-for": from }, idempotencyKey: null });
const me = (token: string) => call<{ data: { id: string; role: string } }>("GET", "/v1/me", { token });
const tokenOf = (url: string) => new URL(url).hash.replace(/^#token=/, "");
const accept = (token: string, password: string) => call<Session & ErrorBody>("POST", "/v1/auth/links/accept", { body: { token, password }, idempotencyKey: null });
const emailOf = async (staffId: string) => (await db.sql<{ email: string }[]>`select email from staff where id = ${staffId}`)[0]!.email;
async function givePassword(m: SeededMerchant, staffId: string, password = PASSWORD) {
  const email = await emailOf(staffId);
  await db.sql.begin((tx) => setLocalLogin(tx, { id: staffId, merchantId: m.merchantId }, email, password));
  return email;
}
async function newStaff(m: SeededMerchant, body: Record<string, unknown>) {
  const r = await call<{ data: { id: string } }>("POST", "/v1/staff", { token: m.admin.token, body: { role: "manager", ...body } });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.data.id;
}

beforeAll(async () => {
  db = await freshDb({ TRUST_PROXY: "1" });
  call = api(buildApp()).call;
  A = await seedMerchant(db.sql, "Alpha");
  B = await seedMerchant(db.sql, "Bravo");
});
afterAll(async () => db.drop());

describe("sign-in", () => {
  it("the right email and password give a working back-office session; the email is not case-sensitive", async () => {
    const email = await givePassword(A, A.manager.id);
    const r = await signIn(email.toUpperCase(), PASSWORD);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.staff).toMatchObject({ id: A.manager.id, role: "manager" });
    expect((await me(r.body.data.token)).body.data).toMatchObject({ id: A.manager.id, role: "manager" });
    // Twelve hours, the lifetime of the web app's cookie.
    const hours = (new Date(r.body.data.expires_at).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(11.9);
    expect(hours).toBeLessThanOrEqual(12);
  });

  it("an unknown email and a wrong password get the same answer, and both pay for one password comparison", async () => {
    const email = await givePassword(A, A.cashier.id);
    const wrong = await signIn(email, "not the right password");
    const unknown = await signIn(`nobody.${randomUUID()}@nowhere.test`, "not the right password");
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
    // Timing: without the comparison against a stand-in hash, an unknown email answers many times faster.
    const time = async (f: () => Promise<unknown>) => {
      const t0 = performance.now();
      await f();
      return performance.now() - t0;
    };
    const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const wrongTimes: number[] = [];
    const unknownTimes: number[] = [];
    for (let i = 0; i < 4; i++) {
      await db.sql`delete from pin_attempts`;
      wrongTimes.push(await time(() => signIn(email, `wrong password ${i}`)));
      unknownTimes.push(await time(() => signIn(`nobody.${randomUUID()}@nowhere.test`, `wrong password ${i}`)));
    }
    expect(median(unknownTimes)).toBeGreaterThan(median(wrongTimes) * 0.5);
    await db.sql`delete from pin_attempts`;
  });

  it("an inactive staff member with the right password is refused with the same answer as a wrong password", async () => {
    const id = await newStaff(A, { name: "Inactive Person", email: "inactive.person@alpha.test" });
    await givePassword(A, id);
    await call("PATCH", `/v1/staff/${id}`, { token: A.admin.token, body: { active: false } });
    const r = await signIn("inactive.person@alpha.test", PASSWORD);
    const wrong = await signIn("inactive.person@alpha.test", "something else entirely");
    expect(r.status).toBe(401);
    expect(r.body).toEqual(wrong.body);
    await db.sql`delete from pin_attempts`;
  });

  it("a password shorter than 12 characters is refused when it is set", async () => {
    const id = await newStaff(A, { name: "Short Password", email: "short.password@alpha.test" });
    const link = await call<Link>("POST", `/v1/staff/${id}/invite`, { token: A.admin.token, body: {} });
    const r = await accept(tokenOf(link.body.data.url!), "eleven char");
    expect(r.status).toBe(400);
    // The link was not spent on the refused attempt.
    expect((await accept(tokenOf(link.body.data.url!), "twelve chars")).status).toBe(201);
  });
});

describe("lockout", () => {
  it("5 failures lock the email for 15 minutes from that address only, the right password included; the owner signs in from their own address", async () => {
    const email = await givePassword(A, A.server.id);
    const attacker = "198.51.100.66";
    for (let i = 0; i < 5; i++) expect((await signIn(email, `guess number ${i}`, attacker)).status).toBe(401);
    const locked = await signIn(email, PASSWORD, attacker);
    expect(locked.status).toBe(429);
    expect(locked.body.details!.retry_after_seconds).toBeGreaterThan(14 * 60);
    // Another API process: a new app over the same database sees the same lock.
    const other = api(buildApp()).call;
    expect((await signIn(email, PASSWORD, attacker, other)).status).toBe(429);
    // Knowing someone's email no longer locks them out: from their own address the right password works.
    expect((await signIn(email, PASSWORD, "203.0.113.200")).status).toBe(201);
    // An unknown email locks exactly the same way, so the lock reveals nothing either.
    const ghost = `ghost.${randomUUID()}@nowhere.test`;
    for (let i = 0; i < 5; i++) await signIn(ghost, `guess number ${i}`, attacker);
    const ghostLocked = await signIn(ghost, PASSWORD, attacker);
    expect(ghostLocked.status).toBe(429);
    expect({ ...ghostLocked.body, details: undefined }).toEqual({ ...locked.body, details: undefined });
    await db.sql`delete from pin_attempts`;
  });

  it("guessing one email from many addresses slows down after 5 failures, and 50 lock the email and tell the merchant's Admins", async () => {
    const email = await givePassword(A, A.cashier.id);
    for (let i = 0; i < 5; i++) expect((await signIn(email, `guess ${i}`)).status).toBe(401);
    expect((await signIn(email, "guess 5")).status).toBe(401); // the 6th failure starts a 2-second pause
    const paused = await signIn(email, PASSWORD);
    expect(paused.status).toBe(429);
    expect(paused.body.details!.retry_after_seconds).toBeLessThanOrEqual(2);
    // Each further failure doubles the pause, up to 3 minutes; skip the waiting by ending each pause.
    let pause = 0;
    for (let i = 6; i < 49; i++) {
      await db.sql`update pin_attempts set locked_until = now() - interval '1 second' where scope like 'signin-email:%'`;
      expect((await signIn(email, `guess ${i}`)).status).toBe(401);
      pause = (await db.sql<{ s: number }[]>`select ceil(extract(epoch from locked_until - now()))::int as s from pin_attempts where scope like 'signin-email:%' and failures > 0`)[0]?.s ?? pause;
    }
    expect(pause).toBe(180);
    await db.sql`update pin_attempts set locked_until = now() - interval '1 second' where scope like 'signin-email:%'`;
    expect((await signIn(email, "guess 49")).status).toBe(401); // the 50th locks
    const locked = await signIn(email, PASSWORD, "203.0.113.201");
    expect(locked.status).toBe(429);
    expect(locked.body.details!.retry_after_seconds).toBeGreaterThan(14 * 60);
    const alert = await db.sql`select target_id from audit_log where action = 'auth.sign_in_locked' and merchant_id = ${A.merchantId}`;
    expect(alert.map((r) => r.target_id)).toEqual([A.cashier.id]);
    await db.sql`delete from pin_attempts`;
  });

  it("an hour without failures forgets an email's count, so old failures never add up to the cap", async () => {
    const email = await givePassword(A, A.cashier.id);
    for (let i = 0; i < 5; i++) await signIn(email, `old guess ${i}`);
    await db.sql`update pin_attempts set updated_at = now() - interval '61 minutes', locked_until = null where scope like 'signin-email:%'`;
    expect((await signIn(email, "new guess")).status).toBe(401);
    expect((await db.sql<{ failures: number }[]>`select failures from pin_attempts where scope like 'signin-email:%'`)[0]!.failures).toBe(1);
    await db.sql`delete from pin_attempts`;
  });

  it("a restaurant whose staff all sign in from one address is never locked out by its own sign-ins, or by typos weeks apart", async () => {
    const email = await givePassword(A, A.manager.id);
    const office = "203.0.113.9";
    for (let i = 0; i < 25; i++) expect((await signIn(email, PASSWORD, office)).status).toBe(201);
    // Typos spread over weeks: each one an hour or more after the last is a fresh count, as for an email.
    for (let i = 0; i < 25; i++) {
      expect((await signIn(`typo.${i}@nowhere.test`, "a typo", office)).status).toBe(401);
      await db.sql`update pin_attempts set updated_at = now() - interval '61 minutes' where scope like 'signin-%'`;
    }
    expect((await signIn(email, PASSWORD, office)).status).toBe(201);
    await db.sql`delete from pin_attempts`;
  });

  it("20 failures from one address lock that address for every email, even with the right password, and a right password does not reset it", async () => {
    const email = await givePassword(A, A.outlet2Cashier.id);
    const from = "203.0.113.7";
    for (let i = 0; i < 19; i++) await signIn(`spray.${i}@nowhere.test`, "a common password", from);
    expect((await signIn(email, PASSWORD, from)).status).toBe(201); // the 20th attempt, right but locking
    const locked = await signIn(email, PASSWORD, from);
    expect(locked.status).toBe(429);
    expect((await signIn(email, PASSWORD, from, api(buildApp()).call)).status).toBe(429);
    // Only the last entry counts (the one the proxy nearest the API wrote), so a forged earlier entry does not dodge the lock.
    expect((await signIn(email, PASSWORD, `198.51.100.1, ${from}`)).status).toBe(429);
    expect((await signIn(email, PASSWORD, "203.0.113.8")).status).toBe(201);
    await db.sql`delete from pin_attempts`;
  });
});

describe("sessions", () => {
  it("an expired session is refused; signing out ends only that session", async () => {
    const id = await newStaff(A, { name: "Two Sessions", email: "two.sessions@alpha.test" });
    const email = await givePassword(A, id);
    const one = (await signIn(email, PASSWORD)).body.data.token;
    const two = (await signIn(email, PASSWORD)).body.data.token;
    const out = await call<{ data: { ended: boolean } }>("POST", "/v1/auth/sign-out", { token: one, body: {} });
    expect(out.body.data.ended).toBe(true);
    expect((await me(one)).status).toBe(401);
    expect((await me(two)).status).toBe(200);
    await db.sql`update backoffice_sessions set expires_at = now() - interval '1 second' where staff_id = ${id} and ended_at is null`;
    expect((await me(two)).status).toBe(401);
  });

  it("a token whose session row belongs to someone else is refused (claims and row must agree)", async () => {
    const [row] = await db.sql<{ id: string }[]>`insert into backoffice_sessions (merchant_id, staff_id, expires_at) values (${B.merchantId}, ${B.admin.id}, now() + interval '1 hour') returning id`;
    const { signSailToken } = await import("../src/auth/tokens.js");
    const forged = await signSailToken({ typ: "session", merchant_id: A.merchantId, staff_id: A.admin.id, session_id: row!.id }, 3600);
    expect((await me(forged)).status).toBe(401);
  });

  it("changing your password needs the current one, ends your other sessions and keeps this one", async () => {
    const id = await newStaff(A, { name: "Changes Password", email: "changes.password@alpha.test" });
    await givePassword(A, id);
    const current = (await signIn("changes.password@alpha.test", PASSWORD)).body.data.token;
    const other = (await signIn("changes.password@alpha.test", PASSWORD)).body.data.token;
    const wrong = await call("POST", "/v1/auth/password", { token: current, body: { current_password: "not my password", new_password: "a brand new password" } });
    expect(wrong.status).toBe(400);
    const short = await call("POST", "/v1/auth/password", { token: current, body: { current_password: PASSWORD, new_password: "too short" } });
    expect(short.status).toBe(400);
    const ok = await call<{ data: { sessions_ended: number } }>("POST", "/v1/auth/password", { token: current, body: { current_password: PASSWORD, new_password: "a brand new password" } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.sessions_ended).toBe(1);
    expect((await me(current)).status).toBe(200);
    expect((await me(other)).status).toBe(401);
    expect((await signIn("changes.password@alpha.test", PASSWORD)).status).toBe(401);
    expect((await signIn("changes.password@alpha.test", "a brand new password")).status).toBe(201);
    await db.sql`delete from pin_attempts`;
  });

  it("a station PIN session cannot change a back-office password, and a session with no password login cannot set one", async () => {
    await givePassword(A, A.admin.id);
    const station = await call<{ data: { id: string } }>("POST", "/v1/stations", { token: A.admin.token, body: { outlet_id: A.outletId, brand_id: A.brandId, name: "Counter" } });
    const code = await call<{ data: { code: string } }>("POST", `/v1/stations/${station.body.data.id}/pairing-code`, { token: A.admin.token, body: {} });
    const paired = await call<{ data: { station_token: string } }>("POST", "/v1/stations/pair", { body: { code: code.body.data.code, device_label: "iPad" }, idempotencyKey: null });
    const pin = await call<{ data: { session_token: string } }>("POST", "/v1/stations/sessions", { token: paired.body.data.station_token, body: { pin: "111111" } });
    const body = { current_password: PASSWORD, new_password: "y".repeat(12) };
    expect((await call("POST", "/v1/auth/password", { token: pin.body.data.session_token, body })).status).toBe(403);
    const id = await newStaff(A, { name: "No Login Yet", email: "no.login.yet@alpha.test" });
    await db.sql`update staff set auth_subject = ${`local:${id}`} where id = ${id}`;
    expect((await call("POST", "/v1/auth/password", { token: await backOfficeSession(db.sql, A.merchantId, id), body })).status).toBe(401);
    expect((await signIn(await emailOf(A.admin.id), PASSWORD)).status).toBe(201);
  });
});

describe("review fixes", () => {
  it("changing your password cancels a reset link issued before it", async () => {
    const id = await newStaff(A, { name: "Changes After Reset", email: "changes.after.reset@alpha.test" });
    await givePassword(A, id);
    const reset = tokenOf((await call<Link>("POST", `/v1/staff/${id}/password-reset`, { token: A.admin.token, body: {} })).body.data.url!);
    const session = (await signIn("changes.after.reset@alpha.test", PASSWORD)).body.data.token;
    expect((await call("POST", "/v1/auth/password", { token: session, body: { current_password: PASSWORD, new_password: "my own new password" } })).status).toBe(200);
    expect((await accept(reset, "an attacker's password")).status).toBe(401);
    expect((await signIn("changes.after.reset@alpha.test", "my own new password")).status).toBe(201);
  });

  it("deactivating a staff member ends their sessions and links, so reactivating does not bring them back", async () => {
    const id = await newStaff(A, { name: "Away For A While", email: "away.for.a.while@alpha.test" });
    await givePassword(A, id);
    const session = (await signIn("away.for.a.while@alpha.test", PASSWORD)).body.data.token;
    const reset = tokenOf((await call<Link>("POST", `/v1/staff/${id}/password-reset`, { token: A.admin.token, body: {} })).body.data.url!);
    await call("PATCH", `/v1/staff/${id}`, { token: A.admin.token, body: { active: false } });
    await call("PATCH", `/v1/staff/${id}`, { token: A.admin.token, body: { active: true } });
    expect((await me(session)).status).toBe(401);
    expect((await accept(reset, "an old link password")).status).toBe(401);
    expect((await signIn("away.for.a.while@alpha.test", PASSWORD)).status).toBe(201);
  });

  it("an Admin's POS PIN session cannot read access or mint invite and reset links", async () => {
    const station = await call<{ data: { id: string } }>("POST", "/v1/stations", { token: A.admin.token, body: { outlet_id: A.outletId, brand_id: A.brandId, name: "Front" } });
    const code = await call<{ data: { code: string } }>("POST", `/v1/stations/${station.body.data.id}/pairing-code`, { token: A.admin.token, body: {} });
    const paired = await call<{ data: { station_token: string } }>("POST", "/v1/stations/pair", { body: { code: code.body.data.code, device_label: "iPad" }, idempotencyKey: null });
    const pin = (await call<{ data: { session_token: string } }>("POST", "/v1/stations/sessions", { token: paired.body.data.station_token, body: { pin: "111111" } })).body.data.session_token;
    const id = await newStaff(A, { name: "Pin Target", email: "pin.target@alpha.test" });
    for (const [method, path] of [["POST", `/v1/staff/${id}/invite`], ["POST", `/v1/staff/${A.admin.id}/password-reset`], ["POST", `/v1/staff/${id}/revoke-access`], ["GET", `/v1/staff/${id}/access`]] as const) {
      expect((await call(method, path, { token: pin, body: method === "GET" ? undefined : {} })).status, path).toBe(403);
    }
    expect((await db.sql`select count(*)::int as n from backoffice_links where staff_id = ${id}`)[0]!.n).toBe(0);
  });

  it("a password change leaves no hash of its body in the idempotency store", async () => {
    const id = await newStaff(A, { name: "Idempotency Check", email: "idempotency.check@alpha.test" });
    await givePassword(A, id);
    const session = (await signIn("idempotency.check@alpha.test", PASSWORD)).body.data.token;
    const key = randomUUID();
    expect((await call("POST", "/v1/auth/password", { token: session, body: { current_password: PASSWORD, new_password: "another new password" }, idempotencyKey: key })).status).toBe(200);
    expect(await db.sql`select 1 from idempotency_keys where key = ${key}`).toHaveLength(0);
    await db.sql`delete from pin_attempts`;
  });
});

describe("invitations and reset links", () => {
  it("links open the back office: WEB_APP_URL when set, otherwise the back office the request came through, never a guessed localhost", async () => {
    const id = await newStaff(A, { name: "Link Origin", email: "link.origin@alpha.test" });
    const configured = await call<Link>("POST", `/v1/staff/${id}/invite`, { token: A.admin.token, body: {} });
    expect(configured.body.data.url).toMatch(/^https:\/\/backoffice\.test\/set-password#token=/);
    const saved = config();
    setConfigForTests({ ...saved, WEB_APP_URL: undefined });
    try {
      // The web app's proxy forwards its own host, so a back office on :3232 hands out :3232 links.
      const proxied = await call<Link>("POST", `/v1/staff/${id}/invite`, { token: A.admin.token, body: {}, headers: { "x-forwarded-host": "localhost:3232", "x-forwarded-proto": "http" } });
      expect(proxied.body.data.url).toMatch(/^http:\/\/localhost:3232\/set-password#token=/);
      const unknown = await call<{ code: string; remedy: string }>("POST", `/v1/staff/${id}/invite`, { token: A.admin.token, body: {} });
      expect(unknown.status).toBe(400);
      expect(unknown.body.remedy).toMatch(/WEB_APP_URL/);
    } finally {
      setConfigForTests(saved);
    }
  });

  it("a PIN someone else at the business uses is refused with a message that says so", async () => {
    await newStaff(A, { name: "Pin Owner", pin: "135791" });
    const clash = await call<{ code: string; message: string; remedy: string }>("POST", "/v1/staff", { token: A.admin.token, body: { name: "Pin Copier", role: "server", pin: "135791" } });
    expect(clash.status).toBe(409);
    expect(clash.body).toMatchObject({ code: "state_conflict", message: "Someone at this business already uses that PIN", remedy: "Choose a different six-digit PIN." });
  });

  it("the server refuses to start in production without WEB_APP_URL", () => {
    // Production secrets strong enough for the production checks, so the refusal is the missing WEB_APP_URL's.
    const env = { NODE_ENV: "production", DATABASE_URL: "postgres://localhost:5432/sail", ...Object.fromEntries(Object.keys(TEST_SECRETS).map((k) => [k, `${k.toLowerCase()}-${"x7Qp2Lm9".repeat(5)}`])) };
    expect(() => loadConfig(env)).toThrow(/WEB_APP_URL is required in production/);
    expect(loadConfig({ ...env, WEB_APP_URL: "https://backoffice.example.com" }).WEB_APP_URL).toBe("https://backoffice.example.com");
  });

  it("an Admin invites an existing staff member who has a PIN; the link works once, keeps the PIN and signs them in", async () => {
    const id = await newStaff(A, { name: "Has A Pin", email: "Has.A.Pin@alpha.test", pin: "678901" });
    const link = await call<Link>("POST", `/v1/staff/${id}/invite`, { token: A.admin.token, body: {} });
    expect(link.status, JSON.stringify(link.body)).toBe(201);
    expect(link.body.data).toMatchObject({ kind: "link", email: "has.a.pin@alpha.test" });
    expect(link.body.data.url).toMatch(/\/set-password#token=/);
    expect((new Date(link.body.data.expires_at!).getTime() - Date.now()) / 86_400_000).toBeCloseTo(7, 1);
    const access = await call<{ data: { status: string } }>("GET", `/v1/staff/${id}/access`, { token: A.admin.token });
    expect(access.body.data.status).toBe("invited");

    const r = await accept(tokenOf(link.body.data.url!), PASSWORD);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await me(r.body.data.token)).body.data.id).toBe(id);
    expect((await accept(tokenOf(link.body.data.url!), "another password here")).status).toBe(401);
    expect((await signIn("has.a.pin@alpha.test", PASSWORD)).status).toBe(201);
    const [row] = await db.sql<{ pin_hash: string | null }[]>`select pin_hash from staff where id = ${id}`;
    expect(row!.pin_hash).not.toBeNull();
    expect((await call<{ data: { status: string } }>("GET", `/v1/staff/${id}/access`, { token: A.admin.token })).body.data.status).toBe("active");
    expect((await call("POST", `/v1/staff/${id}/invite`, { token: A.admin.token, body: {} })).status).toBe(409);
  });

  it("an invitation expires after 7 days, a newer one replaces it, and two people racing for one link cannot both use it", async () => {
    const id = await newStaff(A, { name: "New Starter", email: "new.starter@alpha.test" });
    const first = tokenOf((await call<Link>("POST", `/v1/staff/${id}/invite`, { token: A.admin.token, body: {} })).body.data.url!);
    const second = tokenOf((await call<Link>("POST", `/v1/staff/${id}/invite`, { token: A.admin.token, body: {} })).body.data.url!);
    expect((await accept(first, PASSWORD)).status).toBe(401);
    await db.sql`update backoffice_links set expires_at = now() - interval '1 second' where staff_id = ${id} and used_at is null and revoked_at is null`;
    expect((await accept(second, PASSWORD)).status).toBe(401);
    const third = tokenOf((await call<Link>("POST", `/v1/staff/${id}/invite`, { token: A.admin.token, body: {} })).body.data.url!);
    const raced = await Promise.all([accept(third, "first racer password"), accept(third, "second racer password")]);
    expect(raced.map((r) => r.status).sort()).toEqual([201, 401]);
  });

  it("an invitation needs an email that no other login on the server uses, and is not replayed by its idempotency key", async () => {
    const noEmail = await newStaff(A, { name: "No Email" });
    expect((await call("POST", `/v1/staff/${noEmail}/invite`, { token: A.admin.token, body: {} })).status).toBe(400);
    const bEmail = await givePassword(B, B.manager.id);
    const clash = await newStaff(A, { name: "Same Email Elsewhere", email: bEmail });
    expect((await call("POST", `/v1/staff/${clash}/invite`, { token: A.admin.token, body: {} })).status).toBe(409);

    const id = await newStaff(A, { name: "Replay Check", email: "replay.check@alpha.test" });
    const key = randomUUID();
    const once = await call<Link>("POST", `/v1/staff/${id}/invite`, { token: A.admin.token, body: {}, idempotencyKey: key });
    expect(once.status).toBe(201);
    const replay = await call<ErrorBody>("POST", `/v1/staff/${id}/invite`, { token: A.admin.token, body: {}, idempotencyKey: key });
    expect(replay.status).toBe(409);
    const token = tokenOf(once.body.data.url!);
    const [stored] = await db.sql<{ body: unknown }[]>`select body from idempotency_keys where key = ${key}`;
    expect(JSON.stringify(stored!.body)).not.toContain(token);
  });

  it("using a reset link ends every earlier session and replaces the old password", async () => {
    const id = await newStaff(A, { name: "Forgot Password", email: "forgot.password@alpha.test" });
    await givePassword(A, id);
    const before = (await signIn("forgot.password@alpha.test", PASSWORD)).body.data.token;
    const link = await call<Link>("POST", `/v1/staff/${id}/password-reset`, { token: A.admin.token, body: {} });
    expect(link.status, JSON.stringify(link.body)).toBe(201);
    expect((new Date(link.body.data.expires_at!).getTime() - Date.now()) / 3_600_000).toBeCloseTo(24, 0);
    expect((await me(before)).status).toBe(200);
    const after = await accept(tokenOf(link.body.data.url!), "my reset password");
    expect(after.status).toBe(201);
    expect((await me(before)).status).toBe(401);
    expect((await me(after.body.data.token)).status).toBe(200);
    expect((await signIn("forgot.password@alpha.test", PASSWORD)).status).toBe(401);
    expect((await signIn("forgot.password@alpha.test", "my reset password")).status).toBe(201);
    // Nobody without a password yet can be reset: they are invited instead.
    const fresh = await newStaff(A, { name: "Never Signed In", email: "never.signed.in@alpha.test" });
    expect((await call("POST", `/v1/staff/${fresh}/password-reset`, { token: A.admin.token, body: {} })).status).toBe(409);
    await db.sql`delete from pin_attempts`;
  });
});

describe("revoking access", () => {
  it("revoked access ends sessions, cancels open links and refuses the right password; the staff record and PIN stay", async () => {
    const id = await newStaff(A, { name: "Leaving Soon", email: "leaving.soon@alpha.test", pin: "765432" });
    await givePassword(A, id);
    const session = (await signIn("leaving.soon@alpha.test", PASSWORD)).body.data.token;
    const reset = tokenOf((await call<Link>("POST", `/v1/staff/${id}/password-reset`, { token: A.admin.token, body: {} })).body.data.url!);
    const r = await call<{ data: { status: string } }>("POST", `/v1/staff/${id}/revoke-access`, { token: A.admin.token, body: {} });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.status).toBe("none");
    expect((await me(session)).status).toBe(401);
    expect((await accept(reset, "trying to get back in")).status).toBe(401);
    const refused = await signIn("leaving.soon@alpha.test", PASSWORD);
    expect(refused.status).toBe(401);
    expect(refused.body.message).toBe("Email or password not recognised");
    const [row] = await db.sql<{ active: boolean; pin_hash: string | null; auth_subject: string | null }[]>`select active, pin_hash, auth_subject from staff where id = ${id}`;
    expect(row).toMatchObject({ active: true, auth_subject: null });
    expect(row!.pin_hash).not.toBeNull();
    await db.sql`delete from pin_attempts`;
  });

  it("an Admin cannot revoke their own access, and only Admins manage access", async () => {
    expect((await call("POST", `/v1/staff/${A.admin.id}/revoke-access`, { token: A.admin.token, body: {} })).status).toBe(422);
    for (const [method, path] of [["POST", `/v1/staff/${A.server.id}/invite`], ["POST", `/v1/staff/${A.server.id}/password-reset`], ["POST", `/v1/staff/${A.server.id}/revoke-access`], ["GET", `/v1/staff/${A.server.id}/access`]] as const) {
      expect((await call(method, path, { token: A.manager.token, body: method === "GET" ? undefined : {} })).status, path).toBe(403);
    }
  });
});

describe("tenancy", () => {
  it("an Admin of merchant B cannot invite, reset, revoke or read access for merchant A's staff", async () => {
    const id = await newStaff(A, { name: "Alpha Only", email: "alpha.only@alpha.test" });
    await givePassword(A, id);
    const before = await db.sql`select * from backoffice_logins where staff_id = ${id}`;
    for (const [method, path] of [["POST", `/v1/staff/${id}/invite`], ["POST", `/v1/staff/${id}/password-reset`], ["POST", `/v1/staff/${id}/revoke-access`], ["GET", `/v1/staff/${id}/access`]] as const) {
      expect((await call(method, path, { token: B.admin.token, body: method === "GET" ? undefined : {} })).status, path).toBe(404);
    }
    expect(await db.sql`select * from backoffice_logins where staff_id = ${id}`).toEqual(before);
    expect((await db.sql`select count(*)::int as n from backoffice_links where staff_id = ${id}`)[0]!.n).toBe(0);
    expect((await signIn("alpha.only@alpha.test", PASSWORD)).status).toBe(201);
  });
});

describe("agents and proposals never reach identity operations", () => {
  const IDENTITY_OPS = ["auth.status", "auth.sign_in", "auth.sign_out", "auth.change_password", "auth.accept_link", "setup.create", "staff.access", "staff.invite", "staff.reset_password", "staff.revoke_access"];

  it("no identity operation is open to agents or exposed over MCP", async () => {
    const doc = (await (await buildApp().request("/openapi.json")).json()) as { paths: Record<string, Record<string, { operationId: string; "x-sail": { principals: string[]; mcp: { expose: boolean } } }>> };
    const ops = Object.values(doc.paths).flatMap((m) => Object.values(m));
    const found = ops.filter((o) => IDENTITY_OPS.includes(o.operationId));
    expect(found.map((o) => o.operationId).sort()).toEqual([...IDENTITY_OPS].sort());
    for (const o of found) {
      expect(o["x-sail"].principals, o.operationId).not.toContain("agent");
      expect(o["x-sail"].principals, o.operationId).not.toContain("guest");
      expect(o["x-sail"].mcp.expose, o.operationId).toBe(false);
    }
    const tools = await loadCatalog(buildApp());
    expect(tools.filter((t) => IDENTITY_OPS.includes(t.op))).toEqual([]);
  });

  it("an Admin-role agent token is refused by every identity operation, and setup does nothing for it", async () => {
    const identity = await call<{ data: { credential: string } }>("POST", "/v1/agent-identities", { token: A.admin.token, body: { name: "Admin agent", role: "admin", toolsets: ["pos.read", "reports"], risk_ceiling: "T2" } });
    expect(identity.status, JSON.stringify(identity.body)).toBe(201);
    const session = await call<{ data: { agent_token: string } }>("POST", "/v1/agent-sessions", { body: { credential: identity.body.data.credential, task_id: "t" }, idempotencyKey: null });
    const agent = session.body.data.agent_token;
    for (const [method, path] of [
      ["POST", `/v1/staff/${A.server.id}/invite`],
      ["POST", `/v1/staff/${A.server.id}/password-reset`],
      ["POST", `/v1/staff/${A.server.id}/revoke-access`],
      ["GET", `/v1/staff/${A.server.id}/access`],
      ["POST", "/v1/auth/sign-out"],
      ["POST", "/v1/auth/password"],
    ] as const) {
      const r = await call<ErrorBody>(method, path, { token: agent, body: method === "GET" ? undefined : { current_password: "x".repeat(12), new_password: "y".repeat(12) } });
      expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBe(403);
    }
    expect((await db.sql`select count(*)::int as n from backoffice_links where staff_id = ${A.server.id}`)[0]!.n).toBe(0);
    expect((await db.sql`select count(*)::int as n from proposals`)[0]!.n).toBe(0);
    const merchants = (await db.sql`select count(*)::int as n from merchants`)[0]!.n;
    const setup = await call("POST", "/v1/setup", { token: agent, body: { business_name: "Agent Co", preset: "sg", time_zone: "Asia/Singapore", outlet_name: "O", admin: { name: "Agent Admin", email: "agent.admin@agent.test", password: "an agent password" } }, idempotencyKey: null });
    expect(setup.status).toBe(409);
    expect((await db.sql`select count(*)::int as n from merchants`)[0]!.n).toBe(merchants);
  });

  it("a staff member above their risk ceiling is refused, never given a proposal that would store the link", async () => {
    await db.sql`update staff set risk_ceiling = 'T1' where id = ${A.admin.id}`;
    try {
      const r = await call<ErrorBody>("POST", `/v1/staff/${A.server.id}/invite`, { token: A.admin.token, body: {} });
      expect(r.status).toBe(403);
      expect((await db.sql`select count(*)::int as n from proposals`)[0]!.n).toBe(0);
    } finally {
      await db.sql`update staff set risk_ceiling = null where id = ${A.admin.id}`;
    }
  });

  it("agent, guest and relay database roles cannot read logins, sessions or links at all", async () => {
    for (const role of ["app_agent", "app_guest", "app_relay"]) {
      for (const t of ["backoffice_logins", "backoffice_sessions", "backoffice_links"]) {
        const [priv] = await db.sql<{ any: boolean }[]>`select has_any_column_privilege(${role}, ${t}::regclass, 'SELECT') as any`;
        expect(priv!.any, `${role} on ${t}`).toBe(false);
      }
    }
    const [hash] = await db.sql<{ ok: boolean }[]>`select has_column_privilege('app_authenticated', 'backoffice_logins', 'password_hash', 'SELECT') as ok`;
    expect(hash!.ok).toBe(false);
  });
});
